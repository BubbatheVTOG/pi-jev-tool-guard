import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export const PROTECTED_TOOLS = ["bash", "write", "edit"] as const;
export type ProtectedTool = (typeof PROTECTED_TOOLS)[number];
export type EvaluatorFailure = "allow" | "block";
export type HeadlessRisk = "allow" | "block";
export type ProjectOverrides = "full" | "none";
export type ConfigSource = "default" | "global" | "project" | "derived";

export interface ResolvedThresholds {
  reviewProbability: number;
  highRiskProbability: number;
  severityReview: number;
}

export interface ToolGuardConfig {
  disable: boolean;
  enabled: boolean;
  protectedTools: ProtectedTool[];
  model: string;
  timeoutMs: number;
  evaluatorFailure: EvaluatorFailure;
  headlessRisk: HeadlessRisk;
  /** 1-10 review threshold; higher values flag more tool calls. */
  threshold: number;
  /**
   * Per-tool threshold on the same 1-10 scale. An entry replaces the base
   * `threshold` for that tool. Tools without an entry fall back to the base
   * value plus the built-in per-tool boost (BUILTIN_TOOL_THRESHOLD_BOOST).
   */
  toolThresholds: Partial<Record<ProtectedTool, number>>;
  /** Review thresholds derived from `threshold`; never set directly. */
  thresholds: ResolvedThresholds;
  context: {
    recentMessages: number;
    maxCharacters: number;
    redactSecrets: boolean;
    includeToolResults: boolean;
  };
  rules: {
    protectedPaths: string[];
    allowedPaths: string[];
    alwaysConfirmCommands: string[];
    allowedCommands: string[];
    /** Bash commands matching these (substring) are blocked outright. */
    denyCommands: string[];
  };
  notifications: {
    showAllowed: boolean;
    showEvaluatorFailures: boolean;
    showProjectOverride: boolean;
  };
  projectOverrides: ProjectOverrides;
}

export interface ToolGuardOverride {
  disable?: boolean;
  enabled?: boolean;
  protectedTools?: ProtectedTool[];
  model?: string;
  timeoutMs?: number;
  evaluatorFailure?: EvaluatorFailure;
  headlessRisk?: HeadlessRisk;
  threshold?: number;
  toolThresholds?: Partial<Record<ProtectedTool, number>>;
  context?: Partial<ToolGuardConfig["context"]>;
  rules?: Partial<ToolGuardConfig["rules"]>;
  notifications?: Partial<ToolGuardConfig["notifications"]>;
  projectOverrides?: ProjectOverrides;
}

export interface ResolvedToolGuardConfig {
  config: ToolGuardConfig;
  provenance: Record<string, ConfigSource>;
  projectOverrideApplied: boolean;
}

export const MIN_THRESHOLD = 1;
export const MAX_THRESHOLD = 10;
export const DEFAULT_THRESHOLD = 5;

/**
 * Built-in per-tool escalation applied only when the user has not set an
 * explicit per-tool threshold. Bash can execute arbitrary code, so it is
 * reviewed more strictly by default; pin a tool explicitly to override.
 */
export const BUILTIN_TOOL_THRESHOLD_BOOST: Readonly<Record<ProtectedTool, number>> =
  {
    bash: 3,
    write: 0,
    edit: 0,
  };

/**
 * Review thresholds derived from the 1-10 `threshold` scale
 * (index = level - MIN_THRESHOLD). Higher levels flag more tool calls. Every
 * row keeps reviewProbability < highRiskProbability; the Jev payload stays
 * under the model's 32k context via context.maxCharacters.
 */
export const THRESHOLD_TABLE: readonly ResolvedThresholds[] = [
  { reviewProbability: 0.9, highRiskProbability: 0.95, severityReview: 3 },
  { reviewProbability: 0.85, highRiskProbability: 0.9, severityReview: 3 },
  { reviewProbability: 0.8, highRiskProbability: 0.85, severityReview: 3 },
  { reviewProbability: 0.7, highRiskProbability: 0.75, severityReview: 2 },
  { reviewProbability: 0.6, highRiskProbability: 0.65, severityReview: 2 },
  { reviewProbability: 0.5, highRiskProbability: 0.55, severityReview: 2 },
  { reviewProbability: 0.4, highRiskProbability: 0.45, severityReview: 2 },
  { reviewProbability: 0.3, highRiskProbability: 0.35, severityReview: 1 },
  { reviewProbability: 0.2, highRiskProbability: 0.25, severityReview: 1 },
  { reviewProbability: 0.1, highRiskProbability: 0.15, severityReview: 1 },
];

/** Derive the review thresholds for a base threshold level (clamped). */
export function deriveThresholds(threshold: number): ResolvedThresholds {
  const level = Math.max(MIN_THRESHOLD, Math.min(MAX_THRESHOLD, threshold));
  const row = THRESHOLD_TABLE[level - MIN_THRESHOLD];
  if (!row) throw new Error(`tool-guard: unknown threshold level ${level}`);
  return { ...row };
}

/**
 * Effective 1-10 level for a tool: the explicit per-tool value when present,
 * otherwise the base threshold plus the built-in per-tool boost (clamped).
 */
export function effectiveToolThreshold(
  config: Pick<ToolGuardConfig, "threshold" | "toolThresholds">,
  tool: ProtectedTool,
): number {
  const explicit = config.toolThresholds[tool];
  if (explicit !== undefined) return explicit;
  return Math.min(
    MAX_THRESHOLD,
    config.threshold + BUILTIN_TOOL_THRESHOLD_BOOST[tool],
  );
}

/** Derive the review thresholds in force for a specific tool. */
export function effectiveThresholds(
  config: Pick<ToolGuardConfig, "threshold" | "toolThresholds">,
  tool: ProtectedTool,
): ResolvedThresholds {
  return deriveThresholds(effectiveToolThreshold(config, tool));
}

const DEFAULT_CONFIG_VALUE: ToolGuardConfig = {
  disable: false,
  enabled: true,
  protectedTools: [...PROTECTED_TOOLS],
  model: "jev-latest",
  timeoutMs: 2000,
  evaluatorFailure: "allow",
  headlessRisk: "block",
  threshold: DEFAULT_THRESHOLD,
  toolThresholds: {},
  thresholds: deriveThresholds(DEFAULT_THRESHOLD),
  context: {
    recentMessages: 6,
    maxCharacters: 12_000,
    redactSecrets: true,
    includeToolResults: false,
  },
  rules: {
    protectedPaths: [],
    allowedPaths: [],
    alwaysConfirmCommands: [],
    allowedCommands: [],
    denyCommands: [],
  },
  notifications: {
    showAllowed: false,
    showEvaluatorFailures: true,
    showProjectOverride: true,
  },
  projectOverrides: "full",
};

export const DEFAULT_CONFIG: Readonly<ToolGuardConfig> =
  deepFreeze(DEFAULT_CONFIG_VALUE);

const TOP_LEVEL_KEYS = new Set([
  "disable",
  "enabled",
  "protectedTools",
  "model",
  "timeoutMs",
  "evaluatorFailure",
  "headlessRisk",
  "threshold",
  "toolThresholds",
  "context",
  "rules",
  "notifications",
  "projectOverrides",
]);
const CONTEXT_KEYS = new Set([
  "recentMessages",
  "maxCharacters",
  "redactSecrets",
  "includeToolResults",
]);
const RULE_KEYS = new Set([
  "protectedPaths",
  "allowedPaths",
  "alwaysConfirmCommands",
  "allowedCommands",
  "denyCommands",
]);
const NOTIFICATION_KEYS = new Set([
  "showAllowed",
  "showEvaluatorFailures",
  "showProjectOverride",
]);

export function parseToolGuardOverride(
  settings: unknown,
  source: ConfigSource,
): ToolGuardOverride {
  const root = requireRecord(settings, `${source} settings`);
  if (!("toolGuard" in root)) return {};

  const value = requireRecord(root.toolGuard, `${source}.toolGuard`);
  rejectUnknownKeys(value, TOP_LEVEL_KEYS, `${source}.toolGuard`);

  const parsed: ToolGuardOverride = {};
  if ("disable" in value)
    parsed.disable = requireBoolean(
      value.disable,
      `${source}.toolGuard.disable`,
    );
  if ("enabled" in value)
    parsed.enabled = requireBoolean(
      value.enabled,
      `${source}.toolGuard.enabled`,
    );
  if ("protectedTools" in value) {
    parsed.protectedTools = requireProtectedTools(
      value.protectedTools,
      `${source}.toolGuard.protectedTools`,
    );
  }
  if ("model" in value)
    parsed.model = requireNonEmptyString(
      value.model,
      `${source}.toolGuard.model`,
    );
  if ("timeoutMs" in value)
    parsed.timeoutMs = requireInteger(
      value.timeoutMs,
      100,
      60_000,
      `${source}.toolGuard.timeoutMs`,
    );
  if ("evaluatorFailure" in value) {
    parsed.evaluatorFailure = requireEnum(
      value.evaluatorFailure,
      ["allow", "block"],
      `${source}.toolGuard.evaluatorFailure`,
    );
  }
  if ("headlessRisk" in value) {
    parsed.headlessRisk = requireEnum(
      value.headlessRisk,
      ["allow", "block"],
      `${source}.toolGuard.headlessRisk`,
    );
  }
  if ("threshold" in value) {
    parsed.threshold = requireInteger(
      value.threshold,
      MIN_THRESHOLD,
      MAX_THRESHOLD,
      `${source}.toolGuard.threshold`,
    );
  }
  if ("toolThresholds" in value) {
    parsed.toolThresholds = parseToolThresholds(value.toolThresholds, source);
  }
  if ("context" in value) parsed.context = parseContext(value.context, source);
  if ("rules" in value) parsed.rules = parseRules(value.rules, source);
  if ("notifications" in value)
    parsed.notifications = parseNotifications(value.notifications, source);
  if ("projectOverrides" in value) {
    parsed.projectOverrides = requireEnum(
      value.projectOverrides,
      ["full", "none"],
      `${source}.toolGuard.projectOverrides`,
    );
  }
  return parsed;
}

export function resolveToolGuardConfig(
  options: {
    globalSettings?: unknown;
    projectSettings?: unknown;
    projectTrusted?: boolean;
  } = {},
): ResolvedToolGuardConfig {
  const config = cloneConfig(DEFAULT_CONFIG);
  const provenance = defaultProvenance();
  const globalOverride = parseToolGuardOverride(
    options.globalSettings ?? {},
    "global",
  );
  applyOverride(config, provenance, globalOverride, "global");

  const projectAllowed =
    options.projectTrusted === true && config.projectOverrides === "full";
  if (projectAllowed) {
    const projectOverride = parseToolGuardOverride(
      options.projectSettings ?? {},
      "project",
    );
    applyOverride(config, provenance, projectOverride, "project");
    deriveEffectiveThresholds(config, provenance);
    validateCrossFields(config, "effective toolGuard settings");
    return {
      config,
      provenance,
      projectOverrideApplied: Object.keys(projectOverride).length > 0,
    };
  }

  deriveEffectiveThresholds(config, provenance);
  validateCrossFields(config, "effective toolGuard settings");
  return { config, provenance, projectOverrideApplied: false };
}

/**
 * Re-derive the concrete review thresholds from the effective threshold
 * scale and tag their provenance as derived (they are never set directly).
 */
function deriveEffectiveThresholds(
  config: ToolGuardConfig,
  provenance: Record<string, ConfigSource>,
): void {
  config.thresholds = deriveThresholds(config.threshold);
  for (const key of Object.keys(config.thresholds)) {
    provenance[`thresholds.${key}`] = "derived";
  }
}

export async function loadToolGuardConfig(options: {
  cwd: string;
  projectTrusted: boolean;
  agentDir?: string;
}): Promise<ResolvedToolGuardConfig> {
  const agentDir = options.agentDir ?? getAgentDir();
  const globalPath = join(agentDir, "settings.json");
  const projectPath = join(options.cwd, CONFIG_DIR_NAME, "settings.json");
  const globalSettings = await readSettingsFile(globalPath, "global");
  const globalResolved = resolveToolGuardConfig({ globalSettings });
  const canReadProject =
    options.projectTrusted && globalResolved.config.projectOverrides === "full";
  const projectSettings = canReadProject
    ? await readSettingsFile(projectPath, "project")
    : {};
  return resolveToolGuardConfig({
    globalSettings,
    projectSettings,
    projectTrusted: options.projectTrusted,
  });
}

async function readSettingsFile(
  path: string,
  source: ConfigSource,
): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    throw new Error(`tool-guard: unable to read ${source} settings`);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`tool-guard: invalid JSON in ${source} settings`);
  }
}

function parseToolThresholds(
  value: unknown,
  source: ConfigSource,
): Partial<Record<ProtectedTool, number>> {
  const record = requireRecord(value, `${source}.toolGuard.toolThresholds`);
  const parsed: Partial<Record<ProtectedTool, number>> = {};
  for (const [tool, level] of Object.entries(record)) {
    if (!(PROTECTED_TOOLS as readonly string[]).includes(tool)) {
      throw new Error(
        `tool-guard: toolThresholds contains unsupported tool ${tool}`,
      );
    }
    parsed[tool as ProtectedTool] = requireInteger(
      level,
      MIN_THRESHOLD,
      MAX_THRESHOLD,
      `${source}.toolGuard.toolThresholds.${tool}`,
    );
  }
  return parsed;
}

function parseContext(
  value: unknown,
  source: ConfigSource,
): Partial<ToolGuardConfig["context"]> {
  const record = requireRecord(value, `${source}.toolGuard.context`);
  rejectUnknownKeys(record, CONTEXT_KEYS, `${source}.toolGuard.context`);
  const parsed: Partial<ToolGuardConfig["context"]> = {};
  if ("recentMessages" in record) {
    parsed.recentMessages = requireInteger(
      record.recentMessages,
      0,
      100,
      `${source}.toolGuard.context.recentMessages`,
    );
  }
  if ("maxCharacters" in record) {
    parsed.maxCharacters = requireInteger(
      record.maxCharacters,
      1_000,
      24_000,
      `${source}.toolGuard.context.maxCharacters`,
    );
  }
  if ("redactSecrets" in record) {
    parsed.redactSecrets = requireBoolean(
      record.redactSecrets,
      `${source}.toolGuard.context.redactSecrets`,
    );
  }
  if ("includeToolResults" in record) {
    parsed.includeToolResults = requireBoolean(
      record.includeToolResults,
      `${source}.toolGuard.context.includeToolResults`,
    );
  }
  return parsed;
}

function parseRules(
  value: unknown,
  source: ConfigSource,
): Partial<ToolGuardConfig["rules"]> {
  const record = requireRecord(value, `${source}.toolGuard.rules`);
  rejectUnknownKeys(record, RULE_KEYS, `${source}.toolGuard.rules`);
  const parsed: Partial<ToolGuardConfig["rules"]> = {};
  if ("protectedPaths" in record) {
    parsed.protectedPaths = requireStringArray(
      record.protectedPaths,
      `${source}.toolGuard.rules.protectedPaths`,
    );
  }
  if ("allowedPaths" in record) {
    parsed.allowedPaths = requireStringArray(
      record.allowedPaths,
      `${source}.toolGuard.rules.allowedPaths`,
    );
  }
  if ("alwaysConfirmCommands" in record) {
    parsed.alwaysConfirmCommands = requireStringArray(
      record.alwaysConfirmCommands,
      `${source}.toolGuard.rules.alwaysConfirmCommands`,
    );
  }
  if ("allowedCommands" in record) {
    parsed.allowedCommands = requireStringArray(
      record.allowedCommands,
      `${source}.toolGuard.rules.allowedCommands`,
    );
  }
  if ("denyCommands" in record) {
    parsed.denyCommands = requireStringArray(
      record.denyCommands,
      `${source}.toolGuard.rules.denyCommands`,
    );
  }
  return parsed;
}

function parseNotifications(
  value: unknown,
  source: ConfigSource,
): Partial<ToolGuardConfig["notifications"]> {
  const record = requireRecord(value, `${source}.toolGuard.notifications`);
  rejectUnknownKeys(
    record,
    NOTIFICATION_KEYS,
    `${source}.toolGuard.notifications`,
  );
  const parsed: Partial<ToolGuardConfig["notifications"]> = {};
  if ("showAllowed" in record) {
    parsed.showAllowed = requireBoolean(
      record.showAllowed,
      `${source}.toolGuard.notifications.showAllowed`,
    );
  }
  if ("showEvaluatorFailures" in record) {
    parsed.showEvaluatorFailures = requireBoolean(
      record.showEvaluatorFailures,
      `${source}.toolGuard.notifications.showEvaluatorFailures`,
    );
  }
  if ("showProjectOverride" in record) {
    parsed.showProjectOverride = requireBoolean(
      record.showProjectOverride,
      `${source}.toolGuard.notifications.showProjectOverride`,
    );
  }
  return parsed;
}

function applyOverride(
  config: ToolGuardConfig,
  provenance: Record<string, ConfigSource>,
  override: ToolGuardOverride,
  source: ConfigSource,
): void {
  applyScalar(
    override.disable,
    (value) => {
      config.disable = value;
    },
    "disable",
    provenance,
    source,
  );
  applyScalar(
    override.enabled,
    (value) => {
      config.enabled = value;
    },
    "enabled",
    provenance,
    source,
  );
  applyScalar(
    override.protectedTools,
    (value) => {
      config.protectedTools = [...value];
    },
    "protectedTools",
    provenance,
    source,
  );
  applyScalar(
    override.model,
    (value) => {
      config.model = value;
    },
    "model",
    provenance,
    source,
  );
  applyScalar(
    override.timeoutMs,
    (value) => {
      config.timeoutMs = value;
    },
    "timeoutMs",
    provenance,
    source,
  );
  applyScalar(
    override.evaluatorFailure,
    (value) => {
      config.evaluatorFailure = value;
    },
    "evaluatorFailure",
    provenance,
    source,
  );
  applyScalar(
    override.headlessRisk,
    (value) => {
      config.headlessRisk = value;
    },
    "headlessRisk",
    provenance,
    source,
  );
  applyScalar(
    override.threshold,
    (value) => {
      config.threshold = value;
    },
    "threshold",
    provenance,
    source,
  );
  if (override.toolThresholds !== undefined) {
    for (const [tool, level] of Object.entries(override.toolThresholds)) {
      config.toolThresholds[tool as ProtectedTool] = level;
      provenance[`toolThresholds.${tool}`] = source;
    }
  }
  applyNested(config.context, override.context, "context", provenance, source);
  applyNested(config.rules, override.rules, "rules", provenance, source);
  applyNested(
    config.notifications,
    override.notifications,
    "notifications",
    provenance,
    source,
  );
  applyScalar(
    override.projectOverrides,
    (value) => {
      config.projectOverrides = value;
    },
    "projectOverrides",
    provenance,
    source,
  );
  validateCrossFields(config, `${source}.toolGuard`);
}

function applyScalar<T>(
  value: T | undefined,
  apply: (value: T) => void,
  path: string,
  provenance: Record<string, ConfigSource>,
  source: ConfigSource,
): void {
  if (value === undefined) return;
  apply(value);
  provenance[path] = source;
}

function applyNested<T extends object>(
  target: T,
  override: Partial<T> | undefined,
  path: string,
  provenance: Record<string, ConfigSource>,
  source: ConfigSource,
): void {
  if (override === undefined) return;
  Object.assign(target, override);
  for (const child of Object.keys(override))
    provenance[`${path}.${child}`] = source;
}

function validateCrossFields(config: ToolGuardConfig, label: string): void {
  for (const tool of PROTECTED_TOOLS) {
    const thresholds = effectiveThresholds(config, tool);
    if (thresholds.reviewProbability > thresholds.highRiskProbability) {
      throw new Error(
        `tool-guard: ${label} derived thresholds for ${tool} are inconsistent`,
      );
    }
  }
}

function defaultProvenance(): Record<string, ConfigSource> {
  const provenance: Record<string, ConfigSource> = {};
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    if (key === "thresholds") {
      for (const child of Object.keys(value as Record<string, unknown>))
        provenance[`${key}.${child}`] = "derived";
      continue;
    }
    if (isRecord(value)) {
      for (const child of Object.keys(value))
        provenance[`${key}.${child}`] = "default";
    } else {
      provenance[key] = "default";
    }
  }
  return provenance;
}

function cloneConfig(config: Readonly<ToolGuardConfig>): ToolGuardConfig {
  return {
    ...config,
    protectedTools: [...config.protectedTools],
    toolThresholds: { ...config.toolThresholds },
    thresholds: { ...config.thresholds },
    context: { ...config.context },
    rules: {
      protectedPaths: [...config.rules.protectedPaths],
      allowedPaths: [...config.rules.allowedPaths],
      alwaysConfirmCommands: [...config.rules.alwaysConfirmCommands],
      allowedCommands: [...config.rules.allowedCommands],
      denyCommands: [...config.rules.denyCommands],
    },
    notifications: { ...config.notifications },
  };
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child);
  }
  return value;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown)
    throw new Error(`tool-guard: unknown setting ${label}.${unknown}`);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value))
    throw new Error(`tool-guard: ${label} must be an object`);
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean")
    throw new Error(`tool-guard: ${label} must be a boolean`);
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 200
  ) {
    throw new Error(`tool-guard: ${label} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value))
    throw new Error(`tool-guard: ${label} must be an array`);
  const result = value.map((item, index) =>
    requireNonEmptyString(item, `${label}[${index}]`),
  );
  if (new Set(result).size !== result.length)
    throw new Error(`tool-guard: ${label} must not contain duplicates`);
  return result;
}

function requireProtectedTools(value: unknown, label: string): ProtectedTool[] {
  const items = requireStringArray(value, label);
  for (const item of items) {
    if (!(PROTECTED_TOOLS as readonly string[]).includes(item)) {
      throw new Error(`tool-guard: ${label} contains unsupported tool`);
    }
  }
  return items as ProtectedTool[];
}

function requireInteger(
  value: unknown,
  min: number,
  max: number,
  label: string,
): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  ) {
    throw new Error(
      `tool-guard: ${label} must be an integer from ${min} to ${max}`,
    );
  }
  return value as number;
}

function requireEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`tool-guard: ${label} must be one of ${values.join(", ")}`);
  }
  return value as T[number];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
