import Ajv, { type ErrorObject } from "ajv";

/**
 * JSON Schemas used to validate ALL user-editable input BEFORE it is sent to
 * the model. This prevents malformed or malicious payloads (e.g. prompt
 * injection via oversized/oddly-shaped JSON) from ever reaching the endpoint.
 */

export const boardStateSchema = {
  $id: "board-state",
  type: "object" as const,
  required: ["board"],
  additionalProperties: false,
  properties: {
    board: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "array",
        minItems: 3,
        maxItems: 3,
        items: {
          type: "string",
          enum: ["X", "O", "."],
        },
      },
    },
  },
} as const;

export const instructionSchema = {
  $id: "instruction",
  type: "object" as const,
  required: ["game"],
  additionalProperties: false,
  properties: {
    game: {
      type: "object",
      required: ["type", "instructions", "criteria"],
      additionalProperties: false,
      properties: {
        type: { type: "string", enum: ["choice", "score", "noul"] },
        instructions: { type: "string", minLength: 1, maxLength: 4000 },
        criteria: {
          oneOf: [
            {
              type: "object",
              minProperties: 1,
              maxProperties: 50,
              propertyNames: { pattern: "^[A-Za-z0-9_-]{1,32}$" },
              additionalProperties: { type: "string", maxLength: 200 },
            },
            {
              type: "array",
              minItems: 1,
              maxItems: 50,
              items: { type: "string", minLength: 1, maxLength: 200 },
            },
          ],
        },
      },
    },
  },
} as const;

/** Final payload guard: what actually leaves the browser. Accepts exactly one
 *  of the two wire formats — Decisions/System One ({model,state,questions}) or
 *  OpenAI chat ({model,messages}). */
export const requestPayloadSchema = {
  $id: "request-payload",
  type: "object" as const,
  required: ["model"],
  properties: {
    model: { type: "string", minLength: 1, maxLength: 200 },
  },
  oneOf: [
    {
      // Decisions API / System One API (Jev)
      required: ["state", "questions"],
      additionalProperties: false,
      properties: {
        model: { type: "string", minLength: 1, maxLength: 200 },
        state: boardStateSchema,
        questions: instructionSchema,
      },
    },
    {
      // OpenAI-compatible chat completions (local LLM fallback)
      required: ["messages"],
      additionalProperties: false,
      properties: {
        model: { type: "string", minLength: 1, maxLength: 200 },
        messages: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: {
            type: "object",
            required: ["role", "content"],
            additionalProperties: false,
            properties: {
              role: { type: "string", enum: ["system", "user"] },
              content: { type: "string", minLength: 1, maxLength: 100_000 },
            },
          },
        },
      },
    },
  ],
} as const;

const ajv = new Ajv({ allErrors: true, strict: false });

export const validateBoardState = ajv.compile(boardStateSchema);
export const validateInstruction = ajv.compile(instructionSchema);
export const validateRequestPayload = ajv.compile(requestPayloadSchema);

export interface ValidationIssue {
  path: string;
  message: string;
}

export function formatErrors(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  if (!errors) return [];
  return errors.map((e) => ({
    path: e.instancePath || "(root)",
    message: e.message ?? "invalid",
  }));
}

/** Parse a JSON string, returning either the value or a syntax error. */
export function parseJsonSafe(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Invalid JSON" };
  }
}
