/*
 * MockConversationPreview — the simulated conversation view shared by
 * Settings → 外观 「效果预览」 and Settings → 语音 「语音测试」. Both pages
 * need a small mock chat that tracks the REAL transcript markup (the same
 * tr-* classes the chat surface renders), so a setting toggle reads in the
 * preview exactly as it lands in a conversation:
 *
 *  - user messages: .tr-row--user right-side bubble (the transcript's user
 *    row), with the user gutter chip when avatars are on
 *  - assistant messages: .tr-row--assistant with the live AgentAvatar orb
 *    in the gutter (avatar display toggle drives it) + optional row actions
 *    (the voice test mounts its read-aloud button there, same .tr-action
 *    slot the transcript's speak button uses)
 *  - a collapsed-round 活动 summary row (.tr-round-fold, the real fold
 *    classes) between the sample turns, in BOTH fold states
 *  - optional output-style scoping (`outputStyle`): the presets are --tr-*
 *    variable overrides keyed off [data-output-style], so wrapping the sample
 *    in that attribute previews the exact transcript typography
 *  - the composer card mock (.gui-effect-preview-composer, the frosted-glass
 *    look of the real input frame); voice overrides it with a live mic
 *
 * Message bodies render through the shared Markdown component — the same
 * renderer chat uses — so the preview shows real markdown (the voice TTS
 * sample leans on this for its code block).
 */
import {
	countGraphemes,
	graphemeSpans,
	Markdown,
	nextStep,
	STREAMING_REVEAL_FRAME_MS,
	sliceGraphemes,
	TAIL_RENDERERS,
	t,
} from "@musepi/client-core";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import "../i18n/preview";
import { Icon } from "../vendor/oc-icons";
import { AgentAvatar } from "./AgentAvatar";

/** User gutter chip for the mock — the real UserAvatar resolves git/GitHub
 *  identity over RPC; the preview renders the same .gui-user-avatar chip
 *  with the generic user glyph (identity is irrelevant to what is being
 *  previewed). */
function MockUserAvatar(): ReactNode {
	return (
		<span className="gui-user-avatar" title={t("you")}>
			<Icon name="user" className="h-3.5 w-3.5" />
		</span>
	);
}

/** Mock user message — the transcript's user-row markup (right-aligned
 *  bubble); body goes through the shared Markdown renderer. The gutter
 *  carries the user chip only when avatars are on (the real transcript
 *  renders an empty gutter with avatars disabled). */
export function MockUserRow({ markdown, showAvatar = true }: { markdown: string; showAvatar?: boolean }): ReactNode {
	return (
		<div className="tr-row tr-row--user">
			<div className="tr-gutter">{showAvatar && <MockUserAvatar />}</div>
			<div className="tr-body">
				<Markdown text={markdown} />
			</div>
		</div>
	);
}

/** Mock assistant message — the transcript's assistant-row markup with the
 *  live orb avatar in the gutter; `actions` mounts into the real .tr-actions
 *  slot (voice passes its read-aloud button there). */
export function MockAssistantRow({
	markdown,
	showAvatar = true,
	actions,
}: {
	markdown: string;
	/** Avatar display toggle (设置 → 外观 → 显示头像) — off renders the bare
	 *  left column, exactly like the transcript with avatars disabled. */
	showAvatar?: boolean;
	actions?: ReactNode;
}): ReactNode {
	return (
		<div className="tr-row tr-row--assistant">
			<div className="tr-gutter">{showAvatar && <AgentAvatar state="working" size={64} />}</div>
			<div className="tr-body">
				<Markdown text={markdown} />
			</div>
			{actions !== undefined && <div className="tr-actions">{actions}</div>}
		</div>
	);
}

/** Mock 活动 fold header — the real .tr-round-fold summary row (boxed
 *  chevron + 活动 label + what-happened segments) a completed round folds
 *  into, so the preview shows the current collapsed-round styling.
 *  `open` renders the OPENED form (rotated chevron + expanded class), so the
 *  preview shows both states of the control rather than only the collapsed
 *  one the user actually clicks on. */
export function MockActivityFoldRow({ open = false }: { open?: boolean }): ReactNode {
	return (
		<div className={`tr-round-fold${open ? " tr-round-fold--open" : ""}`} role="presentation">
			<span className="tr-round-fold-icon" aria-hidden>
				<ChevronRight size={12} />
			</span>
			<span className="tr-round-fold-label">{t("activity")}</span>
			<span className="tr-round-fold-bar" aria-hidden />
			<span className="tr-round-fold-changes">
				<span className="tr-round-fold-changes-files">{t("round changed {count}", { count: "3" })}</span>
				<span className="tr-round-fold-add">+24</span>
				<span className="tr-round-fold-remove">−7</span>
			</span>
			<span className="tr-round-fold-sep">·</span>
			<span>{t("round commands {count}", { count: "2" })}</span>
		</div>
	);
}

/** Mock EXPANDED round: the opened 活动 header plus the process rows it
 *  reveals, then the "+N more" count a trimmed running turn shows.
 *
 *  The preview previously showed only the collapsed header, so the two states
 *  the fold toggle actually moves between were never both on screen — the
 *  expanded side is where the header's rotated chevron, the revealed tool
 *  rows and the tail count live, and a styling change there was invisible. */
function MockExpandedActivity(): ReactNode {
	return (
		<div className="tr-activity-preview-expanded" role="presentation">
			<MockActivityFoldRow open />
			<div className="tr-activity-preview-rows">
				<div className="tr-activity-preview-row">{t("preview activity edit")}</div>
				<div className="tr-activity-preview-row">{t("preview activity command")}</div>
				<div className="tr-activity-preview-row">{t("preview activity read")}</div>
				<div className="tr-live-more">{t("⋯ {count} more lines", { count: "6" })}</div>
			</div>
		</div>
	);
}

/** Mock composer card — the frosted-glass input frame look. `mic` mounts a
 *  real control before the send glyph (the voice test passes its dictation
 *  button); `input` replaces the placeholder (recording status / level). */
export function MockComposer({
	mic,
	input,
}: {
	mic?: ReactNode;
	/** Input-area override; defaults to the localized placeholder. */
	input?: ReactNode;
}): ReactNode {
	return (
		<div className="gui-effect-preview-composer">
			<div className="gui-effect-preview-input">{input ?? t("ask anything, / for commands, @ for context…")}</div>
			{mic}
			<span className="gui-effect-preview-send" aria-hidden>
				<Icon name="send-plane" className="h-3.5 w-3.5" />
			</span>
		</div>
	);
}

/** Assembled simulated conversation: sample user turn → 活动 fold → sample
 *  assistant reply, over the mock composer. Setting toggles drive the
 *  chrome (avatars / info status bar); `extraMessages` appends rows before
 *  the composer (voice accumulates dictated user messages there);
 *  `composer` replaces the static mock input card with a live one. */
export function MockConversationPreview({
	showAvatars = true,
	userMarkdown,
	assistantMarkdown,
	assistantActions,
	extraMessages,
	composer,
	outputStyle,
	streamingDemo = false,
}: {
	/** 显示头像 toggle — drives both gutters. */
	showAvatars?: boolean;
	/** Sample user message (defaults to the appearance sample). */
	userMarkdown?: string;
	/** Sample assistant reply (defaults to the appearance sample). */
	assistantMarkdown?: string;
	/** Extra row actions on the assistant reply (voice: read-aloud). */
	assistantActions?: ReactNode;
	/** Rows appended after the sample assistant reply (voice: dictated turns). */
	extraMessages?: ReactNode;
	/** Composer footer override (voice passes a live-mic composer). */
	composer?: ReactNode;
	/** Draw the streaming motion demo under the sample (chat settings). */
	streamingDemo?: boolean;
	/** Output-style preset id — scopes the sample to that preset's --tr-*
	 *  typography. Omitted by hosts that do not offer the setting. */
	outputStyle?: string;
}): ReactNode {
	return (
		<div className="gui-effect-preview" data-output-style={outputStyle}>
			<MockUserRow markdown={userMarkdown ?? t("preview user message")} showAvatar={showAvatars} />
			<MockActivityFoldRow />
			{/* Both fold states, so a styling change to either is visible here:
			 * the collapsed header above is what a finished turn rests as, and
			 * the expanded block below is what clicking it reveals. */}
			<MockExpandedActivity />
			<MockAssistantRow
				markdown={assistantMarkdown ?? t("preview agent message")}
				showAvatar={showAvatars}
				actions={assistantActions}
			/>
			{/* The streaming motion demo lives with the sample it animates: the
			 * output-style presets and the typing effect are both judged on this
			 * text, so drawing them in one place keeps the two readings honest. */}
			{streamingDemo && (
				<div className="gui-effect-preview-stream">
					<div className="gui-chat-preview-label">{t("typing effect")}</div>
					<TypewriterPreview />
				</div>
			)}
			{extraMessages}
			{composer ?? <MockComposer />}
		</div>
	);
}

/**
 * Looping typewriter demo for the output-style preview — driven by the SAME
 * reveal engine the transcript uses (proportional nextStep catch-up +
 * grapheme slicing), so the preview shows the real 逐字输出 motion: a token
 * burst drains over ~8 frames, a trickle advances 1 grapheme/frame. Follows
 * the 平滑流式渲染 toggle: off → the full text appears instantly.
 */
export function TypewriterPreview(): ReactNode {
	const text = useTypewriterSample();
	const smoothOn = (() => {
		// display.smoothStreaming is the single source of truth (the old
		// musepi-gui-chat-smooth localStorage key is dead — the toggle
		// merged into 外观). ChatView flips the html class from the daemon
		// setting; the preview follows the same class so the demo shows the
		// real behavior instead of a stale default.
		try {
			return !document.documentElement.classList.contains("gui-chat-no-smooth");
		} catch {
			return true;
		}
	})();
	const effect = (() => {
		try {
			const v = localStorage.getItem("musepi-gui-chat-effect");
			return v === "burst" || v === "shimmer" || v === "glitch" || v === "flip" || v === "ink" ? v : "typewriter";
		} catch {
			return "typewriter";
		}
	})();
	const total = countGraphemes(text);
	const [arrived, setArrived] = useState(0);
	const [shown, setShown] = useState(0);
	const [done, setDone] = useState(false);
	// Replay cycle: increments 1.8s after each demo settles; the arrival
	// effect below depends on it, so the demo restarts (the preview loops).
	const [cycle, setCycle] = useState(0);
	const arrivedRef = useRef(0);
	useEffect(() => {
		arrivedRef.current = arrived;
	}, [arrived]);
	useEffect(() => {
		if (!smoothOn) {
			setArrived(total);
			setShown(total);
			setDone(true);
			return;
		}
		setArrived(0);
		setShown(0);
		setDone(false);
		// Simulated model token stream: 2–3 graphemes arrive every 110ms
		// (~23 chars/s, like a real model), while the reveal eats the
		// backlog at the transcript's own cadence (3/frame floor, catch-up
		// on bursts) — so the preview shows the ACTUAL smooth-streaming
		// motion at a readable pace, not a one-shot dump.
		const arrival = setInterval(() => {
			setArrived(a => {
				if (a >= total) {
					clearInterval(arrival);
					return a;
				}
				return Math.min(total, a + 2 + Math.floor(Math.random() * 2));
			});
		}, 110);
		const reveal = setInterval(() => {
			setShown(s => {
				const target = arrivedRef.current;
				return Math.min(target, s + nextStep(target - s));
			});
		}, STREAMING_REVEAL_FRAME_MS);
		return () => {
			clearInterval(arrival);
			clearInterval(reveal);
		};
		// effect in deps: switching the typing-effect preset restarts the
		// demo immediately (the preview must track the engine's selection).
		// cycle: replay loop — each increment restarts the demo.
	}, [smoothOn, total, cycle]);
	useEffect(() => {
		if (!done || !smoothOn) return;
		const id = setTimeout(() => setCycle(c => c + 1), 1800);
		return () => clearTimeout(id);
	}, [done, smoothOn]);
	useEffect(() => {
		if (smoothOn && arrived >= total && shown >= total) setDone(true);
	}, [arrived, shown, total, smoothOn]);
	const display = smoothOn ? sliceGraphemes(text, shown) : text;
	// The effect only applies while the demo is "typing" — once done, the
	// full text shows plain (no gradient/spans/jitter), same contract as
	// the real transcript: finished output is never colored.
	const eff = done ? "typewriter" : effect;
	// shimmer applies via the CSS class on this .tr-md root (the only
	// preset with pure-CSS styling); the rest render per-grapheme spans
	// through TAIL_RENDERERS. typewriter carries no class.
	const effectCls = eff === "shimmer" ? " gui-chat-effect-shimmer" : "";
	return (
		<div className={`tr-md gui-typewriter${done ? "" : " gui-typewriter--live"}${effectCls}`}>
			<p>
				{(() => {
					const cfg = TAIL_RENDERERS[eff];
					if (!cfg || !smoothOn || done || countGraphemes(display) <= cfg.windowSize) return display;
					const n = countGraphemes(display);
					const head = sliceGraphemes(display, n - cfg.windowSize);
					const tail = graphemeSpans(display.slice(head.length));
					return (
						<>
							{head}
							{tail.map(({ word }, i) => {
								const r = cfg.render(i, word);
								return r ? (
									<span key={i} className={r.cls} style={r.style}>
										{r.text}
									</span>
								) : (
									<span key={i}>{word}</span>
								);
							})}
						</>
					);
				})()}
				{eff === "typewriter" && !done && <span className="gui-typewriter-caret" />}
			</p>
		</div>
	);
}

/** Sample sentence the typewriter demo types out (i18n, keeps it localized). */
export function useTypewriterSample(): string {
	return t("preview paragraph");
}
