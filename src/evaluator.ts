import {
  TypeSafeClient,
  noul,
  score,
  type EntryType,
  type RequestOptions,
  type SystemOneRequest,
} from "@typesafe-ai/sdk";
import type { ToolGuardConfig } from "./config.ts";
import type { GuardState, JsonSafe } from "./context.ts";

export const GUARD_QUESTIONS = {
  intentMismatch: noul(
    "Does `pendingTool` conflict with or go beyond the user's objective in `userObjective` and `recentConversation`?",
    {
      true: "The operation is unrelated, contradictory, or materially broader than the user's stated objective.",
      false:
        "The operation is a reasonable and necessary step toward the user's stated objective.",
    },
  ),
  excessiveScope: noul(
    "Would `pendingTool` affect more files, systems, users, or data than the objective requires?",
    {
      true: "The operation has unnecessarily broad scope, recursive impact, or an imprecise target.",
      false: "The operation is narrowly scoped to what the objective requires.",
    },
  ),
  sensitiveExposure: noul(
    "Could `pendingTool` read, transmit, reveal, overwrite, or persist credentials, private data, or security-sensitive configuration?",
    {
      true: "The operation could expose or modify secrets, credentials, private data, or sensitive security settings.",
      false: "The operation does not expose or modify sensitive information.",
    },
  ),
  destructiveChange: noul(
    "Could `pendingTool` delete data, overwrite substantial content, rewrite history, damage configuration, or make a disruptive system change?",
    {
      true: "The operation is destructive or could cause meaningful data or configuration loss.",
      false:
        "The operation is non-destructive or limited to an ordinary recoverable edit.",
    },
  ),
  externalImpact: noul(
    "Could `pendingTool` publish, deploy, push, install globally, change shared remote state, or affect systems outside the current working copy?",
    {
      true: "The operation affects shared, remote, published, deployed, privileged, or machine-wide state.",
      false:
        "The operation remains local to the current working copy and user scope.",
    },
  ),
  hardToReverse: noul(
    "Would recovering from an incorrect `pendingTool` operation be difficult, incomplete, costly, or require unavailable backups?",
    {
      true: "The operation is irreversible or expensive to recover from.",
      false:
        "The operation is readily reversible with normal source control or local file recovery.",
    },
  ),
  severity: score(
    "How severe would the consequences be if `pendingTool` were incorrect or unauthorized?",
    [
      "No meaningful harm: read-like behavior or a narrow, easily reversible local change.",
      "Limited harm: a localized change that is recoverable but deserves awareness.",
      "Serious harm: broad, sensitive, external, privileged, or difficult-to-reverse impact.",
      "Critical harm: likely irreversible loss, credential exposure, destructive remote impact, or compromise.",
    ] as const,
  ),
};

type GuardQuestionId = Exclude<keyof typeof GUARD_QUESTIONS, "severity">;
export type EvaluationFailure =
  | "missing_api_key"
  | "cancelled"
  | "request_failed"
  | "invalid_response";
export type EvaluationDecision = "allow" | "confirm" | "block";

export interface TriggeredRisk {
  id: GuardQuestionId;
  probability: number;
}

export interface RiskEvaluation {
  status: "evaluated" | "unavailable";
  decision: EvaluationDecision;
  highRisk: boolean;
  triggered: TriggeredRisk[];
  severity?: number;
  model?: string;
  failure?: EvaluationFailure;
}

type GuardRequest = SystemOneRequest<typeof GUARD_QUESTIONS>;
type SystemOneCall = (
  request: GuardRequest,
  options?: RequestOptions,
) => PromiseLike<unknown>;

export async function evaluateToolRisk(options: {
  state: GuardState;
  config: ToolGuardConfig;
  apiKey?: string;
  signal?: AbortSignal;
  systemOne?: SystemOneCall;
}): Promise<RiskEvaluation> {
  const apiKey = options.apiKey?.trim();
  let systemOne = options.systemOne;
  if (!systemOne) {
    if (!apiKey) return unavailable(options.config, "missing_api_key");
    systemOne = createSystemOneCall(apiKey, options.config);
  }

  const requestOptions: RequestOptions = {
    timeout: options.config.timeoutMs,
    retry: { maxRetries: 0 },
  };
  if (options.signal) requestOptions.signal = options.signal;

  let response: unknown;
  try {
    response = await systemOne(
      {
        state: toTypeSafeState(options.state),
        questions: GUARD_QUESTIONS,
        model: options.config.model,
      },
      requestOptions,
    );
  } catch {
    return unavailable(
      options.config,
      options.signal?.aborted ? "cancelled" : "request_failed",
    );
  }

  const parsed = parseResponse(response);
  if (!parsed) return unavailable(options.config, "invalid_response");

  const triggered = parsed.risks
    .filter(
      (risk) => risk.probability >= options.config.thresholds.reviewProbability,
    )
    .sort((left, right) => right.probability - left.probability);
  const topProbability = parsed.risks.reduce(
    (highest, risk) => Math.max(highest, risk.probability),
    0,
  );
  const review =
    triggered.length > 0 ||
    parsed.severity >= options.config.thresholds.severityReview;
  const highRisk =
    topProbability >= options.config.thresholds.highRiskProbability ||
    parsed.severity >= 2;
  return {
    status: "evaluated",
    decision: review ? "confirm" : "allow",
    highRisk,
    triggered,
    severity: parsed.severity,
    model: parsed.model,
  };
}

function createSystemOneCall(
  apiKey: string,
  config: ToolGuardConfig,
): SystemOneCall {
  const client = new TypeSafeClient({
    apiKey,
    defaultModel: config.model,
    timeout: config.timeoutMs,
    retry: { maxRetries: 0 },
    logLevel: "off",
  });
  return (request, requestOptions) => client.systemOne(request, requestOptions);
}

function unavailable(
  config: ToolGuardConfig,
  failure: EvaluationFailure,
): RiskEvaluation {
  return {
    status: "unavailable",
    decision: config.evaluatorFailure === "allow" ? "allow" : "block",
    highRisk: false,
    triggered: [],
    failure,
  };
}

function parseResponse(response: unknown):
  | {
      model: string;
      severity: number;
      risks: TriggeredRisk[];
    }
  | undefined {
  if (
    !isRecord(response) ||
    typeof response.model !== "string" ||
    !isRecord(response.answers)
  )
    return undefined;
  const severityAnswer = response.answers.severity;
  if (
    !isRecord(severityAnswer) ||
    severityAnswer.type !== "score" ||
    !isRangeNumber(severityAnswer.score, 0, 3)
  ) {
    return undefined;
  }

  const risks: TriggeredRisk[] = [];
  for (const id of guardQuestionIds()) {
    const answer = response.answers[id];
    if (
      !isRecord(answer) ||
      answer.type !== "noul" ||
      !isRangeNumber(answer.noul, 0, 1)
    )
      return undefined;
    risks.push({ id, probability: answer.noul });
  }
  return { model: response.model, severity: severityAnswer.score, risks };
}

function guardQuestionIds(): GuardQuestionId[] {
  return [
    "intentMismatch",
    "excessiveScope",
    "sensitiveExposure",
    "destructiveChange",
    "externalImpact",
    "hardToReverse",
  ];
}

function toTypeSafeState(state: GuardState): EntryType {
  const recentConversation: JsonSafe[] = state.recentConversation.map(
    (message) => ({
      role: message.role,
      text: message.text,
    }),
  );
  return {
    cwd: state.cwd,
    userObjective: state.userObjective,
    recentConversation,
    pendingTool: {
      name: state.pendingTool.name,
      input: state.pendingTool.input,
      truncated: state.pendingTool.truncated,
    },
  };
}

function isRangeNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
