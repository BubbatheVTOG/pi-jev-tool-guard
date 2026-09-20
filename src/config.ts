import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export const PROTECTED_TOOLS = ["bash", "write", "edit"] as const;
export type ProtectedTool = (typeof PROTECTED_TOOLS)[number];
export type EvaluatorFailure = "allow" | "block";
export type HeadlessRisk = "allow" | "block";
export type ProjectOverrides = "full" | "none";
export type ConfigSource = "default" | "global" | "project";

export interface ToolGuardConfig {
  disable: boolean;
  enabled: boolean;
  protectedTools: ProtectedTool[];
  model: string;
  timeoutMs: number;
  evaluatorFailure: EvaluatorFailure;
  headlessRisk: HeadlessRisk;
  thresholds: {
    reviewProbability: number;
    highRiskProbability: number;
    severityReview: number;
  };
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
  thresholds?: Partial<ToolGuardConfig["thresholds"]>;
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

const DEFAULT_CONFIG_VALUE: ToolGuardConfig = {
  disable: false,
  enabled: true,
  protectedTools: [...PROTECTED_TOOLS],
  model: "jev-latest",
  timeoutMs: 2000,
  evaluatorFailure: "allow",
  headlessRisk: "block",
  thresholds: {
    reviewProbability: 0.35,
    highRiskProbability: 0.7,
    severityReview: 1,
  },
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
  "thresholds",
  "context",
  "rules",
  "notifications",
  "projectOverrides",
]);
const THRESHOLD_KEYS = new Set([
  "reviewProbability",
  "highRiskProbability",
  "severityReview",
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
  if ("thresholds" in value)
    parsed.thresholds = parseThresholds(value.thresholds, source);
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
    validateCrossFields(config, "effective toolGuard settings");
    return {
      config,
      provenance,
      projectOverrideApplied: Object.keys(projectOverride).length > 0,
    };
  }

  validateCrossFields(config, "effective toolGuard settings");
  return { config, provenance, projectOverrideApplied: false };
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

function parseThresholds(
  value: unknown,
  source: ConfigSource,
): Partial<ToolGuardConfig["thresholds"]> {
  const record = requireRecord(value, `${source}.toolGuard.thresholds`);
  rejectUnknownKeys(record, THRESHOLD_KEYS, `${source}.toolGuard.thresholds`);
  const parsed: Partial<ToolGuardConfig["thresholds"]> = {};
  if ("reviewProbability" in record) {
    parsed.reviewProbability = requireNumber(
      record.reviewProbability,
      0,
      1,
      `${source}.toolGuard.thresholds.reviewProbability`,
    );
  }
  if ("highRiskProbability" in record) {
    parsed.highRiskProbability = requireNumber(
      record.highRiskProbability,
      0,
      1,
      `${source}.toolGuard.thresholds.highRiskProbability`,
    );
  }
  if ("severityReview" in record) {
    parsed.severityReview = requireNumber(
      record.severityReview,
      0,
      3,
      `${source}.toolGuard.thresholds.severityReview`,
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
      100_000,
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
  applyNested(
    config.thresholds,
    override.thresholds,
    "thresholds",
    provenance,
    source,
  );
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
  if (
    config.thresholds.reviewProbability > config.thresholds.highRiskProbability
  ) {
    throw new Error(
      `tool-guard: ${label} reviewProbability must not exceed highRiskProbability`,
    );
  }
}

function defaultProvenance(): Record<string, ConfigSource> {
  const provenance: Record<string, ConfigSource> = {};
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
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
    thresholds: { ...config.thresholds },
    context: { ...config.context },
    rules: {
      protectedPaths: [...config.rules.protectedPaths],
      allowedPaths: [...config.rules.allowedPaths],
      alwaysConfirmCommands: [...config.rules.alwaysConfirmCommands],
      allowedCommands: [...config.rules.allowedCommands],
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

function requireNumber(
  value: unknown,
  min: number,
  max: number,
  label: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(
      `tool-guard: ${label} must be a number from ${min} to ${max}`,
    );
  }
  return value;
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
