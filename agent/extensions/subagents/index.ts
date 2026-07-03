import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { SessionTotals, SubStats } from "./types";
import { readSubagentModels } from "./config";
import { buildPrompt, runSubagent, SESSION_ID_RE } from "./runner";
import { findSessionDir, openSubagentPicker, stampBranchedFrom } from "./sessions";
import {
  failure,
  footerStatus,
  plainTelemetry,
  plural,
  renderCall,
  renderResult,
} from "./render";

/**
 * subagent — delegate a self-contained task to an isolated `pi` process.
 *
 * The subagent runs in its own context window and returns ONLY its final
 * assistant text to the main agent. All intermediate work (tool calls, tool
 * output, thinking, retries) stays in the subagent's own session and never
 * enters the main agent's context. Live telemetry (turns / tools / cost) is
 * shown to the human via a TUI widget, not fed to the model.
 *
 * Configuration lives in `subagentModels` (see ./config) — a map of model id to
 * description, whose first entry is the default. If the key is absent the tool
 * is NOT registered (disabled silently, no fallback). If present but malformed,
 * the tool is disabled and the user is warned at session start.
 *
 * Recursion: subagents are spawned with `PI_SUBAGENT=1`, which causes this
 * extension to return early — the subagent tool is never registered inside a
 * subagent.
 *
 * Sandboxing: the child is spawned directly (bypassing the sandboxed bash tool),
 * so it would otherwise run unsandboxed. We require `npm:pi-sandbox` to be
 * installed in `~/.pi/agent/npm/node_modules` (where it lands when listed in
 * settings.json `packages`). The child spawns with the standard global config,
 * which loads pi-sandbox automatically from that packages list and sandboxes
 * ITSELF. In --mode json there is no UI, so pi-sandbox is deny-by-default:
 * anything not pre-allowed in sandbox.json is aborted rather than prompted.
 *
 * Resume: every result footer carries the subagent's session id (e.g.
 * `sub-1a2b3c4d`). Passing that id back as the `resume` parameter re-opens
 * that subagent with its full prior context (idempotent `--session-id`). Resume
 * is retrieval-only: ask a finished subagent for information it already holds
 * rather than to do new work. Prompt-cache hits are a bonus.
 *
 * Module layout:
 *   - config.ts    — read & validate `subagentModels` from settings.json
 *   - types.ts     — shared telemetry / option types
 *   - runner.ts    — spawn the child `pi`, parse its JSON event stream
 *   - render.ts    — turn stats into TUI widgets (all theme logic lives here)
 *   - sessions.ts  — subagent session dir plumbing + the browse/resume picker
 *   - index.ts     — wire it together and register the tool
 */
export default function (pi: ExtensionAPI) {
  // Never expose the subagent tool inside a subagent.
  if (process.env.PI_SUBAGENT) return;

  const cfg = readSubagentModels();
  if (cfg.status === "disabled") return; // no subagentModels key — silent, no fallback
  if (cfg.status === "invalid") {
    // Malformed config: disable the tool but tell the user why.
    pi.on("session_start", async (_e, ctx) => {
      ctx.ui.notify(`Subagents disabled: ${cfg.message}`, "error");
    });
    return;
  }
  const models = cfg.models;
  const defaultModel = models[0].id;
  const modelDescription =
    `Which model to use (omit for the default: ${defaultModel}). Available:\n` +
    models.map((m) => `- ${m.id} — ${m.description}`).join("\n");
  // Constrain `model` to the configured ids (a bare Literal when only one).
  const modelLiterals = models.map((m) => Type.Literal(m.id));
  const modelSchema =
    modelLiterals.length === 1
      ? Type.Literal(models[0].id, { description: modelDescription })
      : Type.Union(modelLiterals, { description: modelDescription });

  // Reset on each session (new / resume / fork / reload).
  let totals: SessionTotals = { count: 0, cost: 0, turns: 0 };
  pi.on("session_start", () => {
    totals = { count: 0, cost: 0, turns: 0 };
  });

  const sessionDir = join(getAgentDir(), "subagent-sessions");

  // Browse & resume subagent sessions in the normal UI (they live in their own
  // dir, so they never appear in the built-in /resume, pi -r, or pi -c).
  pi.registerCommand("subagents", {
    description: "Browse and resume subagent sessions",
    handler: async (_args, ctx) => {
      await openSubagentPicker(sessionDir, ctx);
    },
  });

  // Require pi-sandbox to be installed (lands here when listed in settings.json `packages`).
  // The child spawns with the standard global config, which loads it automatically.
  // Never run subagents without the sandbox.
  const sandboxPkg = join(getAgentDir(), "npm", "node_modules", "pi-sandbox");
  if (!existsSync(sandboxPkg)) return;

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: `Delegate a self-contained task to an isolated subagent (its own context window, its own read/bash/edit/write tools).

Reach for one when work is big or noisy to do but small to report — keep the mess out of your context:
- search & locate (where is X, where's this used)
- explore & explain (how does this flow work)
- summarize a big artifact (long log, huge file, diff, test output)
- web/doc lookup (a signature, a breaking change, a fact + its source)
- scoped grunt work (run tests and triage, apply a rename, build a minimal repro)
- a fresh second opinion (review a diff, argue failure cases)
Run several in parallel for independent subtasks, then merge.

Key rule: the subagent can't see this conversation — state the outcome in \`goal\` and put everything it needs in \`context\`. It finishes with a standalone final report.`,
    parameters: Type.Object({
      goal: Type.String({
        description: `One concise sentence naming the outcome this subagent must deliver.`,
      }),
      context: Type.String({
        description: `All the information to help the subagent achieve its goal.`,
      }),
      model: Type.Optional(modelSchema),
      resume: Type.Optional(
        Type.String({
          description: `Optional. Resume a finished subagent by its id (e.g. 'sub-1a2b3c4d', from a prior result footer) to ask it a follow-up; \`goal\` becomes the follow-up question.

Good for: pulling more information out of a subagent that already holds it — a detail from a page/file/search it loaded, or the reasoning behind a result it gave you.
Key rule: resume to get information not to do work.`,
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // Resolve (and validate) the session: resume an existing one or mint a new id.
      // New subagents go under the current parent session's subdir; a resumed
      // subagent stays in whichever parent subdir originally created it.
      const parentId = ctx.sessionManager.getSessionId();
      const resumeId = params.resume?.trim();
      let runDir: string;
      if (resumeId) {
        if (!SESSION_ID_RE.test(resumeId)) {
          return failure(
            `Invalid subagent id '${resumeId}'. Expected a 'sub-...' id from a prior result footer.`,
            { resume: resumeId },
          );
        }
        const existingDir = findSessionDir(sessionDir, resumeId);
        if (!existingDir) {
          return failure(
            `No subagent session '${resumeId}' found to resume. Start a fresh subagent instead (omit 'resume').`,
            { resume: resumeId },
          );
        }
        runDir = existingDir;
      } else {
        runDir = join(sessionDir, parentId);
        mkdirSync(runDir, { recursive: true });
      }
      const sessionId = resumeId ?? `sub-${randomUUID().slice(0, 8)}`;
      const model = params.model ?? defaultModel;

      const outcome = await runSubagent(
        {
          sessionId,
          resuming: Boolean(resumeId),
          model,
          prompt: buildPrompt(params.goal, params.context),
          sessionDir: runDir,
          cwd: ctx.cwd,
          signal,
        },
        // Live telemetry → inline tool block (drawn by renderResult with isPartial).
        (stats) => {
          onUpdate?.({ content: [{ type: "text", text: plainTelemetry(stats) }], details: stats });
          // Show a live footer indicator while the subagent is running.
          ctx.ui.setStatus("subagents", footerStatus({ ...totals, cost: totals.cost + stats.cost, turns: totals.turns + stats.turns }, true));
        },
      );

      const { stats, finalText, exitCode } = outcome;

      // Stamp parent lineage into the subagent's session header for agentsview.
      stampBranchedFrom(runDir, sessionId, parentId);

      if (outcome.aborted) {
        return failure(`Subagent ${sessionId} aborted.`, { ...stats, error: "aborted" });
      }
      if (outcome.spawnError) {
        return failure(`Failed to launch subagent: ${outcome.spawnError.message}`, {
          ...stats,
          error: outcome.spawnError.message,
        });
      }
      if (exitCode !== 0 && !finalText) {
        return failure(`Subagent ${sessionId} failed (exit ${exitCode}).\n${outcome.stderr.slice(-1500)}`, {
          ...stats,
          error: `exit ${exitCode}`,
          exitCode,
        });
      }

      // Update session-level running totals and footer.
      totals.count += 1;
      totals.cost += stats.cost;
      totals.turns += stats.turns;
      ctx.ui.setStatus("subagents", footerStatus(totals, false));

      const body = finalText || "(subagent produced no final text)";
      const footer = `[subagent ${sessionId} \u00b7 ${plural(stats.turns, "turn")} \u00b7 $${stats.cost.toFixed(4)}]`;
      return {
        content: [{ type: "text", text: `${body}\n\n${footer}` }],
        details: { ...stats, text: body },
      };
    },

    renderCall(args, theme) {
      return renderCall(args, defaultModel, theme);
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      return renderResult(
        result.details as SubStats | undefined,
        Boolean(context.isError),
        expanded,
        isPartial,
        theme,
      );
    },
  });
}
