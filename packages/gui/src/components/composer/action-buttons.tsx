import { Check as CheckIconData, WandSparkles as WandSparklesIconData } from "lucide";
import { SendHorizontal, Square, WandSparkles } from "lucide-react";
import { MorphIcon } from "morphicons/react";
import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { Icon } from "../../vendor/oc-icons";

/** Prompt-enhancement lifecycle (aicss AI Agent Input parity). */
export type EnhanceState = "idle" | "enhancing" | "enhanced";

/** Prompt-enhancement pill (aicss AI Agent Input parity): rewrites the
 *  draft via the session's model; the "enhanced" state decays back to
 *  idle once the user edits the prompt. */
export function EnhanceButton({ state, onToggle }: { state: EnhanceState; onToggle(): void }): ReactNode {
	return (
		<button
			type="button"
			className={`gui-composer-pill${state === "enhanced" ? " gui-composer-pill--done" : ""}`}
			onClick={onToggle}
		>
			{state === "enhancing" ? (
				<WandSparkles size={11} className="gui-spin" />
			) : (
				<MorphIcon
					icon={state === "enhanced" ? CheckIconData : WandSparklesIconData}
					size={11}
					spring="snappy"
					className="gui-composer-morph"
				/>
			)}
			<span>{state === "enhancing" ? t("enhancing…") : state === "enhanced" ? t("enhanced") : t("enhance")}</span>
		</button>
	);
}

/** Voice input toggle (startDictation from ../lib/voice). */
export function VoiceButton({
	state,
	seconds,
	level,
	onToggle,
}: {
	state: "idle" | "recording" | "transcribing";
	seconds: number;
	level: number;
	onToggle(): void;
}): ReactNode {
	return (
		<button
			type="button"
			className={`gui-composer-ico${state !== "idle" ? " gui-composer-ico--dictating" : ""}`}
			onClick={onToggle}
			title={state === "recording" ? t("voice recording stop") : t("voice input")}
			aria-label={state === "recording" ? t("voice recording stop") : t("voice input")}
		>
			{state === "recording" ? (
				<>
					<Icon name="mic" className="h-3.5 w-3.5 gui-voice-pulse" />
					<span className="gui-voice-seconds">{seconds}s</span>
					<span className="gui-voice-level" style={{ width: `${Math.round(level * 100)}%` }} />
				</>
			) : state === "transcribing" ? (
				<span className="gui-voice-spinner" aria-label={t("voice transcribing")} />
			) : (
				<Icon name="mic" className="h-3.5 w-3.5" />
			)}
		</button>
	);
}

/** Stop the current turn (session.abort). */
export function StopButton({ onPress }: { onPress(): void }): ReactNode {
	return (
		<button
			type="button"
			className="gui-composer-ico"
			onClick={onPress}
			title={t("stop the current turn")}
			aria-label={t("stop the current turn")}
		>
			<Square size={11} />
		</button>
	);
}

/** Retry the last failed turn (TUI /retry parity). */
export function RetryButton({ busy, none, onPress }: { busy: boolean; none: boolean; onPress(): void }): ReactNode {
	return (
		<button
			type="button"
			className={`gui-composer-ico${none ? " gui-composer-ico--danger" : ""}`}
			onClick={onPress}
			disabled={busy}
			title={none ? t("nothing to retry") : t("retry last turn")}
			aria-label={t("retry last turn")}
		>
			<Icon name="arrow-go-back" className="h-3.5 w-3.5" />
		</button>
	);
}

/** Send button (working → steer semantics in the title/label). */
export function SendButton({
	canSend,
	busy,
	working,
	onPress,
}: {
	canSend: boolean;
	busy: boolean;
	working: boolean;
	onPress(): void;
}): ReactNode {
	return (
		<button
			type="button"
			className="gui-composer-send"
			onClick={canSend && !busy ? onPress : undefined}
			disabled={!canSend || busy}
			title={working ? t("steer message") : t("send message")}
			aria-label={working ? t("steer message") : t("send message")}
		>
			<SendHorizontal size={14} />
		</button>
	);
}

/** Focus mode toggle (openchamber ⌘⇧E): the composer fills the surface. */
export function FocusButton({ focused, onPress }: { focused: boolean; onPress(): void }): ReactNode {
	return (
		<button
			type="button"
			className={`gui-composer-ico${focused ? " gui-composer-ico--active" : ""}`}
			onClick={onPress}
			title={t("focus mode")}
			aria-label={t("focus mode")}
			aria-pressed={focused}
		>
			<Icon name="expand-up-down" className="h-3.5 w-3.5" />
		</button>
	);
}

/** Pending-message queue chip (TUI /queue parity) — informational, shown
 *  while the agent works and messages are queued behind the current turn. */
export function QueueChip({ count, title }: { count: number; title: string }): ReactNode {
	return (
		<button type="button" className="gui-queue-chip" title={title} aria-label={t("queued messages")}>
			<Icon name="list-unordered" className="h-3 w-3" />
			<span>{t("queued {count}", { count: String(count) })}</span>
		</button>
	);
}
