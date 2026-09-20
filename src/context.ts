import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ToolGuardConfig } from "./config.ts";

export type JsonSafe =
  | string
  | number
  | boolean
  | null
  | JsonSafe[]
  | { [key: string]: JsonSafe };

export interface GuardConversationMessage {
  role: "user" | "assistant" | "toolResult" | "summary";
  text: string;
}

export interface GuardContext {
  cwd: string;
  sessionManager: {
    buildContextEntries(): SessionEntry[];
  };
}

export interface GuardState {
  cwd: string;
  userObjective: string;
  recentConversation: GuardConversationMessage[];
  pendingTool: {
    name: string;
    input: string;
    truncated: boolean;
  };
}

const SECRET_KEY =
  /(api[-_]?key|token|secret|password|passwd|authorization|credential|private[-_]?key|access[-_]?key)/i;
const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY]",
  ],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
  [/\bgh[opusr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bnpm_[A-Za-z0-9]{20,}\b/g, "[REDACTED_NPM_TOKEN]"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]"],
  [/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@"],
  [
    /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*([^\s'"]+|'[^']*'|"[^"]*")/g,
    "$1=[REDACTED]",
  ],
  [
    /("(?:api[-_]?key|token|secret|password|authorization|credential|private[-_]?key)"\s*:\s*)"[^"]*"/gi,
    '$1"[REDACTED]"',
  ],
];

export function buildGuardState(options: {
  ctx: GuardContext;
  toolName: string;
  input: unknown;
  config: ToolGuardConfig["context"];
}): GuardState {
  const conversation = options.ctx.sessionManager
    .buildContextEntries()
    .flatMap(entryToGuardMessages)
    .filter(
      (message) =>
        options.config.includeToolResults || message.role !== "toolResult",
    )
    .slice(-options.config.recentMessages);
  const sanitizedConversation = options.config.redactSecrets
    ? conversation.map((message) => ({
        ...message,
        text: redactString(message.text),
      }))
    : conversation;
  const userObjective =
    [...sanitizedConversation]
      .reverse()
      .find((message) => message.role === "user")?.text ?? "";
  const inputValue = options.config.redactSecrets
    ? redactSecrets(options.input)
    : toJsonSafe(options.input);
  const state: GuardState = {
    cwd: options.config.redactSecrets
      ? redactString(options.ctx.cwd)
      : options.ctx.cwd,
    userObjective,
    recentConversation: sanitizedConversation,
    pendingTool: {
      name: options.toolName,
      input: stableStringify(inputValue),
      truncated: false,
    },
  };
  return fitState(state, options.config.maxCharacters);
}

export function redactSecrets(value: unknown): JsonSafe {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!isRecord(value)) return toJsonSafe(value);

  const result: { [key: string]: JsonSafe } = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redactSecrets(child);
  }
  return result;
}

function entryToGuardMessages(entry: SessionEntry): GuardConversationMessage[] {
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return [{ role: "summary", text: entry.summary }];
  }
  if (entry.type === "custom_message") {
    return entry.display
      ? [{ role: "assistant", text: contentText(entry.content) }]
      : [];
  }
  if (entry.type !== "message") return [];

  const message = entry.message;
  if (message.role === "user")
    return [{ role: "user", text: contentText(message.content) }];
  if (message.role === "assistant")
    return [{ role: "assistant", text: contentText(message.content) }];
  if (message.role === "toolResult")
    return [{ role: "toolResult", text: contentText(message.content) }];
  if (
    message.role === "branchSummary" ||
    message.role === "compactionSummary"
  ) {
    return [{ role: "summary", text: message.summary }];
  }
  if (message.role === "custom" && message.display) {
    return [{ role: "assistant", text: contentText(message.content) }];
  }
  return [];
}

function redactString(value: string): string {
  let redacted = value;
  for (const [pattern, replacement] of SECRET_PATTERNS)
    redacted = redacted.replace(pattern, replacement);
  return redacted;
}

function contentText(content: string | ReadonlyArray<unknown>): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (!isRecord(part)) return "";
      if (part.type === "text" && typeof part.text === "string")
        return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function fitState(state: GuardState, maxCharacters: number): GuardState {
  const fitted: GuardState = {
    ...state,
    recentConversation: state.recentConversation.map((message) => ({
      ...message,
    })),
    pendingTool: { ...state.pendingTool },
  };
  while (
    fitted.recentConversation.length > 1 &&
    serializedLength(fitted) > maxCharacters
  ) {
    fitted.recentConversation.shift();
  }
  if (serializedLength(fitted) <= maxCharacters) return fitted;

  fitted.pendingTool.truncated = true;
  const withoutInput = serializedLength({
    ...fitted,
    pendingTool: { ...fitted.pendingTool, input: "" },
  });
  fitted.pendingTool.input = truncateMiddle(
    fitted.pendingTool.input,
    Math.max(0, maxCharacters - withoutInput),
  );

  while (
    fitted.recentConversation.length > 0 &&
    serializedLength(fitted) > maxCharacters
  ) {
    fitted.recentConversation.shift();
  }
  if (serializedLength(fitted) <= maxCharacters) return fitted;

  const withoutObjective = serializedLength({ ...fitted, userObjective: "" });
  fitted.userObjective = truncateMiddle(
    fitted.userObjective,
    Math.max(0, maxCharacters - withoutObjective),
  );
  if (serializedLength(fitted) <= maxCharacters) return fitted;

  const withoutCwd = serializedLength({ ...fitted, cwd: "" });
  fitted.cwd = truncateMiddle(
    fitted.cwd,
    Math.max(0, maxCharacters - withoutCwd),
  );
  return fitted;
}

function truncateMiddle(value: string, limit: number): string {
  if (value.length <= limit) return value;
  if (limit <= 0) return "";
  const marker = "\n...[TRUNCATED]...\n";
  if (limit <= marker.length + 2) return value.slice(0, limit);
  const startLength = Math.ceil((limit - marker.length) / 2);
  const endLength = Math.floor((limit - marker.length) / 2);
  return `${value.slice(0, startLength)}${marker}${value.slice(-endLength)}`;
}

function serializedLength(value: unknown): number {
  return stableStringify(value).length;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) => {
    if (!isRecord(child)) return child;
    return Object.fromEntries(
      Object.entries(child).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
  });
}

function toJsonSafe(value: unknown): JsonSafe {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, toJsonSafe(child)]),
    );
  }
  return value === undefined ? null : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
