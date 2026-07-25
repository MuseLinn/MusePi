// ============================================================
// MusePi /btw panel — dedicated TUI component.
//
// Shows the question in a DynamicBorder, streams/stores the
// answer, and provides state-based footer hints (Esc dismiss,
// c copy, b branch to session).
// ============================================================

import { Container, Markdown, Spacer, Text } from "@musepi/pi-tui";
import { DynamicBorder } from "../modes/interactive/components/dynamic-border.ts";
import { getMarkdownTheme, theme } from "../modes/interactive/theme/theme.ts";

export type BtwPanelState = "running" | "complete" | "aborted" | "error";

export class BtwPanelComponent extends Container {
	readonly #question: string;
	readonly #borderColor: (s: string) => string;
	#state: BtwPanelState = "running";
	#visibleAnswer = "";
	#errorMessage: string | undefined;
	#closed = false;

	constructor(question: string, borderColor: (s: string) => string) {
		super();
		this.#question = question;
		this.#borderColor = borderColor;
		this.#rebuild();
	}

	appendText(delta: string): void {
		this.#visibleAnswer += delta;
		this.#rebuild();
	}

	setAnswer(text: string): void {
		this.#visibleAnswer = text;
		this.#rebuild();
	}

	markComplete(): void {
		this.#state = "complete";
		this.#rebuild();
	}

	markAborted(): void {
		this.#state = "aborted";
		this.#rebuild();
	}

	markError(message: string): void {
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
		this.#closed = true;
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
				return theme.fg("muted", "Esc cancel /btw");
			case "complete":
				return theme.fg("muted", this.isCopyable() ? "c copy · b branch to chat · Esc dismiss" : "Esc dismiss");
			case "aborted":
				return theme.fg("warning", "! Cancelled · Esc dismiss");
			case "error":
				return theme.fg("error", "\u2717 Error · Esc dismiss");
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
			const waiting =
				this.#state === "running" ? theme.fg("dim", "\u23F3 Waiting for response\u2026") : "No text returned.";
			inner.addChild(new Text(waiting, 1, 0));
			return inner;
		}
		inner.addChild(new Markdown(text, 1, 0, getMarkdownTheme()));
		return inner;
	}
}
