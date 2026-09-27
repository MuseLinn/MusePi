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
 *    classes) between the sample turns
 *  - the composer card mock (.gui-effect-preview-composer, the frosted-glass
 *    look of the real input frame); voice overrides it with a live mic
 *
 * Message bodies render through the shared Markdown component — the same
 * renderer chat uses — so the preview shows real markdown (the voice TTS
 * sample leans on this for its code block).
 */
import { Markdown, t } from "@musepi/client-core";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
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
 *  into, so the preview shows the current collapsed-round styling. */
export function MockActivityFoldRow(): ReactNode {
	return (
		<div className="tr-round-fold" role="presentation">
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
	statusBarInfo = false,
	userMarkdown,
	assistantMarkdown,
	assistantActions,
	extraMessages,
	composer,
}: {
	/** 显示头像 toggle — drives both gutters. */
	showAvatars?: boolean;
	/** 信息状态条 toggle — renders the real status-bar strip above the
	 *  conversation when on. */
	statusBarInfo?: boolean;
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
}): ReactNode {
	return (
		<div className="gui-effect-preview">
			{/* 信息状态条 on → the preview carries the same strip above the
			 * mock conversation (real gui-statusbar-info classes, sample
			 * segments — model / context tokens), so the toggle reads here
			 * exactly as it lands in the chat. */}
			{statusBarInfo && (
				<div className="gui-statusbar-info" role="presentation">
					<span className="gui-statusbar-info-seg">{t("preview statusbar model")}</span>
					<span className="gui-statusbar-info-seg">{t("preview statusbar context")}</span>
				</div>
			)}
			<MockUserRow markdown={userMarkdown ?? t("preview user message")} showAvatar={showAvatars} />
			<MockActivityFoldRow />
			<MockAssistantRow
				markdown={assistantMarkdown ?? t("preview agent message")}
				showAvatar={showAvatars}
				actions={assistantActions}
			/>
			{extraMessages}
			{composer ?? <MockComposer />}
		</div>
	);
}
