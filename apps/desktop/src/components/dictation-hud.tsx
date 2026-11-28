import { setLocale, t } from "@musepi/client-core";
import {
	TriangleAlert as AlertIcon,
	Check as CheckIcon,
	Download as DownloadIcon,
	LoaderCircle,
	Mic as MicIcon,
} from "lucide";
import { MorphIcon } from "morphicons/react";
import { useState } from "react";
import { HeightMorph } from "./HeightMorph";
import { TextMorph } from "./TextMorph";

export type DictationPhase = "hidden" | "recording" | "downloading" | "transcribing" | "inserting" | "done" | "error";

export interface DictationState {
	phase: DictationPhase;
	level?: number;
	seconds?: number;
	percent?: number;
	message?: string;
	partialText?: string;
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
const PHASE_ICON = {
	recording: MicIcon,
	downloading: DownloadIcon,
	transcribing: LoaderCircle,
	inserting: LoaderCircle,
	done: CheckIcon,
	error: AlertIcon,
	hidden: MicIcon,
} as const;

export function DictationHudView({ state }: { state: DictationState }): React.ReactNode {
	const message = state.message ? t((MESSAGES[state.message] ?? "settings.globalDictationFailed") as never) : "";
	const title =
		state.phase === "recording"
			? `${t("settings.globalDictationListening")} ${state.seconds ?? 0}s`
			: state.phase === "downloading"
				? t("settings.globalDictationDownloading", { percent: String(state.percent ?? 0) })
				: state.phase === "transcribing"
					? t("settings.globalDictationTranscribing")
					: state.phase === "inserting"
						? t("settings.globalDictationInserting")
						: state.phase === "done"
							? message || t("settings.globalDictationDone")
							: state.phase === "error"
								? message || t("settings.globalDictationFailed")
								: "";
	const detail =
		state.phase === "recording" && !state.partialText
			? t("settings.globalDictationListeningHint")
			: (state.partialText ?? "");
	const level = Math.min(1, Math.max(0, state.level ?? 0));
	const showActions = state.phase === "recording" || state.phase === "error" || state.phase === "done";
	return (
		<HeightMorph morphKey={state.phase} className="hud" fade={false}>
			<div className="hud-inner" data-phase={state.phase}>
				<div className="hud-glyph">
					{state.phase === "recording" ? (
						<div className="hud-wave" aria-hidden="true">
							{[0.45, 0.75, 1, 0.7, 0.4].map((weight, index) => (
								<span key={index} style={{ transform: `scaleY(${(0.18 + level * weight).toFixed(3)})` }} />
							))}
						</div>
					) : (
						<MorphIcon
							icon={PHASE_ICON[state.phase] ?? MicIcon}
							size={16}
							spring="snappy"
							className={`hud-icon${state.phase === "transcribing" || state.phase === "inserting" ? " hud-icon--spin" : ""}`}
						/>
					)}
				</div>
				<div className="hud-copy">
					<TextMorph text={title} className="hud-title" />
					{detail &&
						(state.partialText ? (
							<span className="hud-sub hud-sub--transcript" role="text">
								{detail}
							</span>
						) : (
							<TextMorph text={detail} className="hud-sub" stepMs={14} durationMs={180} />
						))}
					{state.phase === "downloading" && (
						<div className="hud-progress">
							<i style={{ width: `${state.percent ?? 0}%` }} />
						</div>
					)}
				</div>
				{showActions && (
					<div className="hud-actions">
						{state.phase === "recording" && (
							<button type="button" className="hud-btn" onClick={() => bridge?.action("cancel")}>
								{t("settings.globalDictationCancel")}
							</button>
						)}
						{state.phase === "error" && state.settings && (
							<button type="button" className="hud-btn" onClick={() => bridge?.action("settings")}>
								{t("settings.globalDictationOpenSettings")}
							</button>
						)}
						{state.phase === "error" && state.copy && (
							<button type="button" className="hud-btn hud-btn--primary" onClick={() => bridge?.action("copy")}>
								{t("settings.globalDictationCopy")}
							</button>
						)}
						{state.phase !== "recording" && (
							<button type="button" className="hud-btn" onClick={() => bridge?.action("close")}>
								{t("settings.globalDictationClose")}
							</button>
						)}
					</div>
				)}
			</div>
		</HeightMorph>
	);
}

let subscribed = false;
export function Hud(): React.ReactNode {
	const [state, setState] = useState<DictationState>({ phase: "hidden" });
	if (bridge && !subscribed) {
		subscribed = true;
		bridge.onState(next => {
			if (next.locale) setLocale(next.locale);
			setState(next);
		});
	}
	return <DictationHudView state={state} />;
}
