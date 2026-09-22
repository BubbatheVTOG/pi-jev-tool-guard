import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  DEFAULT_CONFIG,
  deriveThresholds,
  effectiveThresholds,
  effectiveToolThreshold,
  loadToolGuardConfig,
  parseToolGuardOverride,
  resolveToolGuardConfig,
} from "../src/config.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

test("uses complete immutable defaults when settings are absent", () => {
  const resolved = resolveToolGuardConfig();

  assert.deepEqual(resolved.config, {
    disable: false,
    enabled: true,
    protectedTools: ["bash", "write", "edit"],
    model: "jev-latest",
    timeoutMs: 2000,
    evaluatorFailure: "allow",
    headlessRisk: "block",
    threshold: 5,
    toolThresholds: {},
    thresholds: {
      reviewProbability: 0.6,
      highRiskProbability: 0.65,
      severityReview: 2,
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
      denyCommands: [],
    },
    notifications: {
      showAllowed: false,
      showEvaluatorFailures: true,
      showProjectOverride: true,
    },
    projectOverrides: "full",
  });
  assert.equal(Object.isFrozen(DEFAULT_CONFIG), true);
  assert.equal(Object.isFrozen(DEFAULT_CONFIG.thresholds), true);
  assert.equal(resolved.provenance["timeoutMs"], "default");
  assert.equal(resolved.provenance["threshold"], "default");
  assert.equal(resolved.provenance["thresholds.reviewProbability"], "derived");
});

test("derives review thresholds from the threshold scale with per-tool boost", () => {
  assert.deepEqual(deriveThresholds(1), {
    reviewProbability: 0.9,
    highRiskProbability: 0.95,
    severityReview: 3,
  });
  assert.deepEqual(deriveThresholds(10), {
    reviewProbability: 0.1,
    highRiskProbability: 0.15,
    severityReview: 1,
  });

  const base = resolveToolGuardConfig().config;
  assert.equal(effectiveToolThreshold(base, "bash"), 8); // 5 + built-in boost
  assert.equal(effectiveToolThreshold(base, "write"), 5);
  assert.equal(effectiveToolThreshold(base, "edit"), 5);

  const high = resolveToolGuardConfig({
    globalSettings: { toolGuard: { threshold: 10 } },
  }).config;
  assert.equal(effectiveToolThreshold(high, "bash"), 10); // boost clamped
});

test("supports an explicit disable setting", () => {
  const resolved = resolveToolGuardConfig({
    globalSettings: { toolGuard: { disable: true } },
  });

  assert.equal(resolved.config.disable, true);
  assert.equal(resolved.provenance.disable, "global");
});

test("applies the threshold scale and per-tool overrides", () => {
  const resolved = resolveToolGuardConfig({
    globalSettings: {
      toolGuard: {
        timeoutMs: 3000,
        threshold: 8,
        toolThresholds: { write: 2 },
      },
    },
  });

  assert.equal(resolved.config.timeoutMs, 3000);
  assert.equal(resolved.config.threshold, 8);
  assert.deepEqual(resolved.config.toolThresholds, { write: 2 });
  // The resolved concrete thresholds follow the base level.
  assert.deepEqual(resolved.config.thresholds, {
    reviewProbability: 0.3,
    highRiskProbability: 0.35,
    severityReview: 1,
  });
  // An explicit per-tool level replaces the base for that tool.
  assert.deepEqual(effectiveThresholds(resolved.config, "write"), {
    reviewProbability: 0.85,
    highRiskProbability: 0.9,
    severityReview: 3,
  });
  // Without an explicit level, bash gets base + built-in boost (clamped).
  assert.deepEqual(effectiveThresholds(resolved.config, "bash"), {
    reviewProbability: 0.1,
    highRiskProbability: 0.15,
    severityReview: 1,
  });
  assert.equal(resolved.provenance.timeoutMs, "global");
  assert.equal(resolved.provenance.threshold, "global");
  assert.equal(resolved.provenance["toolThresholds.write"], "global");
  assert.equal(resolved.provenance["thresholds.reviewProbability"], "derived");
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
    projectSettings: {
      toolGuard: {
        enabled: false,
        evaluatorFailure: "allow",
        protectedTools: [],
      },
    },
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
    () =>
      parseToolGuardOverride({ toolGuard: { timeoutMs: "slow" } }, "global"),
    /timeoutMs must be an integer/,
  );
  assert.throws(
    () =>
      parseToolGuardOverride(
        { toolGuard: { protectedTools: ["bash", "bash"] } },
        "global",
      ),
    /must not contain duplicates/,
  );
  assert.throws(
    () =>
      parseToolGuardOverride(
        { toolGuard: { protectedTools: ["read"] } },
        "global",
      ),
    /contains unsupported tool/,
  );
  assert.throws(
    () =>
      resolveToolGuardConfig({
        globalSettings: {
          toolGuard: { thresholds: { reviewProbability: 0.8 } },
        },
      }),
    /unknown setting global\.toolGuard\.thresholds/,
  );
  assert.throws(
    () => parseToolGuardOverride({ toolGuard: { threshold: 11 } }, "global"),
    /threshold must be an integer from 1 to 10/,
  );
  assert.throws(
    () =>
      parseToolGuardOverride(
        { toolGuard: { toolThresholds: { read: 5 } } },
        "global",
      ),
    /toolThresholds contains unsupported tool read/,
  );
  assert.throws(
    () =>
      parseToolGuardOverride(
        { toolGuard: { toolThresholds: { bash: 11 } } },
        "global",
      ),
    /toolThresholds\.bash must be an integer from 1 to 10/,
  );
});

test("loads global and trusted project files with sanitized errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tool-guard-config-"));
  temporaryDirectories.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ toolGuard: { timeoutMs: 2500 } }),
  );
  await writeFile(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({ toolGuard: { timeoutMs: 3500 } }),
  );

  const resolved = await loadToolGuardConfig({
    cwd,
    projectTrusted: true,
    agentDir,
  });
  assert.equal(resolved.config.timeoutMs, 3500);
  assert.equal(resolved.provenance.timeoutMs, "project");

  await writeFile(
    join(agentDir, "settings.json"),
    '{"private":"do-not-print",',
  );
  await assert.rejects(
    loadToolGuardConfig({ cwd, projectTrusted: true, agentDir }),
    (error: unknown) => {
      assert.match(String(error), /invalid JSON in global settings/);
      assert.doesNotMatch(String(error), /do-not-print/);
      return true;
    },
  );
});
