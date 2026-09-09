import type { CSSProperties, ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useRef, useState } from "react";
import {
	getScrollbarSkin,
	readScrollbarStyle,
	SCROLLBAR_SKINS_CHANGED_EVENT,
	SCROLLBAR_STYLE_CHANGED_EVENT,
} from "../lib/scrollbar-skins";
import { PacMan } from "../vendor/pac-man";

/**
 * Floating scroll indicator (Chromium 150+ / Electron 43).
 *
 * Chromium still parses `overflow: overlay` but lays it out exactly like
 * `auto` — the floating (zero-layout-width) scrollbar is gone. System
 * scrollbars are therefore hidden globally (gui.css `scrollbar-width:
 * none` + `::-webkit-scrollbar { display: none }`) so no container ever
 * squeezes or shifts when its content becomes scrollable, and this fixed
 * overlay draws a skin-driven progress rail in its place.
 *
 * Two built-in bases (see lib/scrollbar-skins.ts), switchable in settings
 * 外观 → 滚动条样式, plus petdex-style imported zip skins:
 *
 *   gummy  — a jelly capsule thumb: height = visible ratio, stretches
 *            while scrolling (scaleY) and springs back when scroll stops;
 *            accent-tinted glass with a top highlight.
 *
 *   pacman — a hairline thread with a string of beads at 7px pitch; a
 *            single pac-man rides the thread and eats its way down. Beads
 *            above the pac-man are "eaten" (dimmed) — the eaten length IS
 *            the scroll progress, the pac-man position marks the ratio.
 *
 * - `scroll` events (capture phase — every scrollable container dispatches
 *   them) stretch the rail to the scrolled element's full visible height
 *   and move the indicator along it.
 * - It appears on the first scroll and fades out ~1s after scrolling
 *   stops; the pac-man mouth chomps while visible.
 * - Zero React re-renders during scrolling: everything is driven through
 *   refs/direct style writes; skin selection is the only state change.
 */
export function FloatingScrollbar(): ReactNode {
	const barRef = useRef<HTMLDivElement | null>(null);
	const pacRef = useRef<HTMLDivElement | null>(null);
	const eatenRef = useRef<HTMLDivElement | null>(null);
	const gummyRef = useRef<HTMLDivElement | null>(null);
	const stRef = useRef<{ raf: number; timer: number; settle: number; target: HTMLElement | null }>({
		raf: 0,
		timer: 0,
		settle: 0,
		// Last-scrolled overflow container the rail currently indicates —
		// the drag handle (gummy capsule) scrolls THIS element.
		target: null,
	});
	const [skinId, setSkinId] = useState<string>(() => readScrollbarStyle());

	// Skin picker / importer (settings) notifies; a light re-render picks
	// up the new skin — scrolling itself never re-renders.
	useEffect(() => {
		const onChange = (): void => setSkinId(readScrollbarStyle());
		window.addEventListener(SCROLLBAR_STYLE_CHANGED_EVENT, onChange);
		window.addEventListener(SCROLLBAR_SKINS_CHANGED_EVENT, onChange);
		return () => {
			window.removeEventListener(SCROLLBAR_STYLE_CHANGED_EVENT, onChange);
			window.removeEventListener(SCROLLBAR_SKINS_CHANGED_EVENT, onChange);
		};
	}, []);

	const skin = getScrollbarSkin(skinId);
	const size = skin.size;

	useEffect(() => {
		const bar = barRef.current;
		if (!bar) return;
		const st = stRef.current;
		const HIDE_MS = 1000;
		const SETTLE_MS = 140;

		bar.style.setProperty("--skin-accent", skin.colors.accent);
		bar.style.setProperty("--skin-track", skin.colors.track);
		bar.style.setProperty("--skin-eaten", skin.colors.eaten);
		bar.style.setProperty("--skin-size", `${size}px`);
		bar.style.width = `${size}px`;
		bar.dataset.base = skin.base;

		const hide = (): void => {
			bar.style.opacity = "0";
			// data-visible gates the drag handle: once hidden, the gummy
			// capsule loses pointer-events (CSS [data-visible] selector) so
			// the top-of-ladder rail can never intercept clicks while faded.
			delete bar.dataset.visible;
		};
		const show = (): void => {
			bar.style.opacity = "1";
			bar.style.visibility = "visible";
			bar.dataset.visible = "1";
		};
		const scheduleHide = (): void => {
			window.clearTimeout(st.timer);
			window.clearTimeout(st.settle);
			// Scroll stopped: gummy springs back (squash-and-stretch
			// releases), then the whole rail fades out.
			st.settle = window.setTimeout(() => {
				const g = gummyRef.current;
				if (g) {
					g.style.transition = "transform 420ms cubic-bezier(0.34, 1.56, 0.64, 1)";
					g.style.transform = "translateX(-50%)";
				}
			}, SETTLE_MS);
			st.timer = window.setTimeout(hide, HIDE_MS);
		};

		const update = (target: HTMLElement): void => {
			const oy = getComputedStyle(target).overflowY;
			if (oy !== "auto" && oy !== "scroll" && oy !== "overlay") return;
			if (target.scrollHeight <= target.clientHeight + 1) return;
			const r = target.getBoundingClientRect();
			if (r.width === 0 || r.height === 0) return;
			// This is the container the rail now indicates — keep it for the
			// drag handle (gummy capsule) to scroll.
			st.target = target;
			const range = target.scrollHeight - target.clientHeight;
			const ratio = range > 0 ? target.scrollTop / range : 0;
			const barH = r.height;
			bar.style.left = `${r.right - 13}px`;
			bar.style.top = `${Math.round(r.top)}px`;
			bar.style.height = `${Math.round(barH)}px`;
			if (skin.base === "gummy") {
				const g = gummyRef.current;
				if (g) {
					const thumbH = Math.min(
						barH,
						Math.max(24, Math.round(barH * (target.clientHeight / target.scrollHeight))),
					);
					g.style.height = `${Math.round(thumbH)}px`;
					g.style.top = `${Math.round(ratio * Math.max(0, barH - thumbH))}px`;
					// Stretch while scrolling; the release transition is
					// set in scheduleHide. transition:none keeps the
					// stretch snappy (no spring chasing every frame).
					g.style.transition = "none";
					g.style.transform = "translateX(-50%) scaleY(1.06)";
				}
			} else {
				const pacTop = Math.round(ratio * Math.max(0, barH - size));
				if (pacRef.current) pacRef.current.style.top = `${pacTop}px`;
				if (eatenRef.current) eatenRef.current.style.height = `${pacTop}px`;
			}
			show();
			scheduleHide();
		};

		const onScroll = (e: Event): void => {
			const t = e.target;
			if (!(t instanceof HTMLElement) || t === document.documentElement) return;
			if (st.raf) return;
			st.raf = window.requestAnimationFrame(() => {
				st.raf = 0;
				update(t);
			});
		};

		window.addEventListener("scroll", onScroll, true);
		return () => {
			window.removeEventListener("scroll", onScroll, true);
			window.clearTimeout(st.timer);
			window.clearTimeout(st.settle);
			if (st.raf) window.cancelAnimationFrame(st.raf);
		};
	}, [skinId, skin, size]);

	// Drag: the gummy capsule is a real scrollbar thumb — dragging it
	// scrolls the last-scrolled container (the one the rail indicates).
	const onGummyDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
		const g = gummyRef.current;
		const bar = barRef.current;
		const target = stRef.current.target;
		if (!g || !bar || !target) return;
		const range = target.scrollHeight - target.clientHeight;
		if (range <= 0) return;
		e.preventDefault();
		(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
		// Drag keeps the thumb's grab offset (standard scrollbars don't jump
		// the scroll position to the thumb center on press). The scroll
		// events the drag emits re-run update() → scheduleHide(), which
		// resets the hide timers — the rail stays out while dragging and
		// fades ~1s after release.
		const dragMax = Math.max(1, bar.offsetHeight - g.offsetHeight);
		const startY = e.clientY;
		const startTop = g.offsetTop;
		const onMove = (ev: PointerEvent): void => {
			const ratio = Math.min(1, Math.max(0, (startTop + ev.clientY - startY) / dragMax));
			target.scrollTop = Math.round(ratio * range);
		};
		const onUp = (ev: PointerEvent): void => {
			const el = ev.currentTarget as HTMLDivElement;
			el.removeEventListener("pointermove", onMove);
			el.removeEventListener("pointerup", onUp);
			try {
				el.releasePointerCapture(ev.pointerId);
			} catch {
				// capture already released — nothing to do
			}
		};
		g.addEventListener("pointermove", onMove);
		g.addEventListener("pointerup", onUp);
	};

	return (
		<div
			ref={barRef}
			className="gui-float-scrollbar"
			data-base={skin.base}
			data-skin={skin.id}
			aria-hidden="true"
			style={
				{
					"--skin-accent": skin.colors.accent,
					"--skin-track": skin.colors.track,
					"--skin-eaten": skin.colors.eaten,
				} as CSSProperties
			}
		>
			{skin.base === "gummy" ? (
				<div ref={gummyRef} className="gfs-gummy" onPointerDown={onGummyDown} aria-hidden="true">
					<span className="gfs-gummy-shine" />
				</div>
			) : (
				<>
					<div className="gfs-track" />
					<div className="gfs-beads" />
					<div ref={eatenRef} className="gfs-beads-eaten" />
					<div ref={pacRef} className="gfs-pac">
						{skin.pacGlyph ? (
							<img src={skin.pacGlyph} alt="" width={size} height={size} />
						) : (
							<PacMan size={size} side="down" animating />
						)}
					</div>
				</>
			)}
		</div>
	);
}
