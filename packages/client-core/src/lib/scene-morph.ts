/**
 * Scene-morph tool (M1.10 §3.3 一镜到底, guest/安卓壳批次 B).
 *
 * Two halves:
 *  - Outgoing scene: `stageLeavingScene` freezes the leaving scene as a
 *    fixed-position clone at its last viewport rect, hides its shared
 *    elements (they continue on the incoming side) and collapses the clone —
 *    height → 0 with the 8px slide, no full-screen opacity (§3.3 #2).
 *  - Incoming scene: `useMorphTarget` flies a mounted shared element from
 *    the rect cached for its `data-morph-id` (§3.3 #1, translate+scale
 *    linearized the way the desktop `morphFrame` / lightbox morph are).
 *
 * Flight geometry is the shared pure core in `components/image-morph.ts`
 * (single implementation — no local copy). Motion degradation (§3.4):
 * `gui-motion-off` / `prefers-reduced-motion` short-circuits both halves —
 * instant switch, no intermediate frames, glass material untouched.
 *
 * The clone is taken synchronously in the interaction handler, BEFORE the
 * React state flip commits: the original never visibly disappears (the
 * clone covers it), and React still owns/removes the original node.
 */

import type { RefObject } from "react";
import { useLayoutEffect, useRef } from "react";
import {
	computeMorph,
	MORPH_EASING_IN,
	MORPH_EASING_OUT,
	MORPH_MS,
	type MorphRect,
	motionDisabled,
} from "../components/image-morph";

/** 非共享元素滑出幅度 (§3.3 #2: 高度形变到 0 + 8px 下滑). */
export const SCENE_COLLAPSE_SLIDE_PX = 8;

/** Shared-element identity for a session title, used by both ends of the
 * mobile 列表↔会话 morph (workspace card ↔ header title). */
export function sessionTitleMorphId(sessionId: string): string {
	return `session-title-${sessionId}`;
}

/**
 * 高度形变时长阶梯 (§3.2): delta/6, clamped to [240, 480] — the HeightMorph
 * standard, so a full-screen collapse eases slower than a small panel.
 */
export function heightMorphMs(delta: number): number {
	if (!Number.isFinite(delta) || delta <= 0) return 240;
	return Math.min(480, Math.max(240, Math.round(delta / 6)));
}

/**
 * Flight keyframes for the incoming shared element: five linearized stops
 * from the source rect to identity (the morphFrame travel distribution —
 * short per-frame segments read as continuous flight). Returns null for
 * degenerate rects so the caller skips the flight.
 */
export function sceneKeyframes(origin: MorphRect, target: MorphRect): string[] | null {
	const m = computeMorph(origin, target);
	if (!m) return null;
	const at = (k: number): string =>
		`translate(${m.dx * k}px, ${m.dy * k}px) scale(${1 + (m.sx - 1) * k}, ${1 + (m.sy - 1) * k})`;
	return [at(1), at(0.8), at(0.55), at(0.28), at(0)];
}

// ── Shared-rect cache (source side → target side, across one commit) ──

const rectCache = new Map<string, MorphRect>();

/** Cache every `[data-morph-id]` rect under `scope` (viewport coords).
 * Clears previous entries — call once per scene switch, before any DOM
 * change (rects must be the pre-switch layout). */
export function cacheMorphRects(scope: ParentNode = document): void {
	rectCache.clear();
	if (typeof document === "undefined") return;
	for (const el of scope.querySelectorAll<HTMLElement>("[data-morph-id]")) {
		const id = el.dataset.morphId;
		if (!id) continue;
		const r = el.getBoundingClientRect();
		if (r.width > 0 && r.height > 0) {
			rectCache.set(id, { left: r.left, top: r.top, width: r.width, height: r.height });
		}
	}
}

/** Take (and clear) the cached source rect for a morph id. */
export function takeMorphRect(id: string): MorphRect | null {
	const rect = rectCache.get(id);
	rectCache.delete(id);
	return rect ?? null;
}

/** Fly `el` from the cached rect of `id`, if one was staged this switch. */
export function flyFromCache(id: string, el: HTMLElement): void {
	if (motionDisabled()) return;
	const from = takeMorphRect(id);
	if (!from) return;
	const r = el.getBoundingClientRect();
	const frames = sceneKeyframes(from, { left: r.left, top: r.top, width: r.width, height: r.height });
	if (!frames) return;
	el.animate(
		frames.map(transform => ({ transform, transformOrigin: "top left" })),
		{ duration: MORPH_MS, easing: MORPH_EASING_IN },
	);
}

/**
 * Shared-element target hook: attach the returned ref to the incoming
 * element carrying `data-morph-id={id}`. When the id changes (or on mount)
 * and a source rect was cached for it, the element flies from the source —
 * WAAPI directly on the DOM, no React state involved.
 */
export function useMorphTarget<T extends HTMLElement>(id: string | null): RefObject<T | null> {
	const ref = useRef<T | null>(null);
	useLayoutEffect(() => {
		if (!id) return;
		const el = ref.current;
		if (el) flyFromCache(id, el);
	}, [id]);
	return ref;
}

// ── Leaving-scene freeze (clone + collapse) ──

/** Copy live canvas bitmaps into the clone (cloneNode clones the element,
 * not the pixel buffer — the dot-matrix brand mark would land blank). */
function copyCanvases(source: HTMLElement, clone: HTMLElement): void {
	const from = source.querySelectorAll("canvas");
	const to = clone.querySelectorAll("canvas");
	for (let i = 0; i < from.length && i < to.length; i++) {
		const ctx = to[i].getContext("2d");
		if (ctx && from[i].width > 0 && from[i].height > 0) ctx.drawImage(from[i], 0, 0);
	}
}

/**
 * Freeze the outgoing scene and collapse it in place (§3.3 #2).
 * Call from the interaction handler that flips the scene, BEFORE the state
 * update commits: the clone (a detached copy — React keeps ownership of the
 * original) is appended at the original's viewport rect and starts
 * collapsing immediately, so the very next paint already shows the morph.
 * Shared elements inside the clone are hidden — their flight continues on
 * the incoming side. Motion-off: no clone at all, instant switch.
 */
export function stageLeavingScene(root: HTMLElement | null): void {
	if (!root || typeof document === "undefined" || !document.body) return;
	if (motionDisabled() || !root.isConnected) return;
	const rect = root.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) return;
	const clone = root.cloneNode(true) as HTMLElement;
	copyCanvases(root, clone);
	// The shared elements keep flying on the incoming side — drop the
	// frozen copies so nothing double-paints during the collapse.
	for (const shared of clone.querySelectorAll<HTMLElement>("[data-morph-id]")) {
		shared.style.opacity = "0";
	}
	const wrap = document.createElement("div");
	wrap.className = "sh-scene-leaving";
	wrap.setAttribute("aria-hidden", "true");
	wrap.setAttribute("inert", "");
	wrap.style.left = `${rect.left}px`;
	wrap.style.top = `${rect.top}px`;
	wrap.style.width = `${rect.width}px`;
	wrap.style.height = `${rect.height}px`;
	wrap.appendChild(clone);
	document.body.appendChild(wrap);
	const duration = heightMorphMs(rect.height);
	const anim = wrap.animate(
		[
			{ height: `${rect.height}px`, transform: "translateY(0)" },
			{ height: "0px", transform: `translateY(${SCENE_COLLAPSE_SLIDE_PX}px)` },
		],
		{ duration, easing: MORPH_EASING_OUT, fill: "forwards" },
	);
	const done = (): void => wrap.remove();
	anim.addEventListener("finish", done, { once: true });
	anim.addEventListener("cancel", done, { once: true });
	// Backgrounded tabs can stall the finish event; the fallback clears the
	// clone right after the timeline would have ended either way.
	setTimeout(done, duration + 120);
}
