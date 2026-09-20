/// <reference types="node" />

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const packageJsonUrl = new URL("../package.json", import.meta.url);

test("declares a discoverable Pi extension package", async () => {
  const manifest = JSON.parse(await readFile(packageJsonUrl, "utf8"));

  assert.equal(manifest.name, "pi-jev-tool-guard");
  assert.deepEqual(manifest.pi?.extensions, ["./src/index.ts"]);
  assert.equal(manifest.dependencies?.["@typesafe-ai/sdk"], "^0.6.0");
});

test("extension factory module loads", async () => {
  const { default: factory } = await import("../src/index.ts");
  assert.equal(typeof factory, "function");
});
