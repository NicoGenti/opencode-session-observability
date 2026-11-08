import { Rpc } from "@opencode/plugin/rpc";

const stringArray = {
  type: "array",
  items: { type: "string" },
} as const;

const looseObject = {
  type: "object",
  additionalProperties: true,
} as const;

const emptyInput = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

export const Observability = Rpc.define({
  id: "session-observability",
  methods: {
    health: {
      input: emptyInput,
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          version: { type: "string" },
          source: { type: "string" },
          revealAllowed: { type: "boolean" },
          readOnly: { type: "boolean" },
        },
        required: ["ok", "version", "source", "revealAllowed", "readOnly"],
        additionalProperties: false,
      },
    },
    sessions: {
      input: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" },
          reveal: { type: "boolean" },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          sessions: { type: "array", items: looseObject },
          revealAllowed: { type: "boolean" },
        },
        required: ["sessions", "revealAllowed"],
        additionalProperties: false,
      },
    },
    session: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          reveal: { type: "boolean" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          session: looseObject,
          family: looseObject,
          revealAllowed: { type: "boolean" },
        },
        required: ["session", "family", "revealAllowed"],
        additionalProperties: false,
      },
    },
    analysis: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          fromSeq: { type: "number" },
          toSeq: { type: "number" },
          reveal: { type: "boolean" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          analysis: looseObject,
          revealAllowed: { type: "boolean" },
        },
        required: ["analysis", "revealAllowed"],
        additionalProperties: false,
      },
    },
    eventPage: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          q: { type: "string" },
          kinds: stringArray,
          agents: stringArray,
          models: stringArray,
          providers: stringArray,
          tools: stringArray,
          statuses: stringArray,
          errorsOnly: { type: "boolean" },
          retriesOnly: { type: "boolean" },
          compactionsOnly: { type: "boolean" },
          subagentsOnly: { type: "boolean" },
          contextOnly: { type: "boolean" },
          from: { type: "number" },
          to: { type: "number" },
          minPromptTokens: { type: "number" },
          maxPromptTokens: { type: "number" },
          limit: { type: "number" },
          before: { type: "string" },
          after: { type: "string" },
          around: { type: "string" },
          direction: { type: "string", enum: ["forward", "backward"] },
          reveal: { type: "boolean" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          events: { type: "array", items: looseObject },
          page: looseObject,
          coverage: looseObject,
          capabilities: looseObject,
          redacted: { type: "boolean" },
          revealAllowed: { type: "boolean" },
        },
        required: [
          "events",
          "page",
          "coverage",
          "capabilities",
          "redacted",
          "revealAllowed",
        ],
        additionalProperties: false,
      },
    },
    event: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          eventID: { type: "string" },
          reveal: { type: "boolean" },
        },
        required: ["sessionID", "eventID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          event: looseObject,
          revealAllowed: { type: "boolean" },
        },
        required: ["event", "revealAllowed"],
        additionalProperties: false,
      },
    },
    export: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          format: { type: "string", enum: ["json", "markdown", "html"] },
          includeEvents: { type: "boolean" },
          reveal: { type: "boolean" },
        },
        required: ["sessionID", "format"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          filename: { type: "string" },
          mime: { type: "string" },
          content: { type: "string" },
          redacted: { type: "boolean" },
        },
        required: ["filename", "mime", "content", "redacted"],
        additionalProperties: false,
      },
    },
  },
  events: {},
});
