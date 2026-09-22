import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  effectiveThresholds,
  type ProtectedTool,
  type ResolvedToolGuardConfig,
  type ToolGuardConfig,
} from "./config.ts";
import {
  buildGuardState,
  redactSecrets,
  type GuardContext,
} from "./context.ts";
import { evaluateToolRisk, type RiskEvaluation } from "./evaluator.ts";

export interface GuardToolCallEvent {
  toolName: string;
  input: unknown;
}

export interface GuardHookContext extends GuardContext {
  hasUI: boolean;
  signal: AbortSignal | undefined;
  isProjectTrusted(): boolean;
  ui: Pick<ExtensionContext["ui"], "confirm" | "notify" | "setStatus">;
}

export interface GuardHookResult {
  block: true;
  reason: string;
}

export type LoadGuardConfig = (
  ctx: GuardHookContext,
) => Promise<ResolvedToolGuardConfig>;
export type EvaluateGuardRisk = typeof evaluateToolRisk;

export function createToolCallGuard(options: {
  loadConfig: LoadGuardConfig;
  evaluateRisk?: EvaluateGuardRisk;
  getApiKey?: () => string | undefined;
}) {
  const evaluateRisk = options.evaluateRisk ?? evaluateToolRisk;
  const getApiKey = options.getApiKey ?? (() => process.env.TYPESAFE_API_KEY);
  const reportedFailures = new Set<string>();
  let reportedProjectOverride = false;

  return async (
    event: GuardToolCallEvent,
    ctx: GuardHookContext,
  ): Promise<GuardHookResult | undefined> => {
    let resolvedConfig: ResolvedToolGuardConfig;
    try {
      resolvedConfig = await options.loadConfig(ctx);
    } catch {
      ctx.ui.setStatus("tool-guard", "guard: invalid settings");
      return {
        block: true,
        reason: "Tool call blocked because tool-guard settings are invalid.",
      };
    }

    const { config } = resolvedConfig;
    updateGuardStatus(ctx, config, getApiKey());
    notifyProjectOverride(ctx, resolvedConfig, reportedProjectOverride);
    if (resolvedConfig.projectOverrideApplied) reportedProjectOverride = true;
    if (
      config.disable ||
      !config.enabled ||
      !isProtectedTool(event.toolName, config)
    )
      return undefined;

    const ruleDecision = evaluateRules(event, ctx.cwd, config);
    if (ruleDecision?.action === "allow") {
      notifyAllowed(ctx, config, event.toolName, "allowed by explicit rule");
      return undefined;
    }
    if (ruleDecision?.action === "deny") {
      return {
        block: true,
        reason: `Tool call blocked: ${ruleDecision.reason}`,
      };
    }
    if (ruleDecision?.action === "confirm") {
      return confirmOrBlock(
        ctx,
        config,
        event,
        ruleDecision.reason,
        ruleDecision.highRisk,
      );
    }

    // The per-tool threshold scale derives stricter review thresholds for
    // higher-risk tools (e.g. bash); the evaluator only sees those values.
    const tool = event.toolName as ProtectedTool;
    const evalConfig: ToolGuardConfig = {
      ...config,
      thresholds: effectiveThresholds(config, tool),
    };

    let evaluation: RiskEvaluation;
    try {
      const state = buildGuardState({
        ctx,
        toolName: event.toolName,
        input: event.input,
        config: config.context,
      });
      const evaluationOptions: Parameters<EvaluateGuardRisk>[0] = {
        state,
        config: evalConfig,
      };
      const apiKey = getApiKey();
      if (apiKey !== undefined) evaluationOptions.apiKey = apiKey;
      if (ctx.signal !== undefined) evaluationOptions.signal = ctx.signal;
      evaluation = await evaluateRisk(evaluationOptions);
    } catch {
      evaluation = {
        status: "unavailable",
        decision: config.evaluatorFailure === "allow" ? "allow" : "block",
        highRisk: false,
        triggered: [],
        failure: "request_failed",
      };
    }

    if (evaluation.status === "unavailable") {
      notifyFailureOnce(ctx, config, evaluation, reportedFailures);
      if (evaluation.decision === "block") {
        return {
          block: true,
          reason: "Tool call blocked because Jev evaluation is unavailable.",
        };
      }
      return undefined;
    }

    if (evaluation.decision === "allow") {
      notifyAllowed(ctx, config, event.toolName, "Jev assessed low risk");
      return undefined;
    }
    return confirmOrBlock(
      ctx,
      config,
      event,
      describeEvaluation(evaluation),
      evaluation.highRisk,
    );
  };
}

function isProtectedTool(toolName: string, config: ToolGuardConfig): boolean {
  return config.protectedTools.some(
    (protectedTool) => protectedTool === toolName,
  );
}

interface RuleDecision {
  action: "allow" | "confirm" | "deny";
  reason: string;
  highRisk: boolean;
}

export interface BashDangerRule {
  id: string;
  label: string;
  pattern: RegExp;
}

/**
 * Deterministic gate for bash: high-impact command patterns that force a
 * review dialog regardless of the threshold scale or Jev availability. Bash
 * can execute arbitrary code, so the most destructive classes are screened
 * before the probabilistic evaluation. A match forces confirmation; it never
 * blocks outright (an explicit deny rule can still hard-block).
 */
export const BASH_DANGER_RULES: readonly BashDangerRule[] = [
  {
    id: "fork-bomb",
    label: "fork bomb",
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  },
  {
    id: "recursive-delete",
    label: "recursive delete",
    pattern: /\brm\b[^\n;&|]*?(\s-[a-zA-Z]*[rR][a-zA-Z]*\b|\s--recursive\b)/,
  },
  {
    id: "disk-write",
    label: "raw disk or filesystem modification",
    pattern:
      /\bdd\b[^\n;&|]*\bof=\/dev\/|>\s*\/dev\/(?:sd[a-z0-9]+|nvme\d+n\d+|mmcblk\d+)|\bmkfs(?:\.[a-z0-9]+)?\b|\b(?:fdisk|parted|wipefs|sfdisk|sgdisk)\b/,
  },
  {
    id: "power",
    label: "system power or shutdown",
    pattern: /\b(?:shutdown|reboot|poweroff|halt|init\s+[06])\b/,
  },
  {
    id: "pipe-to-shell",
    label: "piping remote content into a shell",
    pattern:
      /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:bash|sh|zsh|dash|ksh|python[0-9.]*|node)\b/,
  },
  {
    id: "force-push",
    label: "force push or remote ref deletion",
    pattern:
      /\bgit\s+push\b[^\n;&|]*?(?:--force\b|--mirror\b|--delete\b|\s-f\b)/,
  },
  {
    id: "registry-publish",
    label: "publishing to a package registry",
    pattern: /\b(?:npm|pnpm|yarn|bun)\s+(?:publish|unpublish|deprecate)\b/,
  },
  {
    id: "world-writable",
    label: "world-writable permissions",
    pattern: /\bchmod\s+(?:-[a-zA-Z]+\s+)*0?777\b/,
  },
  {
    id: "recursive-ownership",
    label: "recursive ownership change",
    pattern: /\bchown\s+(?:-[a-zA-Z]+\s+)*(?:-R\b|--recursive\b)/,
  },
  {
    id: "container-destruct",
    label: "container or workload destruction",
    pattern:
      /\bdocker\s+(?:rm\s+(?:-[a-zA-Z]+\s+)*-f\b|system\s+prune|volume\s+rm|network\s+prune)|\bkubectl\s+delete\b/,
  },
  {
    id: "sql-destruct",
    label: "destructive SQL statement",
    pattern: /\b(?:drop|truncate)\s+(?:table|database|schema)\b/i,
  },
];

/**
 * Rule precedence for bash commands: explicit deny (hard block) > explicit
 * allow (suppresses even built-in danger patterns; an informed user choice)
 * > built-in danger (confirm) > explicit always-confirm (confirm).
 * Path rules keep their prior order: protected path > allowed path.
 */
function evaluateRules(
  event: GuardToolCallEvent,
  cwd: string,
  config: ToolGuardConfig,
): RuleDecision | undefined {
  if (event.toolName === "bash") {
    const command = stringField(event.input, "command");
    if (!command) return undefined;
    const denied = config.rules.denyCommands.find((rule) =>
      commandContains(command, rule),
    );
    if (denied) {
      return {
        action: "deny",
        reason: `Matched an explicit deny rule ("${denied}").`,
        highRisk: false,
      };
    }
    const allowed = config.rules.allowedCommands.find((rule) =>
      commandContains(command, rule),
    );
    if (allowed) {
      return {
        action: "allow",
        reason: "Matched an explicit allow rule.",
        highRisk: false,
      };
    }
    const danger = BASH_DANGER_RULES.find((rule) => rule.pattern.test(command));
    if (danger) {
      return {
        action: "confirm",
        reason: `Matched a built-in dangerous bash pattern (${danger.label}).`,
        highRisk: true,
      };
    }
    const alwaysConfirm = config.rules.alwaysConfirmCommands.find((rule) =>
      commandContains(command, rule),
    );
    if (alwaysConfirm) {
      return {
        action: "confirm",
        reason: `Matched an explicit always-confirm rule ("${alwaysConfirm}").`,
        highRisk: false,
      };
    }
    return undefined;
  }
  if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
  const path = stringField(event.input, "path");
  if (!path) return undefined;
  if (config.rules.protectedPaths.some((rule) => pathMatches(path, rule, cwd))) {
    return {
      action: "confirm",
      reason: "Matched an explicit protected path rule.",
      highRisk: false,
    };
  }
  if (config.rules.allowedPaths.some((rule) => pathMatches(path, rule, cwd))) {
    return {
      action: "allow",
      reason: "Matched an explicit allowed path rule.",
      highRisk: false,
    };
  }
  return undefined;
}

/**
 * Substring matching so a rule can catch a command embedded in a pipeline or
 * compound statement. Exact and prefix matches (the previous behavior) remain
 * a subset of this.
 */
function commandContains(command: string, rule: string): boolean {
  const needle = rule.trim();
  return needle.length > 0 && command.includes(needle);
}

function pathMatches(path: string, rule: string, cwd: string): boolean {
  const candidate = resolve(cwd, path);
  const boundary = resolve(cwd, rule);
  return candidate === boundary || candidate.startsWith(`${boundary}/`);
}

async function confirmOrBlock(
  ctx: GuardHookContext,
  config: ToolGuardConfig,
  event: GuardToolCallEvent,
  rationale: string,
  highRisk: boolean,
): Promise<GuardHookResult | undefined> {
  if (!ctx.hasUI) {
    if (config.headlessRisk === "allow") return undefined;
    return {
      block: true,
      reason: `Risky ${event.toolName} call blocked because confirmation UI is unavailable.`,
    };
  }

  const input = truncate(
    JSON.stringify(redactSecrets(event.input), null, 2),
    2400,
  );
  const title = highRisk
    ? `Tool Guard: high-risk ${event.toolName}`
    : `Tool Guard: review ${event.toolName}`;
  const allowed = await ctx.ui.confirm(
    title,
    `${rationale}\n\n${input}\n\nAllow this tool call?`,
  );
  if (allowed) return undefined;
  return {
    block: true,
    reason: `Risky ${event.toolName} call denied by the user.`,
  };
}

function describeEvaluation(evaluation: RiskEvaluation): string {
  const risks =
    evaluation.triggered.length > 0
      ? evaluation.triggered
          .map(
            (risk) =>
              `${riskLabel(risk.id)} ${(risk.probability * 100).toFixed(0)}%`,
          )
          .join(", ")
      : "severity threshold";
  const severity =
    evaluation.severity === undefined
      ? "unknown"
      : evaluation.severity.toFixed(2);
  return `Jev requested review. Triggered: ${risks}. Severity: ${severity}/3.`;
}

function riskLabel(id: RiskEvaluation["triggered"][number]["id"]): string {
  const labels = {
    intentMismatch: "intent mismatch",
    excessiveScope: "excessive scope",
    sensitiveExposure: "sensitive exposure",
    destructiveChange: "destructive change",
    externalImpact: "external impact",
    hardToReverse: "hard to reverse",
  };
  return labels[id];
}

function notifyFailureOnce(
  ctx: GuardHookContext,
  config: ToolGuardConfig,
  evaluation: RiskEvaluation,
  reportedFailures: Set<string>,
): void {
  const failure = evaluation.failure ?? "unknown";
  ctx.ui.setStatus(
    "tool-guard",
    `guard inactive: ${failure.replaceAll("_", " ")}`,
  );
  if (
    !config.notifications.showEvaluatorFailures ||
    reportedFailures.has(failure) ||
    !ctx.hasUI
  )
    return;
  reportedFailures.add(failure);
  ctx.ui.notify(
    `Tool Guard is inactive (${failure.replaceAll("_", " ")}); protected calls are following evaluatorFailure=${config.evaluatorFailure}.`,
    "warning",
  );
}

function notifyAllowed(
  ctx: GuardHookContext,
  config: ToolGuardConfig,
  toolName: string,
  reason: string,
): void {
  if (config.notifications.showAllowed && ctx.hasUI)
    ctx.ui.notify(`Tool Guard allowed ${toolName}: ${reason}.`, "info");
}

function notifyProjectOverride(
  ctx: GuardHookContext,
  resolved: ResolvedToolGuardConfig,
  alreadyReported: boolean,
): void {
  if (
    resolved.projectOverrideApplied &&
    resolved.config.notifications.showProjectOverride &&
    !alreadyReported &&
    ctx.hasUI
  ) {
    ctx.ui.notify(
      "Tool Guard is using trusted project overrides. Run /tool-guard status to inspect provenance.",
      "warning",
    );
  }
}

export function updateGuardStatus(
  ctx: Pick<GuardHookContext, "ui">,
  config: ToolGuardConfig,
  apiKey: string | undefined,
): void {
  if (config.disable || !config.enabled) {
    ctx.ui.setStatus("tool-guard", "guard: disabled");
    return;
  }
  ctx.ui.setStatus(
    "tool-guard",
    apiKey?.trim() ? "guard: Jev active" : "guard: enabled; API key missing",
  );
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(value: string, limit: number): string {
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}\n...[TRUNCATED]`;
}
