import { Container, Text } from "@musepi/pi-tui";
import { t } from "../../i18n/index.js";
import { WidthAwareText } from "../../tui/width-aware-text.js";
import { theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";
import { formatErrorBlock } from "./error-block";

/**
 * Wrapped rows shown before the overflow hint. Counting rows rather than source
 * lines keeps the banner a predictable height whatever the terminal width, which
 * matters because this sits in the fixed region above the editor.
 */
const MAX_BANNER_ROWS = 4;

/**
 * A persistent error banner pinned above the editor. Unlike the transcript
 * "Error: …" line (which scrolls away as the conversation grows), this stays in
 * the fixed region directly above the input so a turn that ended on a provider
 * error — e.g. Anthropic's "Output blocked by content filtering policy" — cannot
 * be missed. It is cleared when the next turn starts.
 */
export class ErrorBannerComponent extends Container {
	constructor(message: string) {
		super();

		// Width is only known at render time, so the wrap happens in the callback
		// rather than here. Truncating at a fixed column instead used to cut off
		// the tail of a single-line provider body, which is the part that explains
		// the failure.
		this.addChild(
			new WidthAwareText(
				contentWidth =>
					formatErrorBlock(
						message,
						contentWidth,
						MAX_BANNER_ROWS,
						(line, index) => (index === 0 ? theme.bold(theme.fg("error", line)) : theme.fg("error", line)),
						hidden => `… +${hidden} more line${hidden === 1 ? "" : "s"}`,
					),
				1,
				0,
			),
		);
		this.addChild(new Text(theme.fg("dim", t("Dismissed when you send your next message.")), 1, 0));
		this.addChild(new DynamicBorder(str => theme.fg("error", str)));
	}
}
