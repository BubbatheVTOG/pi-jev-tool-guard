/// <reference types="node" />

import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { buildGuardState, redactSecrets } from "../src/context.ts";

function contextWith(entries: SessionEntry[]) {
  return {
    cwd: "/workspace/example",
    sessionManager: { buildContextEntries: () => entries },
  };
}

function userEntry(id: string, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    message: { role: "user", content: text, timestamp: 0 },
  };
}

function toolResultEntry(id: string, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: 0,
    },
  };
}

test("builds bounded context from the active branch and excludes tool results by default", () => {
  const entries = [
    userEntry("one", "old objective"),
    toolResultEntry("two", "SECRET_RESULT"),
    userEntry("three", "current objective"),
  ];
  const state = buildGuardState({
    ctx: contextWith(entries),
    toolName: "bash",
    input: { command: "printf ok" },
    config: { ...DEFAULT_CONFIG.context, recentMessages: 2 },
  });

  assert.equal(state.userObjective, "current objective");
  assert.equal(state.recentConversation.some((message) => message.text.includes("SECRET_RESULT")), false);
  assert.equal(state.pendingTool.name, "bash");
  assert.match(state.pendingTool.input, /printf ok/);
});

test("includes tool results only when configured", () => {
  const state = buildGuardState({
    ctx: contextWith([toolResultEntry("one", "useful output"), userEntry("two", "continue")]),
    toolName: "edit",
    input: { path: "a.ts" },
    config: { ...DEFAULT_CONFIG.context, includeToolResults: true },
  });

  assert.equal(state.recentConversation[0]?.role, "toolResult");
  assert.equal(state.recentConversation[0]?.text, "useful output");
});

test("redacts structured and embedded credentials before serialization", () => {
  const value = redactSecrets({
    apiKey: "top-secret",
    command: "export TYPESAFE_API_KEY=visible-secret && curl -H 'Authorization: Bearer abc.def-123' https://example.test",
    nested: { password: "hunter2", url: "https://user:password@example.test/path" },
  });
  const serialized = JSON.stringify(value);

  assert.doesNotMatch(serialized, /top-secret|visible-secret|hunter2|abc\.def-123|user:password/);
  assert.match(serialized, /REDACTED/);
});

test("truncates oversized input while retaining both ends", () => {
  const huge = `BEGIN-${"x".repeat(6000)}-END`;
  const state = buildGuardState({
    ctx: contextWith([userEntry("one", "write the generated file")]),
    toolName: "write",
    input: { path: "generated.txt", content: huge },
    config: { ...DEFAULT_CONFIG.context, maxCharacters: 1200 },
  });

  assert.equal(state.pendingTool.truncated, true);
  assert.match(state.pendingTool.input, /BEGIN-/);
  assert.match(state.pendingTool.input, /-END/);
  assert.match(state.pendingTool.input, /TRUNCATED/);
  assert.ok(JSON.stringify(state).length <= 1200);
});
