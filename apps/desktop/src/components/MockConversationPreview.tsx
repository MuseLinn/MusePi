/*
 * MockConversationPreview — the simulated conversation view shared by
 * Settings → 外观 (the page's hero) and Settings → 语音 「语音测试」. Both
 * pages need a small mock chat that tracks the REAL transcript markup (the
 * same tr-* classes the chat surface renders), so a setting toggle reads in
 * the preview exactly as it lands in a conversation:
 *
 *  - one agent identity capsule (.gui-agent-capsule, the real pill) over the
 *    rows: its orb follows the avatar toggle while the status text stays, so
 *    the toggle previews what it does in the chat (the user picture lives in
 *    the rail's account entry and is not part of this preview)
 *  - user messages: .tr-row--user right-side bubble (the transcript's user
 *    row) with an EMPTY gutter, like the real chat
 *  - assistant messages: .tr-row--assistant with an empty gutter + optional
 *    row actions (the voice test mounts its read-aloud button there, same
 *    .tr-action slot the transcript's speak button uses)
 *  - a 活动 fold row (.tr-round-fold, the real fold classes) between the
 *    sample turns; `activity` picks the resting (collapsed) or opened form
 *  - the composer card mock (.gui-effect-preview-composer, the frosted-glass
 *    look of the real input frame); voice overrides it with a live mic
 *
 * `framed` turns the whole scene into the session card itself (appearance
 * hero): the chat surface, the capsule floating over the head band and the
 * composer docked on the bottom edge. The default is the plain settings box.
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
import { agentDisplayName, agentRoleLabel, DEFAULT_AGENT_ROLE } from "../lib/surfaces/agent-role";
import { Icon } from "../vendor/oc-icons";
import { AgentAvatar } from "./AgentAvatar";

/**
 * Agent identity capsule for the mock — the real `.gui-agent-capsule` pill,
 * centered in its own band because the chat's absolutely-positioned head row
 * has no counterpart here. Same two-line reading as the chat's: the 28px orb
 * beside a copy column whose first line is the agent name + lane tag and whose
 * second line is the state dot, live state and recency. `showAvatar` is the
 * 显示头像 toggle: it drops the orb and keeps the copy, exactly as the real
 * capsule behaves.
 */
function MockAgentCapsule({ showAvatar = true }: { showAvatar?: boolean }): ReactNode {
	const role = DEFAULT_AGENT_ROLE;
	const displayName = agentDisplayName(role);
	const roleLabel = agentRoleLabel(role);
	return (
		<div className="gui-effect-preview-identity">
			<div className="gui-agent-capsule" data-agent-status="idle" data-agent-role={role.id} title={displayName}>
				<span className="gui-agent-capsule-avatar">
					{showAvatar && <AgentAvatar state="listening" size={28} />}
				</span>
				<span className="gui-agent-capsule-copy">
					<span className="gui-agent-capsule-line">
						<span className="gui-agent-capsule-name">{displayName}</span>
						{roleLabel !== displayName && <span className="gui-agent-role-tag">{roleLabel}</span>}
					</span>
					<span className="gui-agent-capsule-meta">
						<span className="gui-agent-capsule-dot" aria-hidden="true" />
						<span className="gui-agent-capsule-status">{t("general.agentCapsuleIdle")}</span>
						<span className="gui-agent-capsule-sep" aria-hidden="true" />
						<span className="gui-agent-capsule-time">{t("transcript.justNow")}</span>
					</span>
				</span>
			</div>
		</div>
	);
}

/** Mock user message — the transcript's user-row markup (right-aligned
 *  bubble); body goes through the shared Markdown renderer. The gutter is
 *  empty like the real chat, where the user picture lives in the rail's
 *  account entry. `showAvatar` is accepted for existing callers (the voice
 *  page) and no longer affects the row. */
export function MockUserRow({ markdown }: { markdown: string; showAvatar?: boolean }): ReactNode {
	return (
		<div className="tr-row tr-row--user">
			<div className="tr-gutter" />
			<div className="tr-body">
				<Markdown text={markdown} />
			</div>
		</div>
	);
}

/** Mock assistant message — the transcript's assistant-row markup with an
 *  empty gutter (the orb is the capsule above); `actions` mounts into the
 *  real .tr-actions slot (voice passes its read-aloud button there).
 *  `showAvatar` is accepted for existing callers and no longer affects the
 *  row. */
export function MockAssistantRow({
	markdown,
	actions,
}: {
	markdown: string;
	showAvatar?: boolean;
	actions?: ReactNode;
}): ReactNode {
	return (
		<div className="tr-row tr-row--assistant">
			<div className="tr-gutter" />
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
			<span className="tr-round-fold-label">{t("agents.activity")}</span>
			<span className="tr-round-fold-bar" aria-hidden />
			<span className="tr-round-fold-changes">
				<span className="tr-round-fold-changes-files">{t("transcript.roundChangedWithCount", { count: "3" })}</span>
				<span className="tr-round-fold-add">+24</span>
				<span className="tr-round-fold-remove">−7</span>
			</span>
			<span className="tr-round-fold-sep">·</span>
			<span>{t("transcript.roundCommandsWithCount", { count: "2" })}</span>
		</div>
	);
}

/** Mock 活动 block: the rounded summary header a completed round folds into,
 *  plus — when `open` — the process rows it reveals. The header nests in a
 *  railed assistant row so it lines up with the reply's column (one turn, one
 *  left edge); a bare header would sit flush under the transcript's gutter. */
function MockActivity({ open }: { open: boolean }): ReactNode {
	return (
		<div className="tr-row tr-row--assistant tr-row--railed">
			<div className="tr-gutter" />
			<div className="tr-body">
				<MockActivityFoldRow open={open} />
				{open && (
					<div className="tr-activity-preview-rows">
						<div className="tr-activity-preview-row">{t("general.previewActivityEdit")}</div>
						<div className="tr-activity-preview-row">{t("general.previewActivityCommand")}</div>
						<div className="tr-activity-preview-row">{t("general.previewActivityRead")}</div>
						<div className="tr-live-more">{t("tools.moreLinesWithCount", { count: "6" })}</div>
					</div>
				)}
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
		<div className="gui-effect-preview-composer gui-liquid-glass">
			<div className="gui-effect-preview-inputrow">
				<span className="gui-effect-preview-input">{input ?? t("composer.askAnythingCommands.info")}</span>
			</div>
			{/* Footer line mirrors the real composer: mode agent, model, then the
			 * send target on the right. Static — this is a styling preview, not
			 * an input the reader can type into. */}
			<div className="gui-effect-preview-tools">
				<span className="gui-effect-preview-chip">
					<Icon name="sparkling" className="h-3 w-3" />
					{t("settings.agent")}
				</span>
				<span className="gui-effect-preview-chip">{t("preview statusbar model")}</span>
				{mic}
				<span className="gui-effect-preview-spacer" />
				<span className="gui-effect-preview-send" aria-hidden>
					<Icon name="send-plane" className="h-3.5 w-3.5" />
				</span>
			</div>
		</div>
	);
}

/** Assembled simulated conversation: identity capsule → sample user turn →
 *  活动 fold → sample assistant reply, over the mock composer. Setting
 *  toggles drive the chrome (capsule orb / info status bar);
 *  `extraMessages` appends rows before the composer (voice accumulates
 *  dictated user messages there); `composer` replaces the static mock input
 *  card with a live one. */
export function MockConversationPreview({
	showAvatars = true,
	userMarkdown,
	assistantMarkdown,
	assistantActions,
	extraMessages,
	composer,
	framed = false,
	activity = "expanded",
}: {
	/** 显示头像 toggle — drives the capsule's orb (rows carry no avatars). */
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
	/** Render as the session card itself (appearance hero): the surface the
	 *  chat paints, the capsule floating over the transcript's head band and
	 *  the composer docked at the bottom edge. Off keeps the plain settings
	 *  box the voice test mounts. */
	framed?: boolean;
	/** 活动 fold state. The resting chat shows the collapsed summary, so the
	 *  hero uses it; the opened form demonstrates the revealed process rows. */
	activity?: "collapsed" | "expanded";
}): ReactNode {
	return (
		<div className={`gui-effect-preview${framed ? " gui-effect-preview--session" : ""}`}>
			<MockAgentCapsule showAvatar={showAvatars} />
			<div className="gui-effect-preview-body">
				<MockUserRow markdown={userMarkdown ?? t("general.previewUserMessage")} />
				{/* One block, both fold states: the collapsed header is the resting
				 * form a finished turn keeps; `open` shows the rows the toggle
				 * reveals. The hero uses the resting form, a live-turn demo the
				 * opened one. */}
				<MockActivity open={activity === "expanded"} />
				<MockAssistantRow
					markdown={assistantMarkdown ?? t("general.previewAgentMessage")}
					actions={assistantActions}
				/>
				{extraMessages}
			</div>
			{composer ?? <MockComposer />}
		</div>
	);
}

/**
 * Looping typewriter demo for the chat preview — driven by the SAME
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
	return t("tools.previewParagraph");
}
