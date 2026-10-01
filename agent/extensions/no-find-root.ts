/**
 * Block `find /` in bash tool calls: it walks the whole filesystem and can
 * run for 10+ minutes. The model gets a reason telling it to scope the search.
 */

import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FIND_ROOT = /\bfind\s+\/(?=\s|$|[;|&)])/;

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (!isToolCallEventType("bash", event)) return undefined;
		if (!FIND_ROOT.test(event.input.command)) return undefined;
		return {
			block: true,
			reason:
				"Blocked: `find /` searches the whole filesystem and can take 10+ minutes. " +
				"Search a specific directory instead (e.g. the project, ~/.pi, /usr/local, " +
				"/opt/homebrew), add -maxdepth, or use `fd`/`rg --files` scoped to a path. " +
				"For binaries use `which`/`command -v`; for macOS files try `mdfind`.",
		};
	});
}
