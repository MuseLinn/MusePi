import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import type { ContextBreakdownView } from "../../lib/context-command";
import { Icon } from "../../vendor/oc-icons";
import type { SnapcompactSavingsView } from "../ContextRing";

/** Compact token count (K/M) for the context dialog. */
function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${Math.round(n / 1000)}K`;
	return String(n);
}

/** Snapcompact wire-savings detail lines (TUI /context legend parity):
 *  per-source savings when the model is vision-capable. `usedTokens` feeds
 *  the "next request" projection, mirroring the TUI's
 *  `Math.max(0, usedTokens - savedTokens)`. */
function renderSnapcompactLines(snap: SnapcompactSavingsView, usedTokens: number): ReactNode {
	const lines: ReactNode[] = [];
	if (snap.systemPrompt) {
		const sp = snap.systemPrompt;
		lines.push(
			<div className="gui-context-snap-line" key="sp">
				{sp.applied
					? t("system prompt imaged: {text} text → {frames} frames (saves ~{saved})", {
							text: fmtTokens(sp.textTokens),
							frames: String(sp.frames),
							saved: fmtTokens(sp.savedTokens),
						})
					: t("system prompt stays text ({reason})", {
							reason: t(
								sp.reason === "empty"
									? "reason: empty"
									: sp.reason === "margin"
										? "reason: insufficient savings"
										: "reason: image budget",
							),
						})}
			</div>,
		);
	}
	if (snap.toolResults) {
		const tr = snap.toolResults;
		lines.push(
			<div className="gui-context-snap-line" key="tr">
				{tr.swapped > 0
					? t("tool results: {imaged} imaged (saves ~{saved})", {
							imaged: String(tr.swapped),
							saved: fmtTokens(tr.savedTokens),
						})
					: t("tool results: none imaged ({total} in history)", { total: String(tr.total) })}
			</div>,
		);
	}
	if (snap.savedTokens > 0) {
		lines.push(
			<div className="gui-context-snap-line" key="next">
				{t("next request: ~{tokens} tokens on the wire", {
					tokens: fmtTokens(Math.max(0, usedTokens - snap.savedTokens)),
				})}
			</div>,
		);
	}
	return lines;
}

/** One category row of the /context dialog: glyph + name, tokens, percent
 *  bar. The glyph and color match the board cells (TUI /context legend
 *  parity) so the grid reads without hunting. */ function renderContextCat(
	label: string,
	tokens: number,
	window: number,
	glyph: string,
	colorClass: string,
): ReactNode {
	const percent = window > 0 ? (tokens / window) * 100 : 0;
	const isFree = label === "context free";
	return (
		<div className="gui-context-cat" key={label}>
			<div className="gui-context-cat-label">
				<span className="gui-context-cat-name">
					<span className={`gui-context-cat-glyph ${colorClass}`}>{glyph}</span>
					{t(label as never)}
				</span>
				<span className="gui-context-cat-pct">
					{fmtTokens(tokens)} tokens · {percent.toFixed(1)}%
				</span>
			</div>
			<div className="gui-usage-bar-track">
				<div
					className={`gui-usage-bar ${isFree ? "gui-usage-bar--ok" : "gui-usage-bar--accent"}`}
					style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
				/>
			</div>
		</div>
	);
}

/** TUI /context panel parity (modes/utils/context-usage.ts): the board is a
 *  20×10 = 200 cell grid. Categories render as filled ⛁ glyphs (messages as
 *  ⛃), free space as empty ⛶, the autocompact reserve as ⛝. Cells flow
 *  categories → free → buffer, same as the TUI. */
const CONTEXT_GRID_COLS = 20;
const CONTEXT_GRID_ROWS = 10;
const CONTEXT_GRID_CELLS = CONTEXT_GRID_COLS * CONTEXT_GRID_ROWS;
const CONTEXT_CELL_FILLED = "⛁";
const CONTEXT_CELL_MESSAGES = "⛃";
const CONTEXT_CELL_FREE = "⛶";
const CONTEXT_CELL_BUFFER = "⛝";

function renderContextGrid(breakdown: ContextBreakdownView, autoCompactBufferTokens = 0): ReactNode {
	const total = Math.max(1, breakdown.contextWindow);
	const cells = CONTEXT_GRID_CELLS;
	const cats: Array<{ n: number; cls: string; glyph: string }> = [
		{ n: breakdown.systemPromptTokens, cls: "gui-context-cell--system", glyph: CONTEXT_CELL_FILLED },
		{ n: breakdown.systemToolsTokens, cls: "gui-context-cell--tools", glyph: CONTEXT_CELL_FILLED },
		{ n: breakdown.systemContextTokens, cls: "gui-context-cell--context", glyph: CONTEXT_CELL_FILLED },
		{ n: breakdown.skillsTokens, cls: "gui-context-cell--skills", glyph: CONTEXT_CELL_FILLED },
		{ n: breakdown.messagesTokens, cls: "gui-context-cell--messages", glyph: CONTEXT_CELL_MESSAGES },
	];
	// TUI /context parity: every non-zero category occupies AT LEAST one
	// cell (Math.max(1, …)) — plain rounding drops small-but-present
	// categories (system prompt / skills / messages) to zero.
	const tokensPerCell = total / cells;
	const ratioCells = (tokens: number): number => (tokens <= 0 ? 0 : Math.max(1, Math.round(tokens / tokensPerCell)));
	const counts = cats.map(c => ratioCells(c.n));
	// Autocompact reserve cells come AFTER free space (TUI order); free fills
	// the remainder so the board sums to exactly 200.
	const bufferCount =
		autoCompactBufferTokens > 0 ? Math.max(1, Math.round(autoCompactBufferTokens / tokensPerCell)) : 0;
	let used = counts.reduce((a, b) => a + b, 0) + bufferCount;
	// Over-allocation (small windows where the at-least-one rule overruns):
	// trim from the LARGEST categories first so the board never overflows.
	if (used > cells) {
		const idx = counts.map((_, i) => i).sort((a, b) => counts[b]! - counts[a]!);
		for (const i of idx) {
			if (used <= cells) break;
			if (counts[i]! > 1) {
				counts[i] = counts[i]! - 1;
				used--;
			}
		}
	}
	const free = Math.max(0, cells - used);
	const cellList: Array<{ glyph: string; cls: string }> = [];
	for (let i = 0; i < cats.length; i++) {
		for (let j = 0; j < (counts[i] ?? 0); j++) cellList.push({ glyph: cats[i]!.glyph, cls: cats[i]!.cls });
	}
	for (let j = 0; j < free; j++) cellList.push({ glyph: CONTEXT_CELL_FREE, cls: "gui-context-cell--free" });
	for (let j = 0; j < bufferCount; j++) cellList.push({ glyph: CONTEXT_CELL_BUFFER, cls: "gui-context-cell--buffer" });
	return (
		<div className="gui-context-grid" role="img" aria-label="Context window visualization">
			{Array.from({ length: CONTEXT_GRID_ROWS }, (_, r) => (
				<div className="gui-context-grid-row" key={r}>
					{Array.from({ length: CONTEXT_GRID_COLS }, (_, c) => {
						const cell = cellList[r * CONTEXT_GRID_COLS + c];
						return cell ? (
							// Anonymous visual cells — index is identity.
							// biome-ignore lint/suspicious/noArrayIndexKey: grid cells
							<span key={c} className={`gui-context-cell ${cell.cls}`}>
								{cell.glyph}
							</span>
						) : null;
					})}
				</div>
			))}
		</div>
	);
}

/** Wire shape of the session.contextUsage response driving the /context
 *  card (contextWindow + per-category breakdown + snapcompact savings). */
export interface ContextUsageData {
	tokens: number;
	contextWindow: number;
	percent: number;
	model?: string | null;
	snapcompact?: SnapcompactSavingsView | null;
	breakdown?: ContextBreakdownView | null;
	autoCompactBufferTokens?: number;
	freeTokens?: number;
}

/** Floating /context card body (TUI /context panel parity): categorized
 *  context-window dialog rendered inside the composer's portaled menu. */
export function ContextUsageCard({
	data,
	loading,
	onClose,
}: {
	data: ContextUsageData | null;
	loading: boolean;
	onClose(): void;
}): ReactNode {
	return (
		<div className="gui-quota-panel" role="dialog" aria-label={t("context usage")}>
			<button type="button" className="gui-quota-close" onClick={onClose} aria-label={t("close")}>
				<Icon name="close" className="h-3.5 w-3.5" />
			</button>
			<div className="gui-quota-title">{t("context usage")}</div>
			{loading ? (
				<div className="gui-quota-note">…</div>
			) : data ? (
				<>
					{data.model && <div className="gui-context-model">{data.model}</div>}
					<div className="gui-context-summary">
						<span className="gui-context-summary-tokens">
							{t("context window {tokens} ({percent} used)", {
								tokens: fmtTokens(data.contextWindow),
								percent: `${Math.round(data.percent)}%`,
							})}
						</span>
					</div>
					{data.breakdown && renderContextGrid(data.breakdown, data.autoCompactBufferTokens ?? 0)}
					{data.snapcompact && (
						<div className="gui-context-snap">
							<div className="gui-context-snap-title">
								{data.snapcompact.visionCapable
									? t("snapcompact savings")
									: `Snapcompact: ${t("model does not support images")}`}
							</div>
							{data.snapcompact.visionCapable &&
								renderSnapcompactLines(data.snapcompact, data.tokens ?? data.breakdown?.usedTokens ?? 0)}
						</div>
					)}
					{data.breakdown ? (
						<div className="gui-context-cats">
							{renderContextCat(
								"context system prompt",
								data.breakdown.systemPromptTokens,
								data.contextWindow,
								CONTEXT_CELL_FILLED,
								"gui-context-glyph--system",
							)}
							{renderContextCat(
								"context system tools",
								data.breakdown.systemToolsTokens,
								data.contextWindow,
								CONTEXT_CELL_FILLED,
								"gui-context-glyph--tools",
							)}
							{renderContextCat(
								"context system context",
								data.breakdown.systemContextTokens,
								data.contextWindow,
								CONTEXT_CELL_FILLED,
								"gui-context-glyph--context",
							)}
							{renderContextCat(
								"context skills",
								data.breakdown.skillsTokens,
								data.contextWindow,
								CONTEXT_CELL_FILLED,
								"gui-context-glyph--skills",
							)}
							{renderContextCat(
								"context messages",
								data.breakdown.messagesTokens,
								data.contextWindow,
								CONTEXT_CELL_MESSAGES,
								"gui-context-glyph--messages",
							)}
							{renderContextCat(
								"context free",
								data.freeTokens ??
									Math.max(
										0,
										data.contextWindow - data.breakdown.usedTokens - (data.autoCompactBufferTokens ?? 0),
									),
								data.contextWindow,
								CONTEXT_CELL_FREE,
								"gui-context-glyph--free",
							)}
							{(data.autoCompactBufferTokens ?? 0) > 0 &&
								renderContextCat(
									"context autocompact buffer",
									data.autoCompactBufferTokens ?? 0,
									data.contextWindow,
									CONTEXT_CELL_BUFFER,
									"gui-context-glyph--buffer",
								)}
						</div>
					) : (
						<div className="gui-quota-note">{t("context usage unavailable")}</div>
					)}
				</>
			) : (
				<div className="gui-quota-note">{t("context usage unavailable")}</div>
			)}
		</div>
	);
}
