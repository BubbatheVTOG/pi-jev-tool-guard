import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedToolGuardConfig, ToolGuardConfig } from "./config.ts";
import { buildGuardState, redactSecrets, type GuardContext } from "./context.ts";
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

export type LoadGuardConfig = (ctx: GuardHookContext) => Promise<ResolvedToolGuardConfig>;
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

  return async (event: GuardToolCallEvent, ctx: GuardHookContext): Promise<GuardHookResult | undefined> => {
    let resolvedConfig: ResolvedToolGuardConfig;
    try {
      resolvedConfig = await options.loadConfig(ctx);
    } catch {
      ctx.ui.setStatus("tool-guard", "guard: invalid settings");
      return { block: true, reason: "Tool call blocked because tool-guard settings are invalid." };
    }

    const { config } = resolvedConfig;
    updateGuardStatus(ctx, config, getApiKey());
    notifyProjectOverride(ctx, resolvedConfig, reportedProjectOverride);
    if (resolvedConfig.projectOverrideApplied) reportedProjectOverride = true;
    if (!config.enabled || !isProtectedTool(event.toolName, config)) return undefined;

    const ruleDecision = evaluateRules(event, ctx.cwd, config);
    if (ruleDecision === "allow") {
      notifyAllowed(ctx, config, event.toolName, "allowed by explicit rule");
      return undefined;
    }
    if (ruleDecision === "confirm") {
      return confirmOrBlock(ctx, config, event, "Matched an explicit always-confirm rule.", true);
    }

    let evaluation: RiskEvaluation;
    try {
      const state = buildGuardState({ ctx, toolName: event.toolName, input: event.input, config: config.context });
      const evaluationOptions: Parameters<EvaluateGuardRisk>[0] = { state, config };
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
        return { block: true, reason: "Tool call blocked because Jev evaluation is unavailable." };
      }
      return undefined;
    }

    if (evaluation.decision === "allow") {
      notifyAllowed(ctx, config, event.toolName, "Jev assessed low risk");
      return undefined;
    }
    return confirmOrBlock(ctx, config, event, describeEvaluation(evaluation), evaluation.highRisk);
  };
}

function isProtectedTool(toolName: string, config: ToolGuardConfig): boolean {
  return config.protectedTools.some((protectedTool) => protectedTool === toolName);
}

function evaluateRules(event: GuardToolCallEvent, cwd: string, config: ToolGuardConfig): "allow" | "confirm" | undefined {
  if (event.toolName === "bash") {
    const command = stringField(event.input, "command");
    if (!command) return undefined;
    if (config.rules.alwaysConfirmCommands.some((rule) => commandMatches(command, rule))) return "confirm";
    if (config.rules.allowedCommands.some((rule) => commandMatches(command, rule))) return "allow";
    return undefined;
  }
  if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
  const path = stringField(event.input, "path");
  if (!path) return undefined;
  if (config.rules.protectedPaths.some((rule) => pathMatches(path, rule, cwd))) return "confirm";
  if (config.rules.allowedPaths.some((rule) => pathMatches(path, rule, cwd))) return "allow";
  return undefined;
}

function commandMatches(command: string, rule: string): boolean {
  const normalizedCommand = command.trim();
  const normalizedRule = rule.trim();
  return normalizedCommand === normalizedRule || normalizedCommand.startsWith(`${normalizedRule} `);
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
    return { block: true, reason: `Risky ${event.toolName} call blocked because confirmation UI is unavailable.` };
  }

  const input = truncate(JSON.stringify(redactSecrets(event.input), null, 2), 2400);
  const title = highRisk ? `Tool Guard: high-risk ${event.toolName}` : `Tool Guard: review ${event.toolName}`;
  const allowed = await ctx.ui.confirm(title, `${rationale}\n\n${input}\n\nAllow this tool call?`);
  if (allowed) return undefined;
  return { block: true, reason: `Risky ${event.toolName} call denied by the user.` };
}

function describeEvaluation(evaluation: RiskEvaluation): string {
  const risks = evaluation.triggered.length > 0
    ? evaluation.triggered.map((risk) => `${riskLabel(risk.id)} ${(risk.probability * 100).toFixed(0)}%`).join(", ")
    : "severity threshold";
  const severity = evaluation.severity === undefined ? "unknown" : evaluation.severity.toFixed(2);
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
  ctx.ui.setStatus("tool-guard", `guard inactive: ${failure.replaceAll("_", " ")}`);
  if (!config.notifications.showEvaluatorFailures || reportedFailures.has(failure) || !ctx.hasUI) return;
  reportedFailures.add(failure);
  ctx.ui.notify(`Tool Guard is inactive (${failure.replaceAll("_", " ")}); protected calls are following evaluatorFailure=${config.evaluatorFailure}.`, "warning");
}

function notifyAllowed(ctx: GuardHookContext, config: ToolGuardConfig, toolName: string, reason: string): void {
  if (config.notifications.showAllowed && ctx.hasUI) ctx.ui.notify(`Tool Guard allowed ${toolName}: ${reason}.`, "info");
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
    ctx.ui.notify("Tool Guard is using trusted project overrides. Run /tool-guard status to inspect provenance.", "warning");
  }
}

export function updateGuardStatus(
  ctx: Pick<GuardHookContext, "ui">,
  config: ToolGuardConfig,
  apiKey: string | undefined,
): void {
  if (!config.enabled) {
    ctx.ui.setStatus("tool-guard", "guard: disabled");
    return;
  }
  if (!apiKey?.trim()) {
    ctx.ui.setStatus("tool-guard", "guard inactive: missing API key");
    return;
  }
  ctx.ui.setStatus("tool-guard", "guard: Jev active");
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
  return value.length <= limit ? value : `${value.slice(0, limit)}\n...[TRUNCATED]`;
}
