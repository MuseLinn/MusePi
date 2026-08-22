import { Check as CheckIconData, WandSparkles as WandSparklesIconData } from "lucide";
import { SendHorizontal, Square, WandSparkles } from "lucide-react";
import { MorphIcon } from "morphicons/react";
import type { CSSProperties, ReactNode } from "react";
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

/** Opencode opendesign's 5×5 dot-matrix "cross expand" glyph (desktop-web parity).
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

/**
 * 三合一 send control (user direction, opendesign parity): idle renders the
 * plain send button; while the agent works the SAME button becomes the live
 * state display — a capsule with the dot-matrix bloom + a two-label stack
 * ("工作中" at rest, "停止" on hover/focus). Click aborts the turn.
 */
export function SendOrStopButton({
	canSend,
	busy,
	working,
	onPress,
	onStop,
	accent,
}: {
	canSend: boolean;
	busy: boolean;
	working: boolean;
	onPress(): void;
	onStop(): void;
	/** Session accent hex (TUI-style per-session color); null → theme accent. */
	accent?: string | null;
}): ReactNode {
	if (!working) {
		return (
			<button
				type="button"
				className="gui-composer-send"
				onClick={canSend && !busy ? onPress : undefined}
				disabled={!canSend || busy}
				title={t("send message")}
				aria-label={t("send message")}
			>
				<SendHorizontal size={14} />
			</button>
		);
	}
	return (
		<button
			type="button"
			className="gui-composer-send gui-composer-send--working"
			style={accent ? ({ "--gui-send-accent": accent } as CSSProperties) : undefined}
			onClick={onStop}
			title={t("stop the current turn")}
			aria-label={t("stop the current turn")}
		>
			<span className="gui-send-work">
				<MatrixLoader className="gui-send-matrix" />
				<span className="gui-send-labels">
					<span className="gui-send-label gui-send-label--working">{t("working active")}</span>
					<span className="gui-send-label gui-send-label--stop">{t("stop turn")}</span>
				</span>
			</span>
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
