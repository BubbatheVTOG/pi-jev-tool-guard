import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  loadToolGuardConfig,
  parseToolGuardOverride,
  type ConfigSource,
  type ResolvedToolGuardConfig,
} from "./config.ts";
import { redactSecrets } from "./context.ts";
import { updateGuardStatus } from "./guard.ts";

export type ToolGuardCommandAction = "status" | "edit-global" | "edit-project";

export interface ToolGuardCommandContext {
  cwd: string;
  isProjectTrusted(): boolean;
  ui: Pick<
    ExtensionCommandContext["ui"],
    "confirm" | "editor" | "notify" | "setStatus"
  >;
}

export function registerToolGuardCommand(
  pi: Pick<ExtensionAPI, "registerCommand">,
): void {
  pi.registerCommand("tool-guard", {
    description: "Inspect or edit Tool Guard policy overrides",
    getArgumentCompletions: (prefix) => {
      const actions: ToolGuardCommandAction[] = [
        "status",
        "edit-global",
        "edit-project",
      ];
      const matches = actions.filter((action) => action.startsWith(prefix));
      return matches.length > 0
        ? matches.map((value) => ({ value, label: value }))
        : null;
    },
    handler: async (args, ctx) =>
      runToolGuardCommand(normalizeAction(args), ctx),
  });
}

export async function runToolGuardCommand(
  action: ToolGuardCommandAction,
  ctx: ToolGuardCommandContext,
  options: { agentDir?: string } = {},
): Promise<void> {
  const agentDir = options.agentDir ?? getAgentDir();
  if (action === "status") {
    await showStatus(ctx, agentDir);
    return;
  }
  if (action === "edit-project" && !ctx.isProjectTrusted()) {
    ctx.ui.notify(
      "Tool Guard project overrides require a trusted project.",
      "error",
    );
    return;
  }

  const source: ConfigSource = action === "edit-global" ? "global" : "project";
  const path =
    source === "global"
      ? join(agentDir, "settings.json")
      : join(ctx.cwd, CONFIG_DIR_NAME, "settings.json");
  let document: SettingsDocument;
  let edited: string | undefined;
  try {
    document = await readSettingsDocument(path, source);
    const current = isRecord(document.settings.toolGuard)
      ? document.settings.toolGuard
      : {};
    edited = await ctx.ui.editor(
      `Tool Guard ${source} override`,
      `${JSON.stringify(current, null, 2)}\n`,
    );
  } catch {
    ctx.ui.notify(
      `Unable to read Tool Guard ${source} settings; no settings were changed.`,
      "error",
    );
    return;
  }
  if (edited === undefined) return;
  const current = isRecord(document.settings.toolGuard)
    ? document.settings.toolGuard
    : {};

  let override: Record<string, unknown>;
  try {
    const parsed: unknown = edited.trim() === "" ? {} : JSON.parse(edited);
    if (!isRecord(parsed)) throw new Error("override must be an object");
    override = parsed;
    parseToolGuardOverride({ toolGuard: override }, source);
  } catch {
    ctx.ui.notify(
      `Tool Guard ${source} override is invalid; no settings were changed.`,
      "error",
    );
    return;
  }

  if (JSON.stringify(current) === JSON.stringify(override)) {
    ctx.ui.notify("Tool Guard override is unchanged.", "info");
    return;
  }
  const confirmed = await ctx.ui.confirm(
    `Save Tool Guard ${source} override?`,
    `Write validated overrides to ${path}?`,
  );
  if (!confirmed) return;

  if (Object.keys(override).length === 0) delete document.settings.toolGuard;
  else document.settings.toolGuard = override;
  try {
    const written = await writeSettingsDocument(
      path,
      document.settings,
      document.revision,
    );
    if (!written) {
      ctx.ui.notify(
        `Tool Guard ${source} settings changed while the editor was open; no settings were written.`,
        "error",
      );
      return;
    }
    const resolved = await loadToolGuardConfig({
      cwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted(),
      agentDir,
    });
    updateGuardStatus(ctx, resolved.config, process.env.TYPESAFE_API_KEY);
    ctx.ui.notify(
      `Saved Tool Guard ${source} override. New tool calls use it immediately.`,
      "info",
    );
  } catch {
    ctx.ui.notify(
      `Unable to save Tool Guard ${source} override; existing settings were preserved.`,
      "error",
    );
  }
}

export function formatToolGuardStatus(
  resolved: ResolvedToolGuardConfig,
  apiKeyPresent: boolean,
): string {
  const lines = [
    `Tool Guard: ${resolved.config.disable || !resolved.config.enabled ? "disabled" : "enabled"}`,
    `Jev credential: ${apiKeyPresent ? "present" : "missing (evaluatorFailure applies)"}`,
    `Trusted project override: ${resolved.projectOverrideApplied ? "applied" : "not applied"}`,
    "",
  ];
  for (const [path, value] of flattenConfig(resolved.config)) {
    lines.push(
      `${path} = ${JSON.stringify(redactSecrets(value))} [${resolved.provenance[path] ?? "default"}]`,
    );
  }
  return lines.join("\n");
}

async function showStatus(
  ctx: ToolGuardCommandContext,
  agentDir: string,
): Promise<void> {
  try {
    const resolved = await loadToolGuardConfig({
      cwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted(),
      agentDir,
    });
    ctx.ui.notify(
      formatToolGuardStatus(
        resolved,
        Boolean(process.env.TYPESAFE_API_KEY?.trim()),
      ),
      "info",
    );
  } catch {
    ctx.ui.notify(
      "Tool Guard settings are invalid. Protected calls are blocked until they are corrected.",
      "error",
    );
  }
}

function normalizeAction(args: string): ToolGuardCommandAction {
  const action = args.trim();
  if (action === "edit-global" || action === "edit-project") return action;
  return "status";
}

interface SettingsDocument {
  settings: Record<string, unknown>;
  revision: string | null;
}

async function readSettingsDocument(
  path: string,
  source: ConfigSource,
): Promise<SettingsDocument> {
  const text = await readSettingsRevision(path);
  if (text === null) return { settings: {}, revision: null };

  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error("settings root must be an object");
    return { settings: parsed, revision: text };
  } catch {
    throw new Error(`tool-guard: invalid JSON in ${source} settings`);
  }
}

async function readSettingsRevision(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeSettingsDocument(
  path: string,
  settings: Record<string, unknown>,
  expectedRevision: string | null,
): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  const mode = await existingMode(path);
  const temporaryPath = join(dirname(path), `.${randomUUID()}-tool-guard.tmp`);
  const lockPath = `${path}.tool-guard.lock`;
  const lock = await open(lockPath, "wx", 0o600);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
      flag: "wx",
      mode,
    });
    if ((await readSettingsRevision(path)) !== expectedRevision) return false;
    await rename(temporaryPath, path);
    return true;
  } finally {
    const closed = await Promise.allSettled([lock.close()]);
    const cleanup = await Promise.allSettled([
      rm(temporaryPath, { force: true }),
      rm(lockPath, { force: true }),
    ]);
    if (
      [...closed, ...cleanup].some((result) => result.status === "rejected")
    ) {
      throw new Error(
        "tool-guard: unable to clean up the settings transaction",
      );
    }
  }
}

async function existingMode(path: string): Promise<number> {
  try {
    return (await stat(path)).mode & 0o777;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return 0o600;
    throw error;
  }
}

function flattenConfig(
  value: Record<string, unknown> | object,
  prefix = "",
): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isRecord(child) && !Array.isArray(child))
      entries.push(...flattenConfig(child, path));
    else entries.push([path, child]);
  }
  return entries;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
