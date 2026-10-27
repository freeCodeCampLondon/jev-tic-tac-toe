import type { ResolvedEndpoint } from "./settings";
import {
  formatErrors,
  parseJsonSafe,
  validateBoardState,
  validateInstruction,
  validateRequestPayload,
  type ValidationIssue,
} from "./schemas";

/** The shape we ask the model to return (mirrors TypeSafe's System One API). */
export interface JevChoiceAnswer {
  questionName: string;
  choice: string | null;
  confidence: number | null; // 0..1
  probabilities: Record<string, number>; // criterion -> 0..1
}

export interface JevRunResult {
  ok: boolean;
  answer?: JevChoiceAnswer;
  error?: string;
  rawContent: string;
  model?: string;
  provider?: string;
  latencyMs?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cost?: number };
}

const SYSTEM_PROMPT = [
  "You are Jev, a System One decision model. You evaluate typed questions against a state.",
  'The user message is JSON: {"state": <...>, "questions": <...>}.',
  'For every question in "questions", produce an answer keyed by the question name.',
  'A question of type "choice" returns: {"type":"choice","choice":<one criterion key>,"confidence":<number 0-1>,"probabilities":{<each criterion key>:<number 0-1 summing to ~1>}}.',
  "Return ONLY a single JSON object of the form {\"answers\": {...}}. No prose, no markdown, no code fences.",
].join(" ");

export interface BuildInput {
  stateText: string;
  instructionText: string;
  endpoint: ResolvedEndpoint;
}

export interface BuiltRequest {
  payload: unknown; // validated, ready to send
  protocol: "decisions" | "chat";
  questionName: string;
  criteriaKeys: string[];
}

/**
 * Parse + schema-validate user input and build the exact request that will be
 * sent. Nothing is sent unless every check passes — this is the guard against
 * malformed or malicious input.
 *
 * - Decisions API (Jev): { model, state, questions } — the Questions editor is
 *   the questions object, the State editor is the state.
 * - Chat completions (local LLM): messages wrapping the same JSON.
 */
export function buildRequest(input: BuildInput): { ok: true; built: BuiltRequest } | { ok: false; issues: ValidationIssue[] } {
  const stateParsed = parseJsonSafe(input.stateText);
  if (!stateParsed.ok) return { ok: false, issues: [{ path: "state", message: `Invalid JSON: ${stateParsed.error}` }] };

  const instrParsed = parseJsonSafe(input.instructionText);
  if (!instrParsed.ok) return { ok: false, issues: [{ path: "questions", message: `Invalid JSON: ${instrParsed.error}` }] };

  const stateIssues = formatErrors(validateBoardState(stateParsed.value) ? null : validateBoardState.errors);
  if (stateIssues.length) {
    return { ok: false, issues: stateIssues.map((i) => ({ path: `state${i.path}`, message: i.message })) };
  }

  const instrIssues = formatErrors(validateInstruction(instrParsed.value) ? null : validateInstruction.errors);
  if (instrIssues.length) {
    return { ok: false, issues: instrIssues.map((i) => ({ path: `questions${i.path}`, message: i.message })) };
  }

  const game = (instrParsed.value as { game: { type: string; criteria: Record<string, string> | string[] } }).game;
  if (game.type !== "choice") {
    return { ok: false, issues: [{ path: "questions.game.type", message: 'This demo supports question type "choice" only' }] };
  }

  const criteriaKeys = Array.isArray(game.criteria) ? game.criteria.map(String) : Object.keys(game.criteria);
  if (criteriaKeys.length === 0) {
    return { ok: false, issues: [{ path: "questions.game.criteria", message: "At least one criterion is required" }] };
  }

  const questionName = "game";
  const protocol = input.endpoint.protocol;

  let payload: unknown;
  if (protocol === "decisions") {
    // The Decisions / System One API takes state + questions directly.
    payload = {
      model: input.endpoint.modelId,
      state: stateParsed.value,
      questions: instrParsed.value,
    };
  } else {
    payload = {
      model: input.endpoint.modelId,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify({ state: stateParsed.value, questions: instrParsed.value }, null, 2) },
      ],
    };
  }

  const payloadIssues = formatErrors(validateRequestPayload(payload) ? null : validateRequestPayload.errors);
  if (payloadIssues.length) return { ok: false, issues: payloadIssues.map((i) => ({ path: `request${i.path}`, message: i.message })) };

  return { ok: true, built: { payload, protocol, questionName, criteriaKeys } };
}

/** Extract the first balanced JSON object from a string (skips prose/fences). */
function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        const parsed = parseJsonSafe(candidate);
        return parsed.ok ? parsed.value : null;
      }
    }
  }
  return null;
}

function toProbMap(value: unknown, criteriaKeys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of criteriaKeys) {
      const v = (value as Record<string, unknown>)[key];
      if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
    }
  }
  return out;
}

/**
 * Parse a model response into a normalized choice answer.
 * Tolerant of: TypeSafe-native shape ({answers:{game:{...}}}), direct shape
 * ({choice, probabilities, confidence}), markdown fences, and prose wrappers.
 */
export function parseJevAnswer(rawContent: string, questionName: string, criteriaKeys: string[]): JevChoiceAnswer | null {
  let obj = extractJsonObject(rawContent);
  if (obj === null) return null;

  // Unwrap TypeSafe-native or nested shapes.
  let answerObj: Record<string, unknown> | null = null;
  const root = obj as Record<string, unknown>;
  if (root && typeof root === "object") {
    const answers = root.answers;
    if (answers && typeof answers === "object") {
      const a = (answers as Record<string, unknown>)[questionName];
      if (a && typeof a === "object") answerObj = a as Record<string, unknown>;
    }
    if (!answerObj && root[questionName] && typeof root[questionName] === "object") {
      answerObj = root[questionName] as Record<string, unknown>;
    }
    if (!answerObj && (root.choice !== undefined || root.probabilities !== undefined)) {
      answerObj = root;
    }
  }
  if (!answerObj) return null;

  const probabilities = toProbMap(answerObj.probabilities, criteriaKeys);
  if (Object.keys(probabilities).length === 0 && answerObj.choice === undefined) return null;

  // Normalize: percentages (e.g. 57 meaning 57%) -> fractions.
  const maxP = Math.max(...Object.values(probabilities), 0);
  const scale = maxP > 1 ? 100 : 1;
  for (const k of Object.keys(probabilities)) probabilities[k] = probabilities[k] / scale;

  let choice: string | null = null;
  if (typeof answerObj.choice === "string" && criteriaKeys.includes(answerObj.choice)) {
    choice = answerObj.choice;
  } else if (Object.keys(probabilities).length > 0) {
    choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
  }

  let confidence: number | null = null;
  const c = answerObj.confidence ?? answerObj.confidenceScore;
  if (typeof c === "number" && Number.isFinite(c)) {
    confidence = c > 1 ? c / 100 : c;
  } else if (choice !== null && probabilities[choice] !== undefined) {
    confidence = probabilities[choice];
  }

  return { questionName, choice, confidence, probabilities };
}

/** Send the validated payload to the resolved endpoint. The request carries
 *  ONLY that endpoint's own credentials — local keys never go to the server
 *  endpoint and vice versa. */
export async function runJevRequest(
  built: BuiltRequest,
  endpoint: ResolvedEndpoint,
  signal?: AbortSignal,
): Promise<JevRunResult> {
  const started = performance.now();

  // Vendor-specific headers go only to their own host — an OpenRouter
  // attribution header would break CORS preflight on strict local servers.
  let isOpenRouter = false;
  try {
    isOpenRouter = /openrouter\.ai$/i.test(new URL(endpoint.url).hostname);
  } catch {
    /* malformed URL — fetch will report it */
  }

  let res: Response;
  try {
    res = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
        ...(isOpenRouter ? { "X-Title": "Jev Tic-Tac-Toe Classroom Demo" } : {}),
      },
      body: JSON.stringify(built.payload),
      signal,
    });
  } catch (e) {
    const base = e instanceof Error ? `Network error: ${e.message}` : "Network error";
    // Browsers surface CORS rejections as a plain fetch failure — point at the fix.
    const corsHint =
      endpoint.mode === "local"
        ? " If your local server is running, this is usually a CORS issue: allow this page's origin on the server (Ollama: OLLAMA_ORIGINS=* or add your origin; LM Studio: enable CORS in server settings)."
        : "";
    return { ok: false, rawContent: "", error: base + corsHint };
  }

  const latencyMs = Math.round(performance.now() - started);
  const text = await res.text();

  if (!res.ok) {
    let detail = text;
    const parsed = parseJsonSafe(text);
    if (parsed.ok && parsed.value && typeof parsed.value === "object") {
      const v = parsed.value as Record<string, unknown>;
      if (typeof v.error === "string") detail = v.error;
      else if (v.error && typeof v.error === "object") {
        const err = v.error as Record<string, unknown>;
        detail = typeof err.message === "string" ? `${err.code ?? ""} ${err.message}`.trim() : JSON.stringify(err).slice(0, 500);
      } else {
        detail = JSON.stringify(v, null, 2).slice(0, 500);
      }
    }
    return { ok: false, rawContent: text, latencyMs, error: `HTTP ${res.status}: ${detail.slice(0, 400)}` };
  }

  const parsedBody = parseJsonSafe(text);
  let model: string | undefined;
  let provider: string | undefined;
  let usage: JevRunResult["usage"];
  let content = "";

  if (parsedBody.ok && parsedBody.value && typeof parsedBody.value === "object") {
    const body = parsedBody.value as Record<string, unknown>;
    model = typeof body.model === "string" ? body.model : undefined;
    provider = typeof body.provider === "string" ? body.provider : undefined;
    if (body.usage && typeof body.usage === "object") {
      const u = body.usage as Record<string, unknown>;
      usage = {
        input_tokens: typeof u.input_tokens === "number" ? u.input_tokens : undefined,
        output_tokens: typeof u.output_tokens === "number" ? u.output_tokens : undefined,
        cost: typeof u.cost === "number" ? u.cost : undefined,
      };
    }

    if (built.protocol === "decisions") {
      // Decisions / System One API: structured body with answers at top level.
      content = text;
    } else {
      // OpenAI chat completions: answer is text inside choices[0].message.content.
      const choices = body.choices;
      if (Array.isArray(choices) && choices.length > 0) {
        const first = choices[0] as Record<string, unknown>;
        const msg = first.message as Record<string, unknown> | undefined;
        content = typeof msg?.content === "string" ? msg.content : "";
        if (!content && typeof first.text === "string") content = first.text;
      }
    }
  }
  if (!content) content = text;

  const answer = parseJevAnswer(content, built.questionName, built.criteriaKeys);
  if (!answer) {
    return {
      ok: false,
      rawContent: content,
      model,
      provider,
      latencyMs,
      usage,
      error: "Could not parse a structured decision from the model response. Check the raw output below.",
    };
  }

  return { ok: true, answer, rawContent: content, model, provider, latencyMs, usage };
}
