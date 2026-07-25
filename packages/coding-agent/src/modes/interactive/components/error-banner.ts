import { Container, Spacer, Text } from "@musepi/pi-tui";
import { getSymbol, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

/**
 * A persistent error banner pinned above the editor. Unlike the transcript
 * "Error: …" line (which scrolls away as the conversation grows), this stays in
 * the fixed region directly above the input so a turn that ended on a provider
 * error — e.g. Anthropic's "Output blocked by content filtering policy" — cannot
 * be missed. It is cleared when the next turn starts.
 */
export class ErrorBannerComponent extends Container {
	#message: string;

	constructor(message: string) {
		super();

		this.#message = message;
		const lines = message.split("\n").slice(0, 3);

		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((str) => theme.fg("error", str)));
		this.addChild(new Text(theme.bold(theme.fg("error", `${getSymbol("status.error")} ${lines[0]}`)), 1, 0));
		for (const line of lines.slice(1)) {
			this.addChild(new Text(theme.fg("error", `  ${line}`), 1, 0));
		}
		this.addChild(new Text(theme.fg("dim", "Dismissed when you send your next message."), 1, 0));
		this.addChild(new DynamicBorder((str) => theme.fg("error", str)));
	}

	get message(): string {
		return this.#message;
	}
}
