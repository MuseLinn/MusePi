/**
 * Global-dictation HUD (dictation.html): a small non-focusable card that shows
 * the recording state, the model download, the transcription wait and the
 * insertion outcome. The main process owns the recording and the text
 * injection; this renderer paints the state it receives and sends the three
 * actions back (cancel, copy, close/settings).
 *
 * It must never steal focus from the app receiving the transcript: the window
 * is created with `focusable: false` and shown with `showInactive`.
 */
import { setLocale, t } from "@musepi/client-core";
import "@musepi/client-core/src/styles/tokens.css";
import "@musepi/client-core/src/styles/overlay-fallback.css";
import "./styles/dictation.css";

type Phase = "hidden" | "recording" | "downloading" | "transcribing" | "inserting" | "done" | "error";

interface DictationState {
	phase: Phase;
	level?: number;
	seconds?: number;
	percent?: number;
	message?: string;
	copy?: boolean;
	settings?: boolean;
	locale?: string;
}

interface HudBridge {
	onState(cb: (state: DictationState) => void): () => void;
	action(type: "cancel" | "copy" | "close" | "settings"): void;
}

const bridge = (window as unknown as { electronAPI?: { dictationHud?: HudBridge } }).electronAPI?.dictationHud;

const MESSAGES: Record<string, string> = {
	"globalDictation.tooShort": "settings.globalDictationTooShort",
	"globalDictation.empty": "settings.globalDictationEmpty",
	"globalDictation.pasteFailed": "settings.globalDictationPasteFailed",
	"globalDictation.copied": "settings.globalDictationCopied",
	"globalDictation.failed": "settings.globalDictationFailed",
	"globalDictation.micFailed": "settings.globalDictationMicFailed",
	"globalDictation.noDaemon": "settings.globalDictationNoDaemon",
	"globalDictation.shortcutUnavailable": "settings.globalDictationShortcutUnavailable",
	"globalDictation.disabled": "settings.globalDictationDisabled",
};

const root = document.getElementById("root") as HTMLDivElement;
root.innerHTML = `
<div class="hud" data-phase="hidden">
	<div class="hud-wave" aria-hidden="true">
		<span></span><span></span><span></span><span></span><span></span>
	</div>
	<div class="hud-copy">
		<div class="hud-title"></div>
		<div class="hud-sub"></div>
		<div class="hud-progress" hidden><i></i></div>
	</div>
	<div class="hud-actions">
		<button type="button" class="hud-btn" data-action="cancel"></button>
		<button type="button" class="hud-btn" data-action="settings" hidden></button>
		<button type="button" class="hud-btn hud-btn--primary" data-action="copy" hidden></button>
		<button type="button" class="hud-btn" data-action="close" hidden></button>
	</div>
</div>`;

const hud = root.querySelector<HTMLDivElement>(".hud") as HTMLDivElement;
const wave = root.querySelector<HTMLDivElement>(".hud-wave") as HTMLDivElement;
const title = root.querySelector<HTMLDivElement>(".hud-title") as HTMLDivElement;
const sub = root.querySelector<HTMLDivElement>(".hud-sub") as HTMLDivElement;
const progress = root.querySelector<HTMLDivElement>(".hud-progress") as HTMLDivElement;
const progressFill = progress.querySelector("i") as HTMLElement;
const buttons = [...root.querySelectorAll<HTMLButtonElement>(".hud-btn")];

const LABELS: Record<string, string> = {
	cancel: "settings.globalDictationCancel",
	copy: "settings.globalDictationCopy",
	close: "settings.globalDictationClose",
	settings: "settings.globalDictationOpenSettings",
};

for (const button of buttons) {
	const action = button.dataset.action as keyof typeof LABELS;
	button.addEventListener("click", () => bridge?.action(action as "cancel" | "copy" | "close" | "settings"));
}

const waveBars = [...wave.querySelectorAll<HTMLSpanElement>("span")];

function setButtons(state: DictationState): void {
	const show = (action: string, visible: boolean): void => {
		const button = buttons.find(item => item.dataset.action === action);
		if (button) button.hidden = !visible;
	};
	show("cancel", state.phase === "recording");
	show("copy", state.copy === true || (state.phase === "done" && state.message === "globalDictation.copied"));
	show("settings", state.settings === true);
	show("close", state.phase === "error" || state.phase === "done");
}

function render(state: DictationState): void {
	if (state.locale) setLocale(state.locale);
	for (const button of buttons) {
		const action = button.dataset.action as keyof typeof LABELS;
		button.textContent = t(LABELS[action] as never);
		button.title = t(LABELS[action] as never);
	}
	hud.dataset.phase = state.phase;
	const level = Math.min(1, Math.max(0, state.level ?? 0));
	waveBars.forEach((bar, index) => {
		const weight = [0.45, 0.75, 1, 0.7, 0.4][index] ?? 0.5;
		bar.style.transform = `scaleY(${(0.18 + level * weight).toFixed(3)})`;
	});
	const messageKey = state.message ? MESSAGES[state.message] : undefined;
	const message = messageKey ? t(messageKey as never) : "";
	switch (state.phase) {
		case "recording":
			title.textContent = `${t("settings.globalDictationListening")} ${state.seconds ?? 0}s`;
			sub.textContent = t("settings.globalDictationListeningHint");
			progress.hidden = true;
			break;
		case "downloading":
			title.textContent = t("settings.globalDictationDownloading", { percent: String(state.percent ?? 0) });
			sub.textContent = "";
			progress.hidden = false;
			progressFill.style.width = `${state.percent ?? 0}%`;
			break;
		case "transcribing":
			title.textContent = t("settings.globalDictationTranscribing");
			sub.textContent = "";
			progress.hidden = true;
			break;
		case "inserting":
			title.textContent = t("settings.globalDictationInserting");
			sub.textContent = "";
			progress.hidden = true;
			break;
		case "done":
			title.textContent = message || t("settings.globalDictationDone");
			sub.textContent = "";
			progress.hidden = true;
			break;
		case "error":
			title.textContent = message || t("settings.globalDictationFailed");
			sub.textContent = "";
			progress.hidden = true;
			break;
		default:
			title.textContent = "";
			sub.textContent = "";
			progress.hidden = true;
			break;
	}
	setButtons(state);
}

bridge?.onState(render);
