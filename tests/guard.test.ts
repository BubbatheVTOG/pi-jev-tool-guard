/// <reference types="node" />

import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  resolveToolGuardConfig,
  type ResolvedToolGuardConfig,
} from "../src/config.ts";
import { createToolCallGuard, type GuardHookContext } from "../src/guard.ts";
import type { RiskEvaluation } from "../src/evaluator.ts";

function resolved(
  overrides: Record<string, unknown> = {},
): ResolvedToolGuardConfig {
  return resolveToolGuardConfig({ globalSettings: { toolGuard: overrides } });
}

function userEntry(text = "Update one test"): SessionEntry {
  return {
    type: "message",
    id: "user-1",
    parentId: null,
    timestamp: new Date(0).toISOString(),
    message: { role: "user", content: text, timestamp: 0 },
  };
}

function context(options: { hasUI?: boolean; confirm?: boolean } = {}) {
  const confirmations: Array<{ title: string; message: string }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses: string[] = [];
  const ctx: GuardHookContext = {
    cwd: "/workspace/example",
    hasUI: options.hasUI ?? true,
    signal: undefined,
    isProjectTrusted: () => true,
    sessionManager: { buildContextEntries: () => [userEntry()] },
    ui: {
      confirm: async (title, message) => {
        confirmations.push({ title, message });
        return options.confirm ?? true;
      },
      notify: (message, level) => {
        notifications.push({ message, level: level ?? "info" });
      },
      setStatus: (_id, status) => {
        if (status) statuses.push(status);
      },
    },
  };
  return { ctx, confirmations, notifications, statuses };
}

const safe: RiskEvaluation = {
  status: "evaluated",
  decision: "allow",
  highRisk: false,
  triggered: [],
  severity: 0.1,
  model: "jev-test",
};

const risky: RiskEvaluation = {
  status: "evaluated",
  decision: "confirm",
  highRisk: true,
  triggered: [{ id: "destructiveChange", probability: 0.91 }],
  severity: 2.3,
  model: "jev-test",
};

test("ignores tools outside the protected set without evaluating", async () => {
  let evaluations = 0;
  const guard = createToolCallGuard({
    loadConfig: async () => resolved(),
    evaluateRisk: async () => {
      evaluations += 1;
      return safe;
    },
    getApiKey: () => "test-key",
  });
  const { ctx } = context();

  assert.equal(
    await guard({ toolName: "read", input: { path: "a.ts" } }, ctx),
    undefined,
  );
  assert.equal(evaluations, 0);
});

test("does not finish preflight until Jev evaluation resolves", async () => {
  let resolveEvaluation: ((value: RiskEvaluation) => void) | undefined;
  const pendingEvaluation = new Promise<RiskEvaluation>((resolvePromise) => {
    resolveEvaluation = resolvePromise;
  });
  const guard = createToolCallGuard({
    loadConfig: async () => resolved(),
    evaluateRisk: async () => pendingEvaluation,
    getApiKey: () => "test-key",
  });
  const { ctx } = context();
  let settled = false;
  const preflight = guard(
    { toolName: "bash", input: { command: "printf ok" } },
    ctx,
  ).then((result) => {
    settled = true;
    return result;
  });

  await Promise.resolve();
  assert.equal(settled, false);
  assert.ok(resolveEvaluation);
  resolveEvaluation(safe);
  assert.equal(await preflight, undefined);
  assert.equal(settled, true);
});

test("allows low-risk calls without prompting", async () => {
  const guard = createToolCallGuard({
    loadConfig: async () => resolved(),
    evaluateRisk: async () => safe,
    getApiKey: () => "test-key",
  });
  const { ctx, confirmations } = context();

  assert.equal(
    await guard({ toolName: "edit", input: { path: "test.ts" } }, ctx),
    undefined,
  );
  assert.equal(confirmations.length, 0);
});

test("prompts for risky calls and blocks a user denial with redacted input", async () => {
  const guard = createToolCallGuard({
    loadConfig: async () => resolved(),
    evaluateRisk: async () => risky,
    getApiKey: () => "test-key",
  });
  const { ctx, confirmations } = context({ confirm: false });
  const result = await guard(
    { toolName: "bash", input: { command: "deploy", apiKey: "do-not-show" } },
    ctx,
  );

  assert.deepEqual(result, {
    block: true,
    reason: "Risky bash call denied by the user.",
  });
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0]?.title ?? "", /high-risk bash/);
  assert.match(confirmations[0]?.message ?? "", /destructive change 91%/);
  assert.doesNotMatch(confirmations[0]?.message ?? "", /do-not-show/);
});

test("blocks risky calls in headless mode", async () => {
  const guard = createToolCallGuard({
    loadConfig: async () => resolved(),
    evaluateRisk: async () => risky,
    getApiKey: () => "test-key",
  });
  const { ctx } = context({ hasUI: false });

  assert.deepEqual(
    await guard({ toolName: "write", input: { path: "a.ts" } }, ctx),
    {
      block: true,
      reason:
        "Risky write call blocked because confirmation UI is unavailable.",
    },
  );
});

test("an explicit disable setting bypasses evaluation", async () => {
  let evaluations = 0;
  const guard = createToolCallGuard({
    loadConfig: async () => resolved({ disable: true }),
    evaluateRisk: async () => {
      evaluations += 1;
      return safe;
    },
    getApiKey: () => "test-key",
  });
  const { ctx, statuses } = context();

  assert.equal(
    await guard({ toolName: "bash", input: { command: "printf ok" } }, ctx),
    undefined,
  );
  assert.equal(evaluations, 0);
  assert.ok(statuses.includes("guard: disabled"));
});

test("a missing API key fails open while the guard remains enabled", async () => {
  const guard = createToolCallGuard({
    loadConfig: async () => resolved(),
    getApiKey: () => undefined,
  });
  const { ctx, notifications, statuses } = context();

  assert.equal(
    await guard({ toolName: "bash", input: { command: "printf one" } }, ctx),
    undefined,
  );
  assert.equal(
    await guard({ toolName: "bash", input: { command: "printf two" } }, ctx),
    undefined,
  );
  assert.equal(
    notifications.filter((item) => item.level === "warning").length,
    1,
  );
  assert.ok(statuses.includes("guard: enabled; API key missing"));
});

test("unexpected context or evaluator failures follow the configured fail-open policy", async () => {
  const guard = createToolCallGuard({
    loadConfig: async () => resolved(),
    evaluateRisk: async () => {
      throw new Error("unexpected private failure");
    },
    getApiKey: () => "test-key",
  });
  const { ctx, notifications } = context();

  assert.equal(
    await guard({ toolName: "bash", input: { command: "printf ok" } }, ctx),
    undefined,
  );
  assert.match(notifications.at(-1)?.message ?? "", /request failed/);
  assert.doesNotMatch(
    JSON.stringify(notifications),
    /unexpected private failure/,
  );
});

test("invalid settings block protected calls without leaking values", async () => {
  const guard = createToolCallGuard({
    loadConfig: async () => {
      throw new Error("private settings contents");
    },
  });
  const { ctx } = context();

  const result = await guard(
    { toolName: "bash", input: { command: "printf ok" } },
    ctx,
  );
  assert.equal(result?.block, true);
  assert.doesNotMatch(result?.reason ?? "", /private settings contents/);
});

test("explicit protected path takes precedence over an allowed path", async () => {
  let evaluations = 0;
  const guard = createToolCallGuard({
    loadConfig: async () =>
      resolved({
        rules: { protectedPaths: ["config"], allowedPaths: ["config"] },
      }),
    evaluateRisk: async () => {
      evaluations += 1;
      return safe;
    },
    getApiKey: () => "test-key",
  });
  const { ctx, confirmations } = context({ confirm: true });

  assert.equal(
    await guard({ toolName: "write", input: { path: "config/app.json" } }, ctx),
    undefined,
  );
  assert.equal(confirmations.length, 1);
  assert.equal(evaluations, 0);
});
