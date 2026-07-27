// ============================================================
// MusePi /btw panel — dedicated TUI component.
//
// Shows the question in a DynamicBorder, streams/stores the
// answer, and provides state-based footer hints.
// Spinner animation while streaming.
// ============================================================

import { Container, Markdown, Spacer, Text } from "@musepi/pi-tui";
import { DynamicBorder } from "../modes/interactive/components/dynamic-border.ts";
import { getMarkdownTheme, theme } from "../modes/interactive/theme/theme.ts";

export type BtwPanelState = "running" | "complete" | "aborted" | "error";

/** Braille spinner frames. */
const SPINNER_FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u2828", "\u2868", "\u286C", "\u282C"];

/** Replace tabs with spaces for terminal-safe rendering. */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "  ");
}

export class BtwPanelComponent extends Container {
	readonly #question: string;
	readonly #borderColor: (s: string) => string;
	#state: BtwPanelState = "running";
	#visibleAnswer = "";
	#errorMessage: string | undefined;
	#closed = false;
	#spinnerFrame = 0;
	#spinnerTimer: ReturnType<typeof setInterval> | undefined;

	constructor(question: string, borderColor: (s: string) => string) {
		super();
		this.#question = question;
		this.#borderColor = borderColor;
		this.#rebuild();
		this.#startSpinner();
	}

	appendText(delta: string): void {
		this.#visibleAnswer += replaceTabs(delta);
		this.#rebuild();
	}

	setAnswer(text: string): void {
		this.#visibleAnswer = replaceTabs(text);
		this.#rebuild();
	}

	markComplete(): void {
		this.#stopSpinner();
		this.#state = "complete";
		this.#rebuild();
	}

	markAborted(): void {
		this.#stopSpinner();
		this.#state = "aborted";
		this.#rebuild();
	}

	markError(message: string): void {
		this.#stopSpinner();
		this.#errorMessage = message;
		this.#state = "error";
		this.#rebuild();
	}

	isCopyable(): boolean {
		return this.#state === "complete" && this.#visibleAnswer.length > 0;
	}

	getCopyText(): string | undefined {
		return this.isCopyable() ? this.#visibleAnswer : undefined;
	}

	getBranchText(): string | undefined {
		return this.isCopyable() ? this.#visibleAnswer : undefined;
	}

	close(): void {
		this.#stopSpinner();
		this.#closed = true;
	}

	#startSpinner(): void {
		this.#stopSpinner();
		this.#spinnerTimer = setInterval(() => {
			this.#spinnerFrame = (this.#spinnerFrame + 1) % SPINNER_FRAMES.length;
			this.#rebuild();
		}, 120);
	}

	#stopSpinner(): void {
		if (this.#spinnerTimer) {
			clearInterval(this.#spinnerTimer);
			this.#spinnerTimer = undefined;
		}
	}

	#rebuild(): void {
		if (this.#closed) return;
		this.clear();

		this.addChild(new DynamicBorder(this.#borderColor));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", this.#question), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.#contentComponent());
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.#footerLine(), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(this.#borderColor));
	}

	#footerLine(): string {
		switch (this.#state) {
			case "running":
				if (this.#visibleAnswer) {
					return `${theme.fg("muted", "Esc cancel")}`;
				}
				return `${theme.fg("dim", SPINNER_FRAMES[this.#spinnerFrame])} ${theme.fg("muted", "Waiting for response\u2026 Esc cancel")}`;
			case "complete":
				return theme.fg("muted", this.isCopyable() ? "c copy \xB7 b branch \xB7 Esc dismiss" : "Esc dismiss");
			case "aborted":
				return theme.fg("warning", "\u2717 Cancelled \xB7 Esc dismiss");
			case "error":
				return theme.fg("error", "\u2717 Error \xB7 Esc dismiss");
		}
	}

	#contentComponent(): Container {
		const inner = new Container();
		if (this.#state === "error") {
			inner.addChild(new Text(theme.fg("error", this.#errorMessage ?? "Unknown error"), 1, 0));
			return inner;
		}
		const text = this.#visibleAnswer;
		if (!text) {
			if (this.#state === "running") {
				inner.addChild(
					new Text(
						`${theme.fg("dim", SPINNER_FRAMES[this.#spinnerFrame])} ${theme.fg("dim", "Waiting for response\u2026")}`,
						1,
						0,
					),
				);
			} else {
				inner.addChild(new Text(theme.fg("dim", "No text returned."), 1, 0));
			}
			return inner;
		}
		inner.addChild(new Markdown(text, 1, 0, getMarkdownTheme()));
		return inner;
	}
}
