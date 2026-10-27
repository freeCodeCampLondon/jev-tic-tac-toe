/**
 * Endpoint configuration. Two sources, deliberately kept separate:
 *
 *  - SERVER endpoint ("classroom Jev"): proxied by the game server at
 *    /api/jev. The API key lives only in the server process's environment
 *    (.env file or platform env vars) and is NEVER shipped to the browser.
 *
 *  - LOCAL endpoint: entered by the user in the settings panel, stored only
 *    in this browser's localStorage. Used when the checkbox is ON; requests
 *    and any local credentials go ONLY to that endpoint — never to the
 *    server endpoint or anywhere else.
 */

export type Protocol = "decisions" | "chat";

/** The classroom Jev endpoint, proxied by the game server (server/index.mjs).
 *  Relative URL → same origin. `modelId` is a placeholder: the proxy replaces
 *  it with the real model id and adds the API key on the server side, so no
 *  credential ever reaches this browser. */
export const SERVER_ENDPOINT = {
  url: "/api/jev",
  apiKey: "",
  modelId: "classroom-jev", // placeholder — the server substitutes the real model id
};

/** Derive the wire protocol from the API path: decision surfaces speak
 *  {model, state, questions}; everything else is treated as OpenAI chat. */
export function protocolForPath(apiPath: string): Protocol {
  return /decisions|systemone/i.test(apiPath) ? "decisions" : "chat";
}

/** Local (self-hosted / private) endpoint — user-entered, localStorage only. */
export interface LocalEndpointSettings {
  baseUrl: string;   // e.g. http://localhost:11434/v1 or https://example.com/v1
  apiPath: string;   // e.g. /chat/completions or /alpha/decisions
  apiKey: string;    // may be empty for local servers that need no auth
  modelId: string;
  presetName: string;
}

export interface AppSettings {
  useLocal: boolean;
  local: LocalEndpointSettings;
}

export const DEFAULT_LOCAL: LocalEndpointSettings = {
  baseUrl: "http://localhost:11434/v1",
  apiPath: "/systemone",
  apiKey: "",
  modelId: "nimble",
  presetName: "Ollama — nimble (local decision model)",
};

export const DEFAULT_SETTINGS: AppSettings = {
  useLocal: false,
  local: DEFAULT_LOCAL,
};

export interface Preset {
  name: string;
  baseUrl: string;
  apiPath: string;
  modelId: string;
}

/** Presets for the LOCAL endpoint only — privacy/self-hosted decision models.
 *  Both Ollama (≥0.35) and LM Studio expose TypeSafe's System One API at
 *  /v1/systemone with the same {model, state, questions} shape as OpenRouter. */
export const LOCAL_PRESETS: Preset[] = [
  {
    name: "Ollama — nimble (local decision model)",
    baseUrl: "http://localhost:11434/v1",
    apiPath: "/systemone",
    modelId: "nimble",
  },
  {
    name: "LM Studio (local decision model)",
    baseUrl: "http://localhost:1234/v1",
    apiPath: "/systemone",
    modelId: "nimble",
  },
];

const STORAGE_KEY = "jev-ttt-settings-v3";

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const local = (parsed.local ?? {}) as Partial<LocalEndpointSettings>;
    return {
      useLocal: !!parsed.useLocal,
      local: {
        baseUrl: typeof local.baseUrl === "string" && local.baseUrl.startsWith("http") ? local.baseUrl : DEFAULT_LOCAL.baseUrl,
        apiPath: typeof local.apiPath === "string" && local.apiPath.startsWith("/") ? local.apiPath : DEFAULT_LOCAL.apiPath,
        apiKey: typeof local.apiKey === "string" ? local.apiKey : "",
        modelId: typeof local.modelId === "string" && local.modelId ? local.modelId : DEFAULT_LOCAL.modelId,
        presetName: typeof local.presetName === "string" ? local.presetName : DEFAULT_LOCAL.presetName,
      },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: AppSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable — ignore */
  }
}

/** Basic client-side sanity checks on the local endpoint config. */
export function validateLocalEndpoint(l: LocalEndpointSettings): string[] {
  const problems: string[] = [];
  try {
    const u = new URL(l.baseUrl);
    if (!["http:", "https:"].includes(u.protocol)) problems.push("Base URL must be http or https");
  } catch {
    problems.push("Base URL is not a valid URL");
  }
  if (!l.apiPath.startsWith("/")) problems.push("API path must start with / (e.g. /chat/completions)");
  if (!l.modelId.trim()) problems.push("Model id is required");
  if (l.modelId.length > 200) problems.push("Model id too long");
  return problems;
}

/** The endpoint the next request will actually use. Credentials from the two
 *  sources are never mixed: a local request carries only the local key, a
 *  server request carries only the env key. */
export interface ResolvedEndpoint {
  mode: "server" | "local";
  url: string; // full request URL
  apiKey: string; // may be "" for unauthenticated local servers
  modelId: string;
  protocol: Protocol;
}

export function resolveEndpoint(s: AppSettings): ResolvedEndpoint {
  if (s.useLocal) {
    return {
      mode: "local",
      url: s.local.baseUrl.replace(/\/+$/, "") + s.local.apiPath,
      apiKey: s.local.apiKey.trim(),
      modelId: s.local.modelId.trim(),
      protocol: protocolForPath(s.local.apiPath),
    };
  }
  return {
    mode: "server",
    url: SERVER_ENDPOINT.url,
    apiKey: SERVER_ENDPOINT.apiKey,
    modelId: SERVER_ENDPOINT.modelId,
    protocol: "decisions",
  };
}

/** Problems that would block a request for the currently selected mode. */
export function endpointProblems(s: AppSettings): string[] {
  // Server mode needs no client-side configuration — the game server holds
  // the key. If the proxy isn't configured, the request itself fails with a
  // clear message from the server (503).
  return s.useLocal ? validateLocalEndpoint(s.local) : [];
}


