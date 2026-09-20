/// <reference types="node" />

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  formatToolGuardStatus,
  registerToolGuardCommand,
  runToolGuardCommand,
  type ToolGuardCommandContext,
} from "../src/command.ts";
import { resolveToolGuardConfig } from "../src/config.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function commandContext(options: {
  cwd: string;
  trusted?: boolean;
  edited?: string;
  confirmed?: boolean;
  onConfirm?: () => Promise<void>;
}) {
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses: string[] = [];
  const context: ToolGuardCommandContext = {
    cwd: options.cwd,
    isProjectTrusted: () => options.trusted ?? true,
    ui: {
      editor: async () => options.edited,
      confirm: async () => {
        await options.onConfirm?.();
        return options.confirmed ?? true;
      },
      notify: (message, level) => { notifications.push({ message, level: level ?? "info" }); },
      setStatus: (_id, status) => { if (status) statuses.push(status); },
    },
  };
  return { context, notifications, statuses };
}

async function temporaryLayout() {
  const root = await mkdtemp(join(tmpdir(), "pi-tool-guard-command-"));
  temporaryDirectories.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  return { root, agentDir, cwd, settingsPath: join(agentDir, "settings.json") };
}

test("registers /tool-guard with expected completions", () => {
  let command: { name: string; options: { getArgumentCompletions?: (prefix: string) => unknown } } | undefined;
  registerToolGuardCommand({
    registerCommand: (name, options) => { command = { name, options }; },
  });

  assert.equal(command?.name, "tool-guard");
  assert.deepEqual(command?.options.getArgumentCompletions?.("edit-"), [
    { value: "edit-global", label: "edit-global" },
    { value: "edit-project", label: "edit-project" },
  ]);
});

test("formats effective status with provenance but no credential value", () => {
  const status = formatToolGuardStatus(
    resolveToolGuardConfig({
      globalSettings: {
        toolGuard: {
          timeoutMs: 3000,
          rules: { allowedCommands: ["deploy npm_abcdefghijklmnopqrstuvwxyz"] },
        },
      },
    }),
    true,
  );

  assert.match(status, /timeoutMs = 3000 \[global\]/);
  assert.match(status, /thresholds\.reviewProbability = 0\.35 \[default\]/);
  assert.match(status, /Jev credential: present/);
  assert.doesNotMatch(status, /TYPESAFE_API_KEY|secret|npm_abcdefghijklmnopqrstuvwxyz/);
  assert.match(status, /REDACTED_NPM_TOKEN/);
});

test("status reports through Pi UI", async () => {
  const { agentDir, cwd } = await temporaryLayout();
  const { context, notifications } = commandContext({ cwd });

  await runToolGuardCommand("status", context, { agentDir });

  assert.equal(notifications.length, 1);
  assert.match(notifications[0]?.message ?? "", /Tool Guard: enabled/);
  assert.match(notifications[0]?.message ?? "", /timeoutMs = 2000 \[default\]/);
});

test("edits only the toolGuard global override and preserves unrelated settings", async () => {
  const { agentDir, cwd, settingsPath } = await temporaryLayout();
  await writeFile(settingsPath, JSON.stringify({ theme: "dark", toolGuard: { timeoutMs: 2500 } }));
  const { context, notifications } = commandContext({
    cwd,
    edited: '{"timeoutMs": 3500, "notifications": {"showAllowed": true}}',
    confirmed: true,
  });

  await runToolGuardCommand("edit-global", context, { agentDir });

  const saved = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.equal(saved.theme, "dark");
  assert.deepEqual(saved.toolGuard, { timeoutMs: 3500, notifications: { showAllowed: true } });
  assert.match(notifications.at(-1)?.message ?? "", /Saved Tool Guard global override/);
});

test("cancelling confirmation leaves settings unchanged", async () => {
  const { agentDir, cwd, settingsPath } = await temporaryLayout();
  const original = JSON.stringify({ toolGuard: { timeoutMs: 2500 } });
  await writeFile(settingsPath, original);
  const { context } = commandContext({ cwd, edited: '{"timeoutMs": 3500}', confirmed: false });

  await runToolGuardCommand("edit-global", context, { agentDir });

  assert.equal(await readFile(settingsPath, "utf8"), original);
});

test("detects a concurrent settings change instead of overwriting it", async () => {
  const { agentDir, cwd, settingsPath } = await temporaryLayout();
  await writeFile(settingsPath, JSON.stringify({ theme: "dark", toolGuard: { timeoutMs: 2500 } }));
  const concurrent = JSON.stringify({ theme: "light", toolGuard: { timeoutMs: 2600 } });
  const { context, notifications } = commandContext({
    cwd,
    edited: '{"timeoutMs": 3500}',
    onConfirm: async () => { await writeFile(settingsPath, concurrent); },
  });

  await runToolGuardCommand("edit-global", context, { agentDir });

  assert.equal(await readFile(settingsPath, "utf8"), concurrent);
  assert.match(notifications.at(-1)?.message ?? "", /changed while the editor was open/);
});

test("invalid edited settings do not modify the file or expose the content", async () => {
  const { agentDir, cwd, settingsPath } = await temporaryLayout();
  const original = JSON.stringify({ toolGuard: { timeoutMs: 2500 } });
  await writeFile(settingsPath, original);
  const { context, notifications } = commandContext({
    cwd,
    edited: '{"apiKey":"do-not-expose"}',
    confirmed: true,
  });

  await runToolGuardCommand("edit-global", context, { agentDir });

  assert.equal(await readFile(settingsPath, "utf8"), original);
  assert.match(notifications.at(-1)?.message ?? "", /invalid/);
  assert.doesNotMatch(JSON.stringify(notifications), /do-not-expose/);
});

test("refuses project edits when the project is untrusted", async () => {
  const { agentDir, cwd } = await temporaryLayout();
  const { context, notifications } = commandContext({ cwd, trusted: false, edited: "{}" });

  await runToolGuardCommand("edit-project", context, { agentDir });

  assert.match(notifications.at(-1)?.message ?? "", /require a trusted project/);
});
