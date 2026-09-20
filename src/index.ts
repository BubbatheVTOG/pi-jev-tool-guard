import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerToolGuardCommand } from "./command.ts";
import { loadToolGuardConfig } from "./config.ts";
import { createToolCallGuard, updateGuardStatus } from "./guard.ts";

export default function toolGuard(pi: ExtensionAPI): void {
  registerToolGuardCommand(pi);
  const loadConfig = (
    ctx: Parameters<ReturnType<typeof createToolCallGuard>>[1],
  ) =>
    loadToolGuardConfig({
      cwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted(),
    });
  const guard = createToolCallGuard({ loadConfig });

  pi.on("session_start", async (_event, ctx) => {
    try {
      const resolved = await loadToolGuardConfig({
        cwd: ctx.cwd,
        projectTrusted: ctx.isProjectTrusted(),
      });
      updateGuardStatus(ctx, resolved.config, process.env.TYPESAFE_API_KEY);
    } catch {
      ctx.ui.setStatus("tool-guard", "guard: invalid settings");
      if (ctx.hasUI)
        ctx.ui.notify(
          "Tool Guard settings are invalid; protected calls will be blocked.",
          "error",
        );
    }
  });

  pi.on("tool_call", async (event, ctx) => guard(event, ctx));
}
