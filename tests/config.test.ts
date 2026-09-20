import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  DEFAULT_CONFIG,
  loadToolGuardConfig,
  parseToolGuardOverride,
  resolveToolGuardConfig,
} from "../src/config.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

test("uses complete immutable defaults when settings are absent", () => {
  const resolved = resolveToolGuardConfig();

  assert.deepEqual(resolved.config, {
    enabled: true,
    protectedTools: ["bash", "write", "edit"],
    model: "jev-latest",
    timeoutMs: 2000,
    evaluatorFailure: "allow",
    headlessRisk: "block",
    thresholds: { reviewProbability: 0.35, highRiskProbability: 0.7, severityReview: 1 },
    context: { recentMessages: 6, maxCharacters: 12_000, redactSecrets: true, includeToolResults: false },
    rules: { protectedPaths: [], allowedPaths: [], alwaysConfirmCommands: [], allowedCommands: [] },
    notifications: { showAllowed: false, showEvaluatorFailures: true, showProjectOverride: true },
    projectOverrides: "full",
  });
  assert.equal(Object.isFrozen(DEFAULT_CONFIG), true);
  assert.equal(Object.isFrozen(DEFAULT_CONFIG.thresholds), true);
  assert.equal(resolved.provenance["timeoutMs"], "default");
  assert.equal(resolved.provenance["thresholds.reviewProbability"], "default");
});

test("deep-merges partial global settings over defaults", () => {
  const resolved = resolveToolGuardConfig({
    globalSettings: { toolGuard: { timeoutMs: 3000, thresholds: { reviewProbability: 0.4 } } },
  });

  assert.equal(resolved.config.timeoutMs, 3000);
  assert.deepEqual(resolved.config.thresholds, {
    reviewProbability: 0.4,
    highRiskProbability: 0.7,
    severityReview: 1,
  });
  assert.equal(resolved.provenance.timeoutMs, "global");
  assert.equal(resolved.provenance["thresholds.reviewProbability"], "global");
  assert.equal(resolved.provenance["thresholds.highRiskProbability"], "default");
});

test("arrays replace defaults rather than append", () => {
  const resolved = resolveToolGuardConfig({
    globalSettings: {
      toolGuard: {
        protectedTools: ["bash"],
        rules: { protectedPaths: [".env"] },
      },
    },
  });

  assert.deepEqual(resolved.config.protectedTools, ["bash"]);
  assert.deepEqual(resolved.config.rules.protectedPaths, [".env"]);
  assert.equal(resolved.provenance.protectedTools, "global");
  assert.equal(resolved.provenance["rules.protectedPaths"], "global");
});

test("trusted projects may fully override and weaken global policy", () => {
  const resolved = resolveToolGuardConfig({
    globalSettings: { toolGuard: { enabled: true, evaluatorFailure: "block" } },
    projectSettings: { toolGuard: { enabled: false, evaluatorFailure: "allow", protectedTools: [] } },
    projectTrusted: true,
  });

  assert.equal(resolved.config.enabled, false);
  assert.equal(resolved.config.evaluatorFailure, "allow");
  assert.deepEqual(resolved.config.protectedTools, []);
  assert.equal(resolved.projectOverrideApplied, true);
  assert.equal(resolved.provenance.enabled, "project");
});

test("ignores project settings unless trusted and globally allowed", () => {
  const untrusted = resolveToolGuardConfig({
    projectSettings: { toolGuard: { enabled: false } },
    projectTrusted: false,
  });
  assert.equal(untrusted.config.enabled, true);
  assert.equal(untrusted.projectOverrideApplied, false);

  const disabled = resolveToolGuardConfig({
    globalSettings: { toolGuard: { projectOverrides: "none" } },
    projectSettings: { toolGuard: { enabled: false } },
    projectTrusted: true,
  });
  assert.equal(disabled.config.enabled, true);
  assert.equal(disabled.config.projectOverrides, "none");
});

test("rejects unknown, malformed, duplicate, and out-of-range settings", () => {
  assert.throws(
    () => parseToolGuardOverride({ toolGuard: { surprise: true } }, "global"),
    /unknown setting global\.toolGuard\.surprise/,
  );
  assert.throws(
    () => parseToolGuardOverride({ toolGuard: { timeoutMs: "slow" } }, "global"),
    /timeoutMs must be an integer/,
  );
  assert.throws(
    () => parseToolGuardOverride({ toolGuard: { protectedTools: ["bash", "bash"] } }, "global"),
    /must not contain duplicates/,
  );
  assert.throws(
    () => parseToolGuardOverride({ toolGuard: { protectedTools: ["read"] } }, "global"),
    /contains unsupported tool/,
  );
  assert.throws(
    () => resolveToolGuardConfig({ globalSettings: { toolGuard: { thresholds: { reviewProbability: 0.8 } } } }),
    /reviewProbability must not exceed highRiskProbability/,
  );
});

test("loads global and trusted project files with sanitized errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tool-guard-config-"));
  temporaryDirectories.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ toolGuard: { timeoutMs: 2500 } }));
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ toolGuard: { timeoutMs: 3500 } }));

  const resolved = await loadToolGuardConfig({ cwd, projectTrusted: true, agentDir });
  assert.equal(resolved.config.timeoutMs, 3500);
  assert.equal(resolved.provenance.timeoutMs, "project");

  await writeFile(join(agentDir, "settings.json"), '{"private":"do-not-print",');
  await assert.rejects(
    loadToolGuardConfig({ cwd, projectTrusted: true, agentDir }),
    (error: unknown) => {
      assert.match(String(error), /invalid JSON in global settings/);
      assert.doesNotMatch(String(error), /do-not-print/);
      return true;
    },
  );
});
