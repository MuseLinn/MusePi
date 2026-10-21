import { CodeHighlightProvider, renderMermaidHtml, Segmented, type SegmentedOption, t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { tapFeedback } from "../../lib/haptic";
import { useChatHighlight } from "../../lib/highlight";
import { STATS_MODE_EVENT, STATS_MODE_KEY } from "../composer/stats-pills";

/** Segmented option tables — module scope is fine, the labels are static
 * per locale and the settings view remounts on a language switch. */
const MERMAID_SEGMENTS: SegmentedOption<"svg" | "ascii">[] = [
	{ value: "svg", label: t("settings.svg") },
	{ value: "ascii", label: t("settings.ascii") },
];

const DIFF_LAYOUT_SEGMENTS: SegmentedOption<"dynamic" | "inline" | "side-by-side">[] = [
	{ value: "dynamic", label: t("settings.dynamic") },
	{ value: "inline", label: t("settings.alwaysInline") },
	{ value: "side-by-side", label: t("settings.alwaysSideSide") },
];

const OUTPUT_STYLE_SEGMENTS: SegmentedOption<"default" | "kimi" | "zcode">[] = [
	{ value: "default", label: t("settings.outputStyleDefault") },
	{ value: "kimi", label: t("settings.outputStyleKimi") },
	{ value: "zcode", label: t("settings.outputStyleZcode") },
];

const TYPING_EFFECT_SEGMENTS: SegmentedOption<"typewriter" | "burst" | "shimmer" | "glitch" | "flip" | "ink">[] = [
	{ value: "typewriter", label: t("settings.typingEffectTypewriter") },
	{ value: "burst", label: t("settings.typingEffectBurst") },
	{ value: "shimmer", label: t("settings.typingEffectShimmer") },
	{ value: "glitch", label: t("settings.typingEffectGlitch") },
	{ value: "flip", label: t("settings.typingEffectFlip") },
	{ value: "ink", label: t("settings.typingEffectInk") },
];

/** Composer stats row density (§5w) — same localStorage key the row reads. */
const STATS_MODE_SEGMENTS: SegmentedOption<"detailed" | "compact">[] = [
	{ value: "detailed", label: t("general.statsModeDetailed") },
	{ value: "compact", label: t("general.statsModeCompact") },
];

/** Small persisted toggle with a settings-row label (shared by the new tabs). */
export function PrefToggle({
	label,
	description,
	storageKey,
	onClass,
	on = true,
	disabled = false,
	onChange,
}: {
	label: string;
	description: string;
	storageKey: string;
	/** Optional class toggled on <html> while the pref is OFF. */
	onClass?: string;
	/** Default value when the key is unset. */
	on?: boolean;
	/** Grey the row out and block interaction (a conflicting pref is active). */
	disabled?: boolean;
	/** Notified with the new value after the toggle commits. */
	onChange?: (on: boolean) => void;
}): ReactNode {
	const [onState, setOnState] = useState<boolean>(() => {
		try {
			const v = localStorage.getItem(storageKey);
			return v === null ? on : v !== "0";
		} catch {
			return on;
		}
	});
	return (
		<div className={`gui-settings-row${disabled ? " gui-settings-row--disabled" : ""}`}>
			<div>
				<div className="gui-settings-row-label">{label}</div>
				<div className="gui-settings-row-desc">{description}</div>
			</div>
			<button
				type="button"
				role="switch"
				aria-checked={onState}
				disabled={disabled}
				className={`gui-toggle${onState ? " gui-toggle--on" : ""}`}
				onClick={() => {
					tapFeedback();
					const next = !onState;
					setOnState(next);
					try {
						localStorage.setItem(storageKey, next ? "1" : "0");
					} catch {
						// ignore
					}
					if (onClass) document.documentElement.classList.toggle(onClass, !next);
					onChange?.(next);
				}}
				aria-label={label}
			>
				<span className="gui-toggle-knob" />
			</button>
		</div>
	);
}

/** Segmented alternative to PrefToggle (e.g. 用户消息渲染: Markdown/纯文本). */
export function PrefSegmented<T extends string>({
	label,
	description,
	storageKey,
	options,
	defaultValue,
}: {
	label: string;
	description: string;
	storageKey: string;
	options: readonly { id: T; label: string }[];
	defaultValue: T;
}): ReactNode {
	const [value, setValue] = useState<T>(() => {
		try {
			const v = localStorage.getItem(storageKey);
			return options.some(o => o.id === v) ? (v as T) : defaultValue;
		} catch {
			return defaultValue;
		}
	});
	return (
		<div className="gui-settings-row">
			<div>
				<div className="gui-settings-row-label">{label}</div>
				<div className="gui-settings-row-desc">{description}</div>
			</div>
			<Segmented
				ariaLabel={label}
				value={value}
				options={options.map(o => ({ value: o.id, label: o.label }))}
				onChange={v => {
					setValue(v);
					try {
						localStorage.setItem(storageKey, v);
					} catch {
						// ignore
					}
				}}
			/>
		</div>
	);
}

/**
 * 消息自动折叠 (Kimi parity, default ON): fold a turn's working process when
 * the turn completes, showing only the summary. Bespoke instead of PrefToggle
 * because the underlying storage key keeps the LEGACY inverted contract —
 * `musepi-gui-chat-roundfold` stores "default EXPANDED" ("1") vs collapsed /
 * auto-fold ("0" or unset) — so the toggle reads/writes the inverted value
 * and existing user state migrates without a new storage channel. ChatView
 * keeps reading the raw key; this toggle dispatches the companion
 * `musepi-roundfold-default-changed` event with the expanded flag.
 */
function AutoFoldToggle(): ReactNode {
	const [onState, setOnState] = useState<boolean>(() => {
		try {
			const v = localStorage.getItem("musepi-gui-chat-roundfold");
			return v === null || v !== "1";
		} catch {
			return true;
		}
	});
	return (
		<div className="gui-settings-row">
			<div>
				<div className="gui-settings-row-label">{t("settings.messageAutoFold")}</div>
				<div className="gui-settings-row-desc">{t("settings.messageAutoFoldDescription")}</div>
			</div>
			<button
				type="button"
				role="switch"
				aria-checked={onState}
				className={`gui-toggle${onState ? " gui-toggle--on" : ""}`}
				onClick={() => {
					tapFeedback();
					const next = !onState;
					setOnState(next);
					try {
						localStorage.setItem("musepi-gui-chat-roundfold", next ? "0" : "1");
					} catch {
						// ignore
					}
					window.dispatchEvent(new CustomEvent("musepi-roundfold-default-changed", { detail: !next }));
				}}
				aria-label={t("settings.messageAutoFold")}
			>
				<span className="gui-toggle-knob" />
			</button>
		</div>
	);
}

/** Chat display settings (transcript rendering) — rendered as a block at
 *  the bottom of 外观 (previously the standalone 聊天设置 tab; merged
 *  2026-08-12 so transcript rendering prefs live with the rest of the
 *  appearance options). All prefs are renderer-local (localStorage). */
export function ChatSection(): ReactNode {
	const [mermaidModeState, setMermaidModeState] = useState<"svg" | "ascii">(() => {
		try {
			return localStorage.getItem("musepi-gui-chat-mermaid") === "ascii" ? "ascii" : "svg";
		} catch {
			return "svg";
		}
	});
	// Widget standalone display — when ON, the in-tool-card toggle below
	// is inert (tool cards collapse; the widget lives on its own card).
	const [widgetStandalone, setWidgetStandalone] = useState<boolean>(() => {
		try {
			return (localStorage.getItem("musepi-gui-widget-standalone") ?? "1") !== "0";
		} catch {
			return true;
		}
	});
	const [diffLayoutState, setDiffLayoutState] = useState<"dynamic" | "inline" | "side-by-side">(() => {
		try {
			const v = localStorage.getItem("musepi-gui-chat-difflayout");
			return v === "dynamic" || v === "side-by-side" ? v : "inline";
		} catch {
			return "inline";
		}
	});
	const [outputStyle, setOutputStyle] = useState<"default" | "kimi" | "zcode">(() => {
		try {
			const v = localStorage.getItem("musepi-gui-chat-output-style");
			return v === "kimi" || v === "zcode" ? v : "default";
		} catch {
			return "default";
		}
	});
	// 消息字号 — transcript body ladder (--tr-font-size on <html>; headings
	// and code scale off it in transcript.css). Independent of the interface
	// font slider: shell chrome follows --gui-font-scale, chat text follows
	// this one.
	const [chatFontSize, setChatFontSize] = useState<number>(() =>
		Number(localStorage.getItem("musepi-gui-chat-font-size") ?? 14),
	);
	const [typingEffect, setTypingEffect] = useState<"typewriter" | "burst" | "shimmer" | "glitch" | "flip" | "ink">(
		() => {
			try {
				const v = localStorage.getItem("musepi-gui-chat-effect");
				return v === "burst" || v === "shimmer" || v === "glitch" || v === "flip" || v === "ink" ? v : "typewriter";
			} catch {
				return "typewriter";
			}
		},
	);
	// 性能与用量 (§5w) — density of the composer stats row; the same key the
	// stats-pills plugin reads, and the companion event wakes its external store.
	const [statsMode, setStatsMode] = useState<"detailed" | "compact">(() => {
		try {
			return localStorage.getItem(STATS_MODE_KEY) === "compact" ? "compact" : "detailed";
		} catch {
			return "detailed";
		}
	});
	// Live previews re-render with the segments (mermaid svg/ascii + diff
	// layout) — same renderers the transcript uses, sample content only.
	const mermaidPreviewHtml = useMemo(() => renderMermaidHtml(MERMAID_SAMPLE, mermaidModeState), [mermaidModeState]);
	// Same highlighter the chat transcript uses (Electron IPC → tree-sitter
	// natives); the provider makes the preview's DiffBlock highlight too.
	const chatHighlight = useChatHighlight();
	return (
		<CodeHighlightProvider highlight={chatHighlight}>
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("settings.chatSettings")}</div>
				<div className="gui-settings-section-desc">{t("settings.chatSettingsDescription")}</div>
			</div>
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("tools.messageRendering")}</div>
				<PrefSegmented
					label={t("settings.userMessageRendering")}
					description={t("settings.userMessageRenderingDescription")}
					storageKey="musepi-gui-chat-usermsg"
					defaultValue="markdown"
					options={[
						{ id: "markdown", label: t("settings.markdown") },
						{ id: "plain", label: t("settings.plainText") },
					]}
				/>
				<PrefToggle
					label={t("settings.collapseLongUserMessages")}
					description={t("settings.collapseLongUserMessagesDescription")}
					storageKey="musepi-gui-chat-collapseuser"
				/>
				<AutoFoldToggle />
				<PrefToggle
					label={t("settings.toolCallSummary")}
					description={t("settings.toolCallSummaryDescription")}
					storageKey="musepi-gui-chat-toolsummary"
					onChange={on => window.dispatchEvent(new CustomEvent("musepi-toolsummary-changed", { detail: on }))}
				/>
				<PrefToggle
					label={t("settings.showReasoningTraces")}
					description={t("settings.showReasoningTracesDescription")}
					storageKey="musepi-gui-chat-thinking"
					onClass="gui-chat-hide-thinking"
				/>
				<PrefToggle
					label={t("settings.widgetStandalone")}
					description={t("settings.widgetStandaloneDescription")}
					storageKey="musepi-gui-widget-standalone"
					onChange={setWidgetStandalone}
				/>
				<PrefToggle
					label={t("settings.widgetsExpanded")}
					description={t("settings.widgetsExpandedDescription")}
					storageKey="musepi-gui-widget-expanded"
					disabled={widgetStandalone}
				/>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("settings.mermaidRendering")}</div>
						<div className="gui-settings-row-desc">{t("settings.mermaidRenderingDescription")}</div>
					</div>
					<Segmented
						ariaLabel={t("settings.mermaidRendering")}
						value={mermaidModeState}
						options={MERMAID_SEGMENTS}
						onChange={v => {
							setMermaidModeState(v);
							try {
								localStorage.setItem("musepi-gui-chat-mermaid", v);
							} catch {
								// ignore
							}
						}}
					/>
				</div>
				{/* The sample lives in 外观 → 效果预览 (MockConversationPreview) and
				 * scopes itself to this picker's value, so it is not drawn twice. */}
				<PrefToggle
					label={t("settings.streamingCaret")}
					description={t("settings.streamingCaretDescription")}
					storageKey="musepi-gui-chat-caret"
					onClass="gui-chat-no-caret"
				/>
				<PrefToggle
					label={t("settings.codeHighlight")}
					description={t("settings.codeHighlightDescription")}
					storageKey="musepi-gui-chat-codehl"
					onClass="gui-chat-plain-code"
				/>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("general.performanceUsage")}</div>
						<div className="gui-settings-row-desc">{t("general.performanceUsageDescription")}</div>
					</div>
					<Segmented
						ariaLabel={t("general.performanceUsage")}
						value={statsMode}
						options={STATS_MODE_SEGMENTS}
						onChange={v => {
							tapFeedback();
							setStatsMode(v);
							try {
								localStorage.setItem(STATS_MODE_KEY, v);
							} catch {
								// ignore
							}
							window.dispatchEvent(new Event(STATS_MODE_EVENT));
						}}
					/>
				</div>
			</div>

			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("tools.presentationStyle")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("settings.outputStyle")}</div>
						<div className="gui-settings-row-desc">{t("settings.outputStyleDescription")}</div>
					</div>
					<Segmented
						ariaLabel={t("settings.outputStyle")}
						value={outputStyle}
						options={OUTPUT_STYLE_SEGMENTS}
						onChange={v => {
							tapFeedback();
							setOutputStyle(v);
							try {
								localStorage.setItem("musepi-gui-chat-output-style", v);
							} catch {
								// ignore
							}
							document.documentElement.dataset.outputStyle = v;
						}}
					/>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("settings.typingEffect")}</div>
						<div className="gui-settings-row-desc">{t("settings.typingEffectDescription")}</div>
					</div>
					<div className="gui-settings-row-extra">
						{/* Six equal-width segments outgrow any shared row with the
						 * long description (labels clip at ~43px/item) — the extra
						 * slot drops the control to its own full-width line, and
						 * gui-seg--wide lifts the 260px cap so every label fits. */}
						<Segmented
							ariaLabel={t("settings.typingEffect")}
							className="gui-seg--compact gui-seg--wide"
							value={typingEffect}
							options={TYPING_EFFECT_SEGMENTS}
							onChange={v => {
								tapFeedback();
								setTypingEffect(v);
								try {
									localStorage.setItem("musepi-gui-chat-effect", v);
								} catch {
									// ignore
								}
								// No root-class swap here: the transcript applies the
								// effect only to the block that is streaming right now,
								// and this preview re-renders from `effect` below.
							}}
						/>
					</div>
				</div>
			</div>
		</CodeHighlightProvider>
	);
}

/** Sample content for the chat preview (Settings → 聊天 → 聊天预览). */
const MERMAID_SAMPLE = `graph TD
  A[用户提问] --> B{分析需求}
  B -->|明确| C[直接回答]
  B -->|需工具| D[调用工具]
  D --> E[汇总结果]
  C --> F[回复用户]
  E --> F`;

const DIFF_SAMPLE = `--- a/src/greet.ts
+++ b/src/greet.ts
@@ -1,5 +1,6 @@
 export function greet(name: string): string {
   const greeting = "Hello";
-  return greeting + ", " + name + "!";
+  const prefix = name ? "Hello" : "Hi";
+  return \`\${prefix}, \${name}!\`;
 }
+export const version = "1.2.0";
@@ -14,3 +14,3 @@
 function formatList(items: string[]): string {
   return items.join(", ");
 }`;
