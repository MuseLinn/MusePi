/**
 * Character-level streaming reveal — the "逐字输出" engine behind the
 * 平滑流式渲染 setting.
 *
 * Ported from the TUI's StreamingRevealController
 * (coding-agent/src/modes/controllers/streaming-reveal.ts), trimmed to the
 * text-block case the transcript needs. The three non-obvious pieces are
 * kept intact:
 *
 *  1. Proportional catch-up (Cherry Studio / proma parity): the reveal is
 *     rAF-driven and each frame advances `max(1, ceil(backlog/8))`
 *     graphemes — a token burst is absorbed over ~8 frames at ANY delivery
 *     speed, while a trickle advances one grapheme per frame. There is NO
 *     fixed floor (a slow model must not look like a fast one) and NO
 *     skip-jump (a fast stream drains smoothly instead of popping whole
 *     chunks — the user-visible "限制速度/卡一下才渲染" bugs).
 *  2. Incremental grapheme counting: `BlockUnitCounter` re-segments only
 *     the tail after an append (an append can only alter the final cluster
 *     of the previous text, e.g. "👨" + "\u200D👩" merges into one
 *     cluster), so naive re-slicing never goes O(N²).
 *  3. Render is per-grapheme: one "字" = one grapheme (a ZWJ emoji family
 *     is a single unit), so CJK and emoji both reveal naturally.
 */

/** Proportional drain divisor — the backlog is eaten over ~8 frames. */
export const CATCHUP_FRAMES = 8;
/** Floor step per frame — a trickle still advances at least one grapheme. */
export const MIN_STEP = 1;
/** rAF frame (kept for the settings preview's simulated cadence). */
export const STREAMING_REVEAL_FRAME_MS = 1000 / 60;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function getSegmenter(): Intl.Segmenter {
	return segmenter;
}

/** Number of graphemes in `text`. */
export function countGraphemes(text: string): number {
	if (text.length === 0) return 0;
	let count = 0;
	for (const _seg of segmenter.segment(text)) count += 1;
	return count;
}

/** Count graphemes of `text` from code-unit offset `start`, also reporting the
 *  start offset of the final grapheme (where an append could extend a cluster). */
function countGraphemesFrom(text: string, start: number): { count: number; tailStart: number } {
	let count = 0;
	let tailStart = start;
	for (const seg of segmenter.segment(start === 0 ? text : text.slice(start))) {
		count += 1;
		tailStart = start + seg.index;
	}
	return { count, tailStart };
}

/** Segment `text` from code-unit offset `start`, walking up to `clusters`
 *  graphemes. Returns the code-unit END of the final cluster walked, its START
 *  (`lastStart`), and how many clusters were found (`count` may be less than
 *  `clusters` if the suffix is shorter than requested). */
function segmentFrom(text: string, start: number, clusters: number): { end: number; lastStart: number; count: number } {
	let count = 0;
	let lastStart = start;
	let end = start;
	for (const seg of segmenter.segment(start === 0 ? text : text.slice(start))) {
		count += 1;
		lastStart = start + seg.index;
		end = start + seg.index + seg.segment.length;
		if (count >= clusters) break;
	}
	return { end, lastStart, count };
}

/**
 * Memoizes per-block grapheme counts across reveal ticks. Streaming blocks
 * only grow by appending, and an append can only alter the final grapheme
 * cluster of the previous text, so only the suffix from that cluster needs
 * re-segmenting.
 */
export class BlockUnitCounter {
	#entries = new Map<number, { text: string; count: number; tailStart: number }>();
	#sliceEntries = new Map<number, { text: string; units: number; end: number; lastStart: number }>();

	count(index: number, text: string): number {
		const entry = this.#entries.get(index);
		if (entry !== undefined) {
			if (entry.text === text) return entry.count;
			if (entry.count > 0 && text.length > entry.text.length && text.startsWith(entry.text)) {
				const tail = countGraphemesFrom(text, entry.tailStart);
				const next = { text, count: entry.count - 1 + tail.count, tailStart: tail.tailStart };
				this.#entries.set(index, next);
				return next.count;
			}
		}
		const full = countGraphemesFrom(text, 0);
		this.#entries.set(index, { text, count: full.count, tailStart: full.tailStart });
		return full.count;
	}

	reset(): void {
		this.#entries.clear();
		this.#sliceEntries.clear();
	}

	/** Slice `text` to its first `units` graphemes. Memoized across reveal ticks:
	 *  streaming blocks grow only by appending and the reveal target advances
	 *  monotonically, so a previously sliced prefix is reused and only the suffix
	 *  from the boundary cluster is re-segmented. */
	slice(index: number, text: string, units: number): string {
		if (units <= 0 || text.length === 0) return "";
		const entry = this.#sliceEntries.get(index);
		if (entry !== undefined && entry.text === text && entry.units === units) {
			return entry.end >= text.length ? text : text.slice(0, entry.end);
		}
		if (entry !== undefined && (entry.text === text || text.startsWith(entry.text)) && units >= entry.units) {
			const extra = units - entry.units + 1;
			const seg = segmentFrom(text, entry.lastStart, extra);
			this.#sliceEntries.set(index, { text, units, end: seg.end, lastStart: seg.lastStart });
			return seg.end >= text.length ? text : text.slice(0, seg.end);
		}
		const seg = segmentFrom(text, 0, units);
		this.#sliceEntries.set(index, { text, units, end: seg.end, lastStart: seg.lastStart });
		return seg.end >= text.length ? text : text.slice(0, seg.end);
	}
}

/** Slice `text` to its first `units` graphemes (stateless, for one-off use). */
export function sliceGraphemes(text: string, units: number): string {
	if (units <= 0 || text.length === 0) return "";
	let count = 0;
	for (const { index, segment } of segmenter.segment(text)) {
		count += 1;
		if (count >= units) {
			const end = index + segment.length;
			return end >= text.length ? text : text.slice(0, end);
		}
	}
	return text;
}

/** Adaptive per-frame step: catch up a large backlog in ~8 frames, floor at MIN_STEP. */
export function nextStep(backlog: number): number {
	return Math.max(MIN_STEP, Math.ceil(Math.max(0, backlog) / CATCHUP_FRAMES));
}

/** Next reveal position: advance by the proportional catch-up step, never
 *  overshooting the delivered text. NO skip-jump — even a very fast stream
 *  drains over ~8 frames instead of popping whole chunks (proma / Cherry
 *  Studio proportional-drain parity). */
export function nextRevealPosition(revealed: number, total: number): number {
	return Math.min(total, revealed + nextStep(total - revealed));
}

/** Golden-angle hue walk (137.508° apart — max perceptual spacing). */
export const RAINBOW_HUE_STEP = 137.508;

/**
 * Typewriter fade tail: the last N graphemes of the revealed prefix fade
 * in (opacity 0.25→1 right-to-left) instead of popping in. Position-window
 * driven (no timestamps, no state), so it survives the per-frame
 * innerHTML rebuild — every frame recomputes the same window and the
 * rebuilt spans carry the current opacities.
 */
export const TYPING_FADE_WINDOW = 10;

/** Fade opacity for the `localIndex`-th grapheme inside the fade window
 * (0 = oldest/leftmost, already near-opaque; windowSize-1 = newest/rightmost). */
export function typingFadeOpacity(localIndex: number, windowSize: number = TYPING_FADE_WINDOW): number {
	const span = Math.max(1, windowSize - 1);
	return 0.25 + 0.75 * (1 - localIndex / span);
}

/**
 * Rainbow-burst entrance (彩虹烟花): each new grapheme appears with a
 * saturated rainbow color + multi-layer glow, then settles back to the
 * normal reading color by the time it leaves the window (~9 frames ≈
 * 300ms at 30fps). Position-window driven like the fade tail, so it
 * survives the per-frame innerHTML rebuild (recomputed every frame).
 *   Index convention matches typingFadeOpacity and the DOM pass: the
 * caller passes localIndex in DOCUMENT order (0 = oldest/leftmost
 * grapheme of the window, already settled; windowSize-1 = newest,
 * bursting). A 1-wide window's only grapheme IS the newest → bursts.
 */
export const BURST_WINDOW = 9;

/** CSS style for the `localIndex`-th grapheme inside the burst window,
 * or null once settled (caller then emits plain text, no span). */
export function burstStyleFor(localIndex: number, windowSize: number = BURST_WINDOW): {
	opacity: string;
	color?: string;
	textShadow?: string;
} | null {
	const denom = Math.max(1, windowSize - 1);
	// 0 = oldest (settled) → 1; windowSize-1 = newest (bursting) → 0.
	const ratio = windowSize <= 1 ? 0 : Math.min(1, 1 - localIndex / denom);
	if (ratio >= 0.999) return null; // settled — plain text, no span
	const hue = Math.round(ratio * 280); // red (new) → violet (settling)
	const glow = 1 - ratio;
	return {
		opacity: String(Math.min(1, 0.2 + 1.5 * ratio)),
		color: `hsl(${hue} 90% 62%)`,
		textShadow: `0 0 ${(glow * 12 + 3).toFixed(1)}px hsl(${hue} 100% 68%), 0 0 ${(glow * 22 + 5).toFixed(1)}px hsl(${(hue + 100) % 360} 100% 62%)`,
	};
}

/**
 * 3D card flip (逐字翻牌): each new grapheme flips in — rotateX 90°→0°
 * under its own perspective while opacity rises. Per-grapheme, unlike the
 * old block-level clip-path scan the user rejected. Same position-window
 * convention: localIndex 0 = oldest (settled) → null; windowSize-1 =
 * newest (still flipped 90°). inline-block transform requires the span to
 * be inline-block (per-grapheme, so layout stays inline flow).
 */
export const FLIP_WINDOW = 9;

export function flipStyleFor(localIndex: number, windowSize: number = FLIP_WINDOW): {
	display: string;
	opacity: string;
	transform: string;
} | null {
	const denom = Math.max(1, windowSize - 1);
	// 0 = oldest (flipped in, settled) → 1; newest → 0 (90°).
	const ratio = windowSize <= 1 ? 0 : Math.min(1, 1 - localIndex / denom);
	if (ratio >= 0.999) return null;
	const deg = Math.round(90 * (1 - ratio)); // 90° (new) → 0° (settled)
	return {
		display: "inline-block",
		opacity: String(Math.min(1, ratio / 0.55)),
		transform: `perspective(400px) rotateX(${deg}deg)`,
	};
}

/**
 * Glitch garbling (故障乱码): newest graphemes briefly show a random
 * full-width glyph with strong RGB-split shadow, then settle to their
 * real character with the split decaying. The garbled glyph is chosen
 * per frame (each innerHTML rebuild re-rolls it → the garbled window
 * visibly flickers, matching the Kimi reference's multi-step scramble).
 *   localIndex 0 = oldest (settled) → null; newest → garbled + strong
 * split. windowSize 4 ≈ 130ms of garble at 30fps (Kimi: 3×40ms).
 */
export const GLITCH_WINDOW = 4;
export const GLITCH_CHARS = "█▓▒░▞▚"; // full-width-ish, keeps line width

/** True while the grapheme should show a scrambled glyph instead of its
 * real character (the newest ~2 window slots). */
export function glitchScrambled(localIndex: number, windowSize: number = GLITCH_WINDOW): boolean {
	return localIndex >= Math.max(1, windowSize - 2);
}

/** Random garbled glyph for the scramble window (per-frame re-roll). */
export function glitchGlyph(): string {
	return GLITCH_CHARS[Math.floor(Math.random() * GLITCH_CHARS.length)];
}

export function glitchStyleFor(localIndex: number, windowSize: number = GLITCH_WINDOW): {
	textShadow: string;
	transform: string;
} | null {
	const denom = Math.max(1, windowSize - 1);
	const ratio = Math.min(1, 1 - localIndex / denom);
	if (ratio >= 0.999) return null;
	const jitter = (2.5 * (1 - ratio)).toFixed(1);
	const dx = (Math.random() * 2 - 1) * Number(jitter);
	return {
		textShadow: `-${jitter}px 0 rgba(255,64,64,0.85), ${jitter}px 0 rgba(64,200,255,0.85)`,
		transform: `translateX(${dx.toFixed(1)}px)`,
	};
}

/**
 * Ink wash (水墨, per-grapheme, Kimi inkIn parity): each new grapheme
 * bleeds in like ink on paper — blur + oversize scale + low opacity,
 * settling to crisp normal text. Position-window convention: 0 = oldest
 * (settled) → null; windowSize-1 = newest (still bleeding).
 */
export const INK_WINDOW = 9;

export function inkStyleFor(localIndex: number, windowSize: number = INK_WINDOW): {
	display: string;
	opacity: string;
	filter: string;
	transform: string;
} | null {
	const denom = Math.max(1, windowSize - 1);
	const ratio = windowSize <= 1 ? 0 : Math.min(1, 1 - localIndex / denom);
	if (ratio >= 0.999) return null;
	return {
		display: "inline-block",
		opacity: String(Math.min(1, 0.35 + 0.65 * ratio)),
		filter: `blur(${(2.5 * (1 - ratio)).toFixed(1)}px)`,
		transform: `scale(${(1.5 - 0.5 * ratio).toFixed(2)})`,
	};
}

/**
 * Unified tail-window renderer table — shared by the transcript DOM pass
 * (Markdown.tsx) and the settings preview. Each entry maps a grapheme's
 * position inside the tail window to either null (settled → plain text)
 * or { text, style, cls } (styled span; cls lets the DOM pass unwind
 * leftover spans when streaming stops).
 */
export type TailRender = (
	localIndex: number,
	word: string,
) => { text: string; style: Record<string, string>; cls: string } | null;

export const TAIL_RENDERERS: Record<string, { windowSize: number; render: TailRender }> = {
	typewriter: {
		windowSize: TYPING_FADE_WINDOW,
		render: (local, word) => ({
			text: word,
			style: { opacity: String(typingFadeOpacity(local)) },
			cls: "tr-typewriter-fade",
		}),
	},
	burst: {
		windowSize: BURST_WINDOW,
		render: (local, word) => {
			const style = burstStyleFor(local);
			return style ? { text: word, style, cls: "tr-typewriter-burst" } : null;
		},
	},
	flip: {
		windowSize: FLIP_WINDOW,
		render: (local, word) => {
			const style = flipStyleFor(local);
			return style ? { text: word, style, cls: "tr-typewriter-flip" } : null;
		},
	},
	glitch: {
		windowSize: GLITCH_WINDOW,
		render: (local, word) => {
			const style = glitchStyleFor(local);
			if (!style) return null;
			const text = glitchScrambled(local) ? glitchGlyph() : word;
			return { text, style, cls: "tr-typewriter-glitch" };
		},
	},
	ink: {
		windowSize: INK_WINDOW,
		render: (local, word) => {
			const style = inkStyleFor(local);
			return style ? { text: word, style, cls: "tr-typewriter-ink" } : null;
		},
	},
};

/**
 * Split `text` into graphemes with a hue per word (dazzle typing effect's
 * DOM pass): each grapheme becomes a span colored hsl(hue 85% var(--tr-dazzle-l)).
 * A ZWJ emoji family stays one word (one hue) — same segmentation as the
 * reveal engine.
 */
export function graphemeSpans(text: string): Array<{ word: string; hue: number }> {
	const out: Array<{ word: string; hue: number }> = [];
	let hue = 0;
	for (const { segment } of segmenter.segment(text)) {
		out.push({ word: segment, hue });
		hue = (hue + RAINBOW_HUE_STEP) % 360;
	}
	return out;
}
