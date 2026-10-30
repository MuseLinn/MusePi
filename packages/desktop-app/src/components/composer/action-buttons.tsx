import { Check as CheckIconData, WandSparkles as WandSparklesIconData } from "lucide";
import { ListPlus, SendHorizontal, Square, WandSparkles } from "lucide-react";
import { MorphIcon } from "morphicons/react";
import { type CSSProperties, type ReactNode, useState } from "react";
import { t } from "../../i18n/index.js";
import { Icon } from "../../vendor/oc-icons";
import { TextMorph } from "../TextMorph";

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
			<span>
				{state === "enhancing"
					? t("transcript.enhancing")
					: state === "enhanced"
						? t("settings.enhanced")
						: t("settings.enhance")}
			</span>
		</button>
	);
}

/** Voice input toggle (startDictation from ../lib/voice).
 *
 *  Deliberately a compact motion-only control: the 30px capsule has no room
 *  for copy (user direction), so the seconds clock, the waveform and the
 *  phase text moved into the in-input {@link VoiceStatusStrip} — the button
 *  keeps just the tint + pulse while recording and the spinner while
 *  transcribing. */
export function VoiceButton({
	state,
	disabled,
	onToggle,
}: {
	state: "idle" | "recording" | "transcribing";
	/** stt.enabled gate (TUI parity): renders inert while speech input is off. */
	disabled?: boolean;
	onToggle(): void;
}): ReactNode {
	const label =
		state === "recording"
			? t("settings.voiceRecordingStop")
			: state === "transcribing"
				? t("settings.voiceTranscribing")
				: t("settings.voiceInput");
	return (
		<button
			type="button"
			className={`gui-composer-ico${state !== "idle" ? " gui-composer-ico--dictating" : ""}`}
			onClick={onToggle}
			disabled={disabled}
			title={label}
			aria-label={label}
		>
			{state === "transcribing" ? (
				<span className="gui-voice-spinner" />
			) : (
				<Icon name="mic" className="h-3.5 w-3.5" />
			)}
		</button>
	);
}

const VOICE_WAVE_BARS = Array.from({ length: 13 }, (_, index) => 0.35 + ((index * 7) % 10) / 14);

export function VoiceStatusStrip({
	phase,
	seconds,
	level,
	partialText = "",
}: {
	phase: "recording" | "transcribing";
	seconds: number;
	level: number;
	partialText?: string;
}): ReactNode {
	return (
		<div
			className={`gui-voice-strip${phase === "transcribing" ? " gui-voice-strip--transcribing" : ""}`}
			style={{ "--voice-level": `${Math.round(level * 100) / 100}` } as CSSProperties}
			role="status"
			aria-live="polite"
		>
			<span className="gui-voice-visual" aria-hidden>
				<i className="gui-voice-ring gui-voice-ring--outer" />
				<i className="gui-voice-ring gui-voice-ring--inner" />
				<span className="gui-voice-wave">
					{VOICE_WAVE_BARS.map((weight, index) => (
						<i key={index} style={{ transform: `scaleY(${Math.min(1, 0.18 + level * weight)})` }} />
					))}
				</span>
			</span>
			<span className="gui-voice-strip-label">
				{phase === "recording" ? `${seconds}s` : t("settings.voiceTranscribing")}
			</span>
			<span className={`gui-voice-partial${partialText ? " gui-voice-partial--visible" : ""}`}>{partialText}</span>
			<span className="gui-voice-strip-hint">{t("settings.voiceEscCancel")}</span>
		</div>
	);
}

/** Stop the current turn (session.abort). */
export function StopButton({ onPress }: { onPress(): void }): ReactNode {
	return (
		<button
			type="button"
			className="gui-composer-ico"
			onClick={onPress}
			title={t("composer.stopCurrentTurn")}
			aria-label={t("composer.stopCurrentTurn")}
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
			title={none ? t("composer.nothingRetry") : t("composer.retryLastTurn")}
			aria-label={t("composer.retryLastTurn")}
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
			title={working ? t("general.steerMessage") : t("settings.sendMessage")}
			aria-label={working ? t("general.steerMessage") : t("settings.sendMessage")}
		>
			<SendHorizontal size={14} />
		</button>
	);
}

/** Opencode opendesign's 5×5 dot-matrix "cross expand" glyph (guest-client parity).
 *  Self-contained inline SVG with SMIL opacity animation — no dangerouslySetInnerHTML.
 *  Uses currentColor so it adapts to the button's accent tint. */
function MatrixLoader({ className }: { className?: string }): ReactNode {
	return (
		<svg className={className} viewBox="0 0 92 92" width="18" height="18" aria-hidden="true" focusable="false">
			<defs>
				<filter id="od-matrix-bloom" x="-100%" y="-100%" width="300%" height="300%">
					<feComponentTransfer in="SourceGraphic" result="bright">
						<feFuncR type="linear" slope={3.9} intercept={-3.51} />
						<feFuncG type="linear" slope={3.9} intercept={-3.51} />
						<feFuncB type="linear" slope={3.9} intercept={-3.51} />
					</feComponentTransfer>
					<feGaussianBlur in="bright" stdDeviation={9.5} result="bloomSmall" />
					<feGaussianBlur in="bright" stdDeviation={19} result="bloomLarge" />
					<feMerge result="bloomMerge">
						<feMergeNode in="bloomLarge" />
						<feMergeNode in="bloomSmall" />
					</feMerge>
					<feBlend in="SourceGraphic" in2="bloomMerge" mode="screen" />
				</filter>
			</defs>
			{/* Off-cell placeholders (invisible, occupy space for consistent layout) */}
			<g opacity="0">
				{[0, 1, 2, 3, 4].map(ri =>
					[0, 1, 2, 3, 4].map(ci => (
						<circle key={`off-${ri}-${ci}`} cx={8 + ci * 19} cy={8 + ri * 19} r={8} fill="currentColor" />
					)),
				)}
			</g>
			{/* Animated on-cells: Manhattan-distance bloom from center (2,2) */}
			<g filter="url(#od-matrix-bloom)">
				{[0, 1, 2, 3, 4].map(ri =>
					[0, 1, 2, 3, 4].map(ci => {
						const d = Math.abs(ri - 2) + Math.abs(ci - 2);
						// Corner cells (d=4) are always off; center (d=0) always on.
						// The SMIL values mirror opendesign's 24-stop cycle.
						const hide = d === 4;
						const alwaysOn = d === 0;
						if (hide)
							return (
								<circle
									key={`on-${ri}-${ci}`}
									cx={8 + ci * 19}
									cy={8 + ri * 19}
									r={8}
									fill="currentColor"
									opacity={0}
								/>
							);
						if (alwaysOn)
							return (
								<circle key={`on-${ri}-${ci}`} cx={8 + ci * 19} cy={8 + ri * 19} r={8} fill="currentColor" />
							);
						return (
							<circle key={`on-${ri}-${ci}`} cx={8 + ci * 19} cy={8 + ri * 19} r={8} fill="currentColor">
								<animate
									attributeName="opacity"
									values="0.15;1;0.15"
									dur="1.333s"
									begin={`${d * 220}ms`}
									repeatCount="indefinite"
								/>
							</circle>
						);
					}),
				)}
			</g>
		</svg>
	);
}

/** 三合一 send control (user direction, opendesign parity): idle renders the
 *  plain send button; while the agent works the SAME button becomes the live
 *  state display — a capsule with the dot-matrix bloom + a morphing label
 *  ("工作中" at rest, "停止" on hover/focus). Click aborts the turn.
 *
 *  While the agent works AND the draft has content, a SECOND button appears
 *  beside it: queueing the message for after the turn instead of steering the
 *  running one. The capability already existed (settings.busyEnter chooses
 *  between steering and queueing on Enter) but was invisible — a user who did
 *  not know the setting could not discover it, and a message that steers the
 *  agent mid-turn is not always what someone typing during a long run wants.
 *  The two actions sit side by side. */
export function SendOrStopButton({
	canSend,
	busy,
	working,
	hasContent,
	onPress,
	onStop,
	onQueue,
}: {
	canSend: boolean;
	busy: boolean;
	working: boolean;
	/** Whether the draft holds anything to send. */
	hasContent: boolean;
	onPress(): void;
	onStop(): void;
	/** Queue the draft for after the current turn. */
	onQueue?(): void;
}): ReactNode {
	// Hover/focus drives the label morph (工作中 ↔ 停止) so the swap reads as
	// a rolling text transition instead of a hard visibility toggle.
	const [interacting, setInteracting] = useState(false);
	if (!working) {
		return (
			<button
				type="button"
				className="gui-composer-send"
				onClick={canSend && !busy ? onPress : undefined}
				disabled={!canSend || busy}
				title={t("settings.sendMessage")}
				aria-label={t("settings.sendMessage")}
			>
				<SendHorizontal size={14} />
			</button>
		);
	}
	return (
		<>
			{onQueue && hasContent && (
				<button
					type="button"
					className="gui-composer-queue"
					onClick={onQueue}
					title={t("composer.queueForNextTurn")}
					aria-label={t("composer.queueForNextTurn")}
				>
					<ListPlus size={14} />
				</button>
			)}
			<button
				type="button"
				className="gui-composer-send gui-composer-send--working"
				onClick={onStop}
				onMouseEnter={() => setInteracting(true)}
				onMouseLeave={() => setInteracting(false)}
				onFocus={() => setInteracting(true)}
				onBlur={() => setInteracting(false)}
				title={t("composer.stopCurrentTurn")}
				aria-label={t("composer.stopCurrentTurn")}
			>
				<span className="gui-send-work">
					<MatrixLoader className="gui-send-matrix" />
					<span className="gui-send-labels">
						{/* Invisible widest label reserves constant pill width across the
						 * morph (工作中 is longer than 停止), so the button never
						 * nudges the composer on hover. */}
						<span aria-hidden className="gui-send-label gui-send-label--sizer">
							{t("composer.workingActive")}
						</span>
						<TextMorph
							text={interacting ? t("composer.stopTurn") : t("composer.workingActive")}
							className="gui-send-morph"
						/>
					</span>
				</span>
			</button>
		</>
	);
}

/** Focus mode toggle (⌘⇧E): the composer fills the surface. */
export function FocusButton({ focused, onPress }: { focused: boolean; onPress(): void }): ReactNode {
	return (
		<button
			type="button"
			className={`gui-composer-ico${focused ? " gui-composer-ico--active" : ""}`}
			onClick={onPress}
			title={t("general.focusMode")}
			aria-label={t("general.focusMode")}
			aria-pressed={focused}
		>
			<Icon name="expand-up-down" className="h-3.5 w-3.5" />
		</button>
	);
}
