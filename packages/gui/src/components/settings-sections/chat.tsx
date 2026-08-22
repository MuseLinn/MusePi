import {
	CodeHighlightProvider,
	countGraphemes,
	DiffBlock,
	graphemeSpans,
	nextStep,
	renderMermaidHtml,
	STREAMING_REVEAL_FRAME_MS,
	sliceGraphemes,
	TAIL_RENDERERS,
	t,
} from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { tapFeedback } from "../../lib/haptic";
import { useChatHighlight } from "../../lib/highlight";
import { NumberStepper } from "./shared";

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
			<div className="gui-segmented">
				{options.map(o => (
					<button
						key={o.id}
						type="button"
						className={`gui-seg-btn${value === o.id ? " gui-seg-btn--active" : ""}`}
						onClick={() => {
							setValue(o.id);
							try {
								localStorage.setItem(storageKey, o.id);
							} catch {
								// ignore
							}
						}}
					>
						{o.label}
					</button>
				))}
			</div>
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
				return v === "burst" || v === "shimmer" || v === "glitch" || v === "flip" || v === "ink" ? v : "ink";
			} catch {
				return "ink";
			}
		},
	);
	// Live previews re-render with the segments (mermaid svg/ascii + diff
	// layout) — same renderers the transcript uses, sample content only.
	const mermaidPreviewHtml = useMemo(() => renderMermaidHtml(MERMAID_SAMPLE, mermaidModeState), [mermaidModeState]);
	// Same highlighter the chat transcript uses (Electron IPC → tree-sitter
	// natives); the provider makes the preview's DiffBlock highlight too.
	const chatHighlight = useChatHighlight();
	return (
		<CodeHighlightProvider highlight={chatHighlight}>
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("chat settings")}</div>
				<div className="gui-settings-section-desc">{t("chat settings description")}</div>
			</div>
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("message rendering")}</div>
				<PrefSegmented
					label={t("user message rendering")}
					description={t("user message rendering description")}
					storageKey="musepi-gui-chat-usermsg"
					defaultValue="markdown"
					options={[
						{ id: "markdown", label: t("markdown") },
						{ id: "plain", label: t("plain text") },
					]}
				/>
				<PrefToggle
					label={t("collapse long user messages")}
					description={t("collapse long user messages description")}
					storageKey="musepi-gui-chat-collapseuser"
				/>
				<PrefToggle
					label={t("show reasoning traces")}
					description={t("show reasoning traces description")}
					storageKey="musepi-gui-chat-thinking"
					onClass="gui-chat-hide-thinking"
				/>
				<PrefToggle
					label={t("widget standalone")}
					description={t("widget standalone description")}
					storageKey="musepi-gui-widget-standalone"
					onChange={setWidgetStandalone}
				/>
				<PrefToggle
					label={t("widgets expanded")}
					description={t("widgets expanded description")}
					storageKey="musepi-gui-widget-expanded"
					disabled={widgetStandalone}
				/>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("mermaid rendering")}</div>
						<div className="gui-settings-row-desc">{t("mermaid rendering description")}</div>
					</div>
					<div className="gui-segmented">
						{(["svg", "ascii"] as const).map(m => (
							<button
								key={m}
								type="button"
								className={`gui-seg-btn${mermaidModeState === m ? " gui-seg-btn--active" : ""}`}
								onClick={() => {
									setMermaidModeState(m);
									try {
										localStorage.setItem("musepi-gui-chat-mermaid", m);
									} catch {
										// ignore
									}
								}}
							>
								{m === "svg" ? t("svg") : t("ascii")}
							</button>
						))}
					</div>
				</div>
				<div className="gui-chat-preview-inline">
					<div className="gui-chat-preview-label">{t("mermaid preview")}</div>
					{/* biome-ignore lint/security/noDangerouslySetInnerHtml: built by renderMermaidHtml (escaped source) */}
					<div className="gui-chat-preview-mermaid" dangerouslySetInnerHTML={{ __html: mermaidPreviewHtml }} />
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("diff layout")}</div>
						<div className="gui-settings-row-desc">{t("diff layout description")}</div>
					</div>
					<div className="gui-segmented">
						{(
							[
								{ id: "dynamic", label: t("dynamic") },
								{ id: "inline", label: t("always inline") },
								{ id: "side-by-side", label: t("always side by side") },
							] as const
						).map(o => (
							<button
								key={o.id}
								type="button"
								className={`gui-seg-btn${diffLayoutState === o.id ? " gui-seg-btn--active" : ""}`}
								onClick={() => {
									setDiffLayoutState(o.id);
									try {
										localStorage.setItem("musepi-gui-chat-difflayout", o.id);
									} catch {
										// ignore
									}
								}}
							>
								{o.label}
							</button>
						))}
					</div>
				</div>
				<div className="gui-chat-preview-inline">
					<div className="gui-chat-preview-label">{t("diff preview")}</div>
					{/* tr-card--diff container: same aicss file-diff tinting the transcript
					 * ToolCard applies (accent bar + green/red row tints). */}
					<div className="tr-card--diff">
						<DiffBlock diff={DIFF_SAMPLE} layout={diffLayoutState} />
					</div>
				</div>
			</div>
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("interface and input")}</div>
				<PrefToggle
					label={t("preserve draft messages")}
					description={t("preserve draft messages description")}
					storageKey="musepi-gui-chat-draft"
				/>
				<PrefToggle
					label={t("enable spell check in text input")}
					description={t("enable spell check in text input description")}
					storageKey="musepi-gui-chat-spellcheck"
					on={false}
				/>
				<PrefToggle
					label={t("show timestamps")}
					description={t("time next to assistant messages")}
					storageKey="musepi-gui-chat-time"
					onClass="gui-chat-hide-time"
				/>
				<PrefToggle
					label={t("row actions")}
					description={t("row actions description")}
					storageKey="musepi-gui-chat-rowactions"
					onClass="gui-chat-hide-row-actions"
				/>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("message font size")}</div>
						<div className="gui-settings-row-desc">{t("message font size description")}</div>
					</div>
					<NumberStepper
						label={t("message font size")}
						value={chatFontSize}
						min={12}
						max={20}
						unit="px"
						defaultValue={14}
						onChange={v => {
							setChatFontSize(v);
							try {
								localStorage.setItem("musepi-gui-chat-font-size", String(v));
							} catch {
								// ignore
							}
							document.documentElement.style.setProperty("--tr-font-size", `${v}px`);
						}}
					/>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("output style")}</div>
						<div className="gui-settings-row-desc">{t("output style description")}</div>
					</div>
					<div className="gui-segmented">
						{(
							[
								{ id: "default", label: t("output style default") },
								{ id: "kimi", label: t("output style kimi") },
								{ id: "zcode", label: t("output style zcode") },
							] as const
						).map(o => (
							<button
								key={o.id}
								type="button"
								className={`gui-seg-btn${outputStyle === o.id ? " gui-seg-btn--active" : ""}`}
								onClick={() => {
									tapFeedback();
									setOutputStyle(o.id);
									try {
										localStorage.setItem("musepi-gui-chat-output-style", o.id);
									} catch {
										// ignore
									}
									document.documentElement.dataset.outputStyle = o.id;
								}}
							>
								{o.label}
							</button>
						))}
					</div>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("typing effect")}</div>
						<div className="gui-settings-row-desc">{t("typing effect description")}</div>
					</div>
					<div className="gui-segmented">
						{(
							[
								{ id: "typewriter", label: t("typing effect typewriter") },
								{ id: "burst", label: t("typing effect burst") },
								{ id: "shimmer", label: t("typing effect shimmer") },
								{ id: "glitch", label: t("typing effect glitch") },
								{ id: "flip", label: t("typing effect flip") },
								{ id: "ink", label: t("typing effect ink") },
							] as const
						).map(o => (
							<button
								key={o.id}
								type="button"
								className={`gui-seg-btn${typingEffect === o.id ? " gui-seg-btn--active" : ""}`}
								onClick={() => {
									tapFeedback();
									setTypingEffect(o.id);
									try {
										localStorage.setItem("musepi-gui-chat-effect", o.id);
									} catch {
										// ignore
									}
									// No root-class swap here: the transcript applies the
									// effect only to the block that is streaming right now,
									// and this preview re-renders from `effect` below.
								}}
							>
								{o.label}
							</button>
						))}
					</div>
				</div>
				<div className="gui-chat-preview-inline">
					<div className="gui-chat-preview-label">{t("output style preview")}</div>
					<div className="gui-chat-preview-desc">{t("output style preview description")}</div>
					{/* The output-style presets are --tr-* variable overrides keyed
					 * off [data-output-style] — scoping this container to the
					 * picker's value previews the exact transcript typography.
					 * The typewriter demo shows the 逐字输出 (smooth streaming)
					 * motion under that typography: reveal + live caret. */}
					<div data-output-style={outputStyle} className="gui-chat-preview-style">
						<TypewriterPreview />
						<div className="tr-md gui-chat-preview-static">
							<h2>{t("preview heading")}</h2>
							<p>{t("preview paragraph")}</p>
							<pre>
								<code>{t("preview code")}</code>
							</pre>
							<ul>
								<li>{t("preview list item")}</li>
								<li>{t("preview list item")}</li>
							</ul>
						</div>
					</div>
				</div>
				<PrefToggle
					label={t("streaming caret")}
					description={t("streaming caret description")}
					storageKey="musepi-gui-chat-caret"
					onClass="gui-chat-no-caret"
				/>
				<PrefToggle
					label={t("code highlight")}
					description={t("code highlight description")}
					storageKey="musepi-gui-chat-codehl"
					onClass="gui-chat-plain-code"
				/>
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
		try {
			// PrefToggle writes "1"/"0" — absent key = default on.
			const v = localStorage.getItem("musepi-gui-chat-smooth");
			return v === null ? true : v !== "0";
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
