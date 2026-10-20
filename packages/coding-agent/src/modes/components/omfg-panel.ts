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
	#status = t("commands.generatingTtsrRule");
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
		this.#status = t("commands.savedWith0", path);
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	markRejected(): void {
		if (this.#closed) return;
		this.#state = "rejected";
		this.#status = t("commands.ruleWasNotSaved");
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	markAborted(): void {
		if (this.#closed) return;
		this.#state = "aborted";
		this.#status = t("commands.cancelled");
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	markError(message: string): void {
		if (this.#closed) return;
		this.#state = "error";
		this.#status = t("commands.couldNotCreateRule");
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
				return theme.fg("muted", t("commands.escCancelOmfg"));
			case "saved":
				return theme.fg(
					"success",
					`${theme.status.success} ${t("commands.registeredLiveEscDismissWith0", replaceTabs(this.#savedPath ?? "saved"))}`,
				);
			case "rejected":
				return theme.fg("warning", `${theme.status.warning} ${t("commands.notSavedEscDismiss")}`);
			case "aborted":
				return theme.fg("warning", `${theme.status.warning} ${t("commands.cancelledEscDismiss")}`);
			case "error":
				return theme.fg("error", `${theme.status.error} ${t("commands.errorEscDismiss")}`);
		}
	}

	#contentComponent(): Component {
		if (this.#state === "error") {
			return new Text(theme.fg("error", replaceTabs(this.#errorMessage ?? t("swarm.unknownError"))), 1, 0);
		}
		const text = replaceTabs(this.#preview).trim();
		if (!text) {
			return new Text(theme.fg("dim", `${theme.status.pending} ${t("errors.waitingCandidateRule")}`), 1, 0);
		}
		return new Markdown(text, 1, 0, getMarkdownTheme());
	}
}
