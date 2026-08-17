import { type Component, Container, Markdown, Spacer, Text, type TUI } from "@musepi/pi-tui";
import { t } from "../../i18n/index.js";
import { replaceTabs } from "../../tools/render-utils";
import { getMarkdownTheme, theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

export type OmfgPanelState =
	| "generating"
	| "validating"
	| "confirming"
	| "saving"
	| "saved"
	| "rejected"
	| "aborted"
	| "error";

interface OmfgPanelComponentOptions {
	complaint: string;
	tui: TUI;
}

export class OmfgPanelComponent extends Container {
	#complaint: string;
	#tui: TUI;
	#state: OmfgPanelState = "generating";
	#status = t("Generating TTSR rule…");
	#preview = "";
	#savedPath: string | undefined;
	#errorMessage: string | undefined;
	#closed = false;

	constructor(options: OmfgPanelComponentOptions) {
		super();
		this.#complaint = options.complaint;
		this.#tui = options.tui;
		this.#rebuild();
	}

	appendDraft(delta: string): void {
		if (!delta || this.#closed) return;
		this.#preview += delta;
		this.#rebuild();
	}

	setRule(text: string): void {
		if (this.#closed) return;
		this.#preview = text;
		this.#rebuild();
	}

	setStatus(state: OmfgPanelState, status: string): void {
		if (this.#closed) return;
		this.#state = state;
		this.#status = status;
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	markSaved(path: string): void {
		if (this.#closed) return;
		this.#state = "saved";
		this.#savedPath = path;
		this.#status = t("Saved {0}", path);
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	markRejected(): void {
		if (this.#closed) return;
		this.#state = "rejected";
		this.#status = t("Rule was not saved.");
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	markAborted(): void {
		if (this.#closed) return;
		this.#state = "aborted";
		this.#status = t("Cancelled.");
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	markError(message: string): void {
		if (this.#closed) return;
		this.#state = "error";
		this.#status = t("Could not create rule.");
		this.#errorMessage = message;
		this.#rebuild();
	}

	close(): void {
		this.#closed = true;
	}

	#rebuild(): void {
		this.clear();
		this.addChild(new DynamicBorder(str => theme.fg("dim", str)));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", replaceTabs(`/omfg ${this.#complaint}`)), 1, 0));
		this.addChild(new Text(theme.fg("muted", replaceTabs(this.#status)), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.#contentComponent());
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.#footerLine(), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(str => theme.fg("dim", str)));
		this.#tui.requestRender();
	}

	#footerLine(): string {
		switch (this.#state) {
			case "generating":
			case "validating":
			case "confirming":
			case "saving":
				return theme.fg("muted", t("Esc cancel /omfg"));
			case "saved":
				return theme.fg(
					"success",
					`${theme.status.success} ${t("Registered live · {0} · Esc dismiss", replaceTabs(this.#savedPath ?? "saved"))}`,
				);
			case "rejected":
				return theme.fg("warning", `${theme.status.warning} ${t("Not saved · Esc dismiss")}`);
			case "aborted":
				return theme.fg("warning", `${theme.status.warning} ${t("Cancelled · Esc dismiss")}`);
			case "error":
				return theme.fg("error", `${theme.status.error} ${t("Error · Esc dismiss")}`);
		}
	}

	#contentComponent(): Component {
		if (this.#state === "error") {
			return new Text(theme.fg("error", replaceTabs(this.#errorMessage ?? t("Unknown error"))), 1, 0);
		}
		const text = replaceTabs(this.#preview).trim();
		if (!text) {
			return new Text(theme.fg("dim", `${theme.status.pending} ${t("Waiting for candidate rule…")}`), 1, 0);
		}
		return new Markdown(text, 1, 0, getMarkdownTheme());
	}
}
