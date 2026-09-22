/**
 * Incremental turn derivation (0.5.0 P0② — transcript virtualization
 * companion). Replaces the per-frame full-list `buildRoundFolds` +
 * `buildTurnRenderUnits` recomputation, which was the dominant streaming
 * cost on long sessions (mem-bench: ~200ms/frame at 42k entries).
 *
 * Exploits the store's append-mostly immutability (client.ts keeps
 * `this.#entries` append-only — new entry objects, never in-place
 * mutation): a round's FOLD/UNIT content depends only on its own span, so
 * per-round results are cached keyed by the span's endpoint ids + length
 * and verified by endpoint object identity. Streaming appends only
 * recompute the in-flight round; history prepends shift absolute indexes
 * but hit the same cache keys.
 *
 * Structural sharing: when a call finds every round unchanged (same
 * segmentation signature, all cache hits), the PREVIOUS result arrays are
 * returned by reference — downstream memos keyed on them stay valid.
 */

import type { SessionEntry } from "@musepi/pi-wire";
import {
	type BuildTurnRenderUnitsOptions,
	buildTurnRenderUnits,
	type TurnRenderUnit,
	turnUnitSpan,
} from "./render-units.js";
import { buildRoundFolds, foldSpan, isTurnStart, type RoundFold } from "./round-collapse.js";

export interface TurnDeriveResult {
	folds: RoundFold[];
	units: TurnRenderUnit[];
}

interface SpanCacheEntry {
	/** Identity guards against in-place mutation of the endpoint entries
	 *  (store is append-only today; if that ever changes we recompute
	 *  instead of serving stale span data). */
	startObj: unknown;
	endObj: unknown;
	fold: ReturnType<typeof foldSpan>;
	unit: ReturnType<typeof turnUnitSpan>;
}

export interface TurnDeriveCache {
	spans: Map<string, SpanCacheEntry>;
	/** Last call's structural signature → enables reference-stable results. */
	lastSig: string | null;
	lastResult: TurnDeriveResult | null;
	/** First/last entry object identity guards the signature short-circuit
	 *  against in-place tail mutation (the store is append-only today; this
	 *  catches a hypothetical mutating store serving stale derives). */
	firstObj: unknown;
	lastObj: unknown;
}

export function createTurnDeriveCache(): TurnDeriveCache {
	return { spans: new Map(), lastSig: null, lastResult: null, firstObj: null, lastObj: null };
}

function entryId(e: SessionEntry | undefined, posFallback: number): string {
	const id = (e as { id?: unknown } | undefined)?.id;
	return typeof id === "string" && id.length > 0 ? id : `pos:${posFallback}`;
}

function entryUserId(e: SessionEntry): string | null {
	return e.type === "message" ? (e.id ?? null) : null;
}

/**
 * Derive the completed-round folds and turn render units for a transcript,
 * reusing cached per-round spans wherever the round's content is unchanged.
 * Output shape is identical to `buildRoundFolds` + `buildTurnRenderUnits`.
 */
export function deriveTurns(
	entries: readonly SessionEntry[],
	working: boolean,
	options?: BuildTurnRenderUnitsOptions,
	cache?: TurnDeriveCache,
): TurnDeriveResult {
	const c = cache ?? createTurnDeriveCache();

	// Structural signature — when nothing changed since the last call the
	// previous result is returned BY REFERENCE (downstream memos stay valid).
	const firstEntry = entries[0];
	const lastEntry = entries[entries.length - 1];
	const sig = `${entries.length}:${entryId(firstEntry, 0)}:${entryId(lastEntry, entries.length - 1)}:${
		working ? 1 : 0
	}:${options?.fallbackModel ?? ""}`;
	if (
		c.lastResult !== null &&
		c.lastSig === sig &&
		c.firstObj === firstEntry &&
		c.lastObj === lastEntry &&
		firstEntry !== undefined
	) {
		return c.lastResult;
	}

	// ── Round segmentation: one cheap predicate scan ─────────────────────
	// (isTurnStart = a type check + a role compare — microseconds even at
	// 42k entries, versus the classification work below.)
	const starts: number[] = [];
	for (let i = 0; i < entries.length; i++) {
		if (isTurnStart(entries[i])) starts.push(i);
	}

	// ── Model resolution: one full pass of `type === "model_change"`
	// compares — cheap, and a turn's model depends on every change before
	// it, so it cannot be span-cached. ────────────────────────────────────
	const endIdxs = new Set<number>();
	for (let t = 0; t < starts.length; t++) {
		endIdxs.add((t + 1 < starts.length ? starts[t + 1]! : entries.length) - 1);
	}
	const modelAtEnd = new Map<number, string>();
	let currentModel = options?.fallbackModel;
	const shortModel = (m: string): string => {
		const slash = m.lastIndexOf("/");
		return slash > 0 && slash < m.length - 1 ? m.slice(slash + 1) : m;
	};
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i]!;
		if (e.type === "model_change") currentModel = e.model;
		if (currentModel !== undefined && endIdxs.has(i)) modelAtEnd.set(i, shortModel(currentModel));
	}

	// ── Per-round spans, cache-first ─────────────────────────────────────
	const seenKeys = new Set<string>();
	const folds: RoundFold[] = [];
	const units: TurnRenderUnit[] = [];
	for (let t = 0; t < starts.length; t++) {
		const startIdx = starts[t]!;
		const endIdx = (t + 1 < starts.length ? starts[t + 1]! : entries.length) - 1;
		const isLastTurn = t === starts.length - 1;
		const startEntry = entries[startIdx]!;
		const endEntry = entries[endIdx]!;
		const startId = entryId(startEntry, startIdx);
		const key = `${startId}→${entryId(endEntry, endIdx)}#${endIdx - startIdx + 1}`;
		seenKeys.add(key);
		let span = c.spans.get(key);
		if (span === undefined || span.startObj !== startEntry || span.endObj !== endEntry) {
			// The span body is computed identically whether or not the round
			// is in flight — the `working` gate is applied at MATERIALIZATION
			// (below), so a working→idle flip reuses the cached span.
			const fold = foldSpan(entries, startIdx, entryUserId(startEntry), endIdx);
			const unit = turnUnitSpan(entries, startIdx, endIdx);
			span = { startObj: startEntry, endObj: endEntry, fold, unit };
			c.spans.set(key, span);
		}
		// Trailing round folds only once the agent stops (same boundary
		// buildRoundFolds uses).
		const fold = isLastTurn && working ? null : span.fold;
		if (fold !== null) {
			const f = fold;
			folds.push({
				startIdx,
				endIdx,
				finalIdx: startIdx + f.finalRel,
				headerIdx: startIdx + 1,
				toolCount: f.toolCount,
				commandCount: f.commandCount,
				exploreCount: f.exploreCount,
				filesChanged: f.filesChanged,
				added: f.added,
				removed: f.removed,
				userId: entryUserId(startEntry),
				preview: f.preview,
				exempt: f.exemptRel.map(r => r + startIdx),
			});
		}
		units.push({
			key: startId.startsWith("pos:") ? `turn-${t}` : startId,
			turnIndex: t,
			startIdx,
			endIdx,
			replyIdx: span.unit.replyRel < 0 ? -1 : startIdx + span.unit.replyRel,
			workIdxs: span.unit.workRel.map(r => r + startIdx),
			tailIdxs: span.unit.tailRel.map(r => r + startIdx),
			hookIdxs: span.unit.hookRel.map(r => r + startIdx),
			isLastTurn,
			isRunning: working && isLastTurn,
			model: modelAtEnd.get(endIdx),
		});
	}

	// Prune spans from rounds that no longer exist (truncation / session
	// switch reuses the cache object only within one transcript).
	for (const key of c.spans.keys()) {
		if (!seenKeys.has(key)) c.spans.delete(key);
	}

	const result: TurnDeriveResult = { folds, units };
	c.lastSig = sig;
	c.lastResult = result;
	c.firstObj = firstEntry;
	c.lastObj = lastEntry;
	return result;
}

/**
 * Parity baseline for tests and diagnostics: the uncached full-list
 * derivation (existing builders, kept as the ground truth).
 */
export function deriveTurnsUncached(
	entries: readonly SessionEntry[],
	working: boolean,
	options?: BuildTurnRenderUnitsOptions,
): TurnDeriveResult {
	return {
		folds: buildRoundFolds(entries, working),
		units: buildTurnRenderUnits(entries, working, options),
	};
}
