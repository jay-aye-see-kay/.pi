/**
 * Prompt-All Extension
 *
 * When enabled with --prompt-all, every tool call must be approved by the user.
 * A denial blocks the tool and aborts the current turn so pi returns to idle;
 * you then steer with your next prompt. Intended for interactive sessions where
 * the OS sandbox is off (e.g. `pi --no-sandbox --prompt-all --tools bash`).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function formatToolCall(toolName: string, input: Record<string, unknown>): string {
	if (toolName === "bash" && typeof input.command === "string") {
		return `bash:\n\n  ${input.command}`;
	}
	if (typeof input.path === "string") {
		return `${toolName}: ${input.path}`;
	}
	const json = JSON.stringify(input);
	const compact = json.length > 500 ? `${json.slice(0, 500)}…` : json;
	return `${toolName}: ${compact}`;
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("prompt-all", {
		description: "Ask for approval before every tool call; deny ends the turn",
		type: "boolean",
		default: false,
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!pi.getFlag("prompt-all")) return undefined;

		const label = formatToolCall(event.toolName, event.input as Record<string, unknown>);

		if (!ctx.hasUI) {
			ctx.abort();
			return { block: true, reason: "tool approval blocked by user" };
		}

		const choice = await ctx.ui.select(`Approve tool call?\n\n${label}`, ["Allow", "Deny"]);

		if (choice !== "Allow") {
			ctx.ui.notify("Tool blocked — turn ended. Steer with your next message.", "warning");
			ctx.abort();
			return { block: true, reason: "tool approval blocked by user" };
		}

		return undefined;
	});
}
