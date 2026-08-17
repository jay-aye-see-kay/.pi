import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCapabilities, setCapabilities } from "@earendil-works/pi-tui";

/** Render Markdown links as "label (URL)" instead of relying on OSC 8 links. */
export default function (_pi: ExtensionAPI) {
	setCapabilities({ ...getCapabilities(), hyperlinks: false });
}
