import type { CSSProperties, ReactNode } from "react";
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
	const stRef = useRef({ raf: 0, timer: 0, settle: 0 });
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
		};
		const show = (): void => {
			bar.style.opacity = "1";
			bar.style.visibility = "visible";
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
				<div ref={gummyRef} className="gfs-gummy">
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
