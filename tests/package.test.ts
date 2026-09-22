/// <reference types="node" />

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const packageJsonUrl = new URL("../package.json", import.meta.url);
const readmeUrl = new URL("../README.md", import.meta.url);

test("declares a discoverable Pi extension package", async () => {
  const manifest = JSON.parse(await readFile(packageJsonUrl, "utf8"));

  assert.equal(manifest.name, "pi-jev-tool-guard");
  assert.deepEqual(manifest.pi?.extensions, ["./src/index.ts"]);
  assert.equal(manifest.dependencies?.["@typesafe-ai/sdk"], "^0.6.0");
});

test("README documents every public Tool Guard setting", async () => {
  const readme = await readFile(readmeUrl, "utf8");
  for (const key of [
    "disable",
    "enabled",
    "protectedTools",
    "model",
    "timeoutMs",
    "evaluatorFailure",
    "headlessRisk",
    "threshold",
    "toolThresholds",
    "context.recentMessages",
    "context.maxCharacters",
    "context.redactSecrets",
    "context.includeToolResults",
    "rules.protectedPaths",
    "rules.allowedPaths",
    "rules.alwaysConfirmCommands",
    "rules.allowedCommands",
    "rules.denyCommands",
    "notifications.showAllowed",
    "notifications.showEvaluatorFailures",
    "notifications.showProjectOverride",
    "projectOverrides",
  ]) {
    assert.ok(readme.includes(`\`${key}\``), `README is missing ${key}`);
  }
  assert.match(readme, /Built-in bash review categories/);
  assert.match(readme, /integer 1–10/i);
});

test("extension factory module loads", async () => {
  const { default: factory } = await import("../src/index.ts");
  assert.equal(typeof factory, "function");
});
