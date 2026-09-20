/// <reference types="node" />

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveToolGuardConfig } from "../src/config.ts";
import { evaluateToolRisk, type RiskEvaluation } from "../src/evaluator.ts";
import type { GuardState } from "../src/context.ts";

const state: GuardState = {
  cwd: "/workspace/example",
  userObjective: "Update one test",
  recentConversation: [{ role: "user", text: "Update one test" }],
  pendingTool: { name: "edit", input: '{"path":"test.ts"}', truncated: false },
};

function config(overrides: Record<string, unknown> = {}) {
  return resolveToolGuardConfig({ globalSettings: { toolGuard: overrides } }).config;
}

function response(values: Partial<Record<string, number>> = {}) {
  const noul = (id: string) => ({ type: "noul", noul: values[id] ?? 0.05 });
  return {
    model: "jev-test",
    answers: {
      intentMismatch: noul("intentMismatch"),
      excessiveScope: noul("excessiveScope"),
      sensitiveExposure: noul("sensitiveExposure"),
      destructiveChange: noul("destructiveChange"),
      externalImpact: noul("externalImpact"),
      hardToReverse: noul("hardToReverse"),
      severity: { type: "score", score: values.severity ?? 0.2, confidence: 0.9, legend: {}, probabilities: {} },
    },
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

test("allows a low-risk assessed call and forwards model, timeout, and state", async () => {
  let capturedRequest: unknown;
  let capturedOptions: unknown;
  const result = await evaluateToolRisk({
    state,
    config: config(),
    apiKey: "test-key",
    systemOne: async (request, options) => {
      capturedRequest = request;
      capturedOptions = options;
      return response();
    },
  });

  assert.equal(result.status, "evaluated");
  assert.equal(result.decision, "allow");
  assert.equal(result.highRisk, false);
  assert.deepEqual(result.triggered, []);
  assert.deepEqual(capturedOptions, { timeout: 2000, retry: { maxRetries: 0 } });
  assert.equal((capturedRequest as { model: string }).model, "jev-latest");
});

test("requires confirmation when any hazard or severity crosses review policy", async () => {
  const result = await evaluateToolRisk({
    state,
    config: config(),
    apiKey: "test-key",
    systemOne: async () => response({ destructiveChange: 0.82, externalImpact: 0.5, severity: 2.2 }),
  });

  assert.equal(result.decision, "confirm");
  assert.equal(result.highRisk, true);
  assert.deepEqual(result.triggered.map((risk) => risk.id), ["destructiveChange", "externalImpact"]);
  assert.equal(result.severity, 2.2);
});

test("fails open when the API key is missing", async () => {
  const result = await evaluateToolRisk({ state, config: config(), apiKey: "" });

  assert.deepEqual(result, {
    status: "unavailable",
    decision: "allow",
    highRisk: false,
    triggered: [],
    failure: "missing_api_key",
  });
});

test("supports an explicit fail-closed override", async () => {
  const result = await evaluateToolRisk({
    state,
    config: config({ evaluatorFailure: "block" }),
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.decision, "block");
});

for (const [name, run, expected] of [
  ["request errors", async () => { throw new Error("private service details"); }, "request_failed"],
  ["invalid responses", async () => ({ answers: {} }), "invalid_response"],
] as const) {
  test(`${name} fail open without exposing service details`, async () => {
    const result: RiskEvaluation = await evaluateToolRisk({
      state,
      config: config(),
      apiKey: "test-key",
      systemOne: run,
    });
    assert.equal(result.status, "unavailable");
    assert.equal(result.decision, "allow");
    assert.equal(result.failure, expected);
    assert.doesNotMatch(JSON.stringify(result), /private service details/);
  });
}

test("propagates cancellation and classifies an aborted request", async () => {
  const controller = new AbortController();
  const result = await evaluateToolRisk({
    state,
    config: config(),
    apiKey: "test-key",
    signal: controller.signal,
    systemOne: async (_request, options) => {
      assert.equal(options?.signal, controller.signal);
      controller.abort();
      throw new Error("cancelled");
    },
  });

  assert.equal(result.failure, "cancelled");
  assert.equal(result.decision, "allow");
});
