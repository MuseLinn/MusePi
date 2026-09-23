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
 * Effective stacking level of the container the rail indicates: the
 * nearest ancestor (including itself) carrying a numeric z-index. The
 * rail paints one step above it, so any dialog / menu / toast that
 * covers the scrolled container also covers the rail — the rail used to
 * pin z-index 4200 ("above everything") and floated over the update
 * toast and modal backdrops (user: 滚动条覆盖更新弹窗).
 *
 * Nested contexts resolve pragmatically: the NEAREST numeric z wins, and
 * the walk stops early at a `position: fixed` overlay (update toast,
 * modal backdrop) since that level outranks everything below it.
 * Contexts without a numeric z (backdrop-filter glass, transforms,
 * opacity) contribute no number of their own — the walk keeps going and
 * inherits the level from further up. No numeric z anywhere → 0, i.e.
 * the rail sits just above plain content but under every overlay.
 * Results are cached per element (computed once per scrolled container,
 * not per scroll frame).
 */
const stackZCache = new WeakMap<HTMLElement, number>();
function stackZ(el: HTMLElement): number {
	const cached = stackZCache.get(el);
	if (cached !== undefined) return cached;
	let z = 0;
	let node: Element | null = el;
	while (node && node !== document.body && node !== document.documentElement) {
		const cs = getComputedStyle(node);
		const zi = cs.zIndex;
		if (zi !== "auto") {
			const n = Number(zi);
			if (Number.isFinite(n)) {
				z = n;
				if (cs.position === "fixed") break;
			}
		}
		node = node.parentElement;
	}
	stackZCache.set(el, z);
	return z;
}

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
 * - It appears on the first scroll; ~1s after scrolling stops it fades to
 *   a faint idle rail instead of disappearing (user callout: the ghost
 *   rail is the drag affordance — both thumbs stay grabbable while idle;
 *   hovering the rail restores full opacity), and the pac-man mouth
 *   chomps the whole time.
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

		// Visibility is attribute-driven (gui-misc.css): data-visible once the
		// rail has something to indicate, data-idle after scrolling stops.
		// Idle does NOT hide the rail any more — it fades to a faint rail
		// (user callout: the ghost rail is the drag affordance); the thumbs
		// stay interactive while idle so progress can be grabbed and dragged
		// at any time. The rail line itself is pointer-events:none (never
		// eats clicks); only the thumbs opt back in.
		// BUT a rail whose container is GONE (view switch unmounted it —
		// e.g. entering settings while a list's ghost is up) must fully
		// hide: an idle ghost over unrelated UI reads as a rendering bug.
		const targetGone = (): boolean => {
			const el = st.target;
			if (!el) return true;
			if (!el.isConnected) return true;
			const r = el.getBoundingClientRect();
			return r.width === 0 || r.height === 0;
		};
		const hideForGood = (): void => {
			st.target = null;
			delete bar.dataset.visible;
			delete bar.dataset.idle;
		};
		const hide = (): void => {
			if (targetGone()) {
				hideForGood();
				return;
			}
			bar.dataset.idle = "1";
		};
		const show = (): void => {
			bar.dataset.visible = "1";
			delete bar.dataset.idle;
		};
		const scheduleHide = (): void => {
			window.clearTimeout(st.timer);
			window.clearTimeout(st.settle);
			// Scroll stopped: gummy springs back (squash-and-stretch
			// releases), then the whole rail fades to its idle faint. The
			// settle pass also re-checks the container — a view switch right
			// after a scroll must not leave a solid rail hanging for the
			// full idle second.
			st.settle = window.setTimeout(() => {
				if (targetGone()) {
					hideForGood();
					return;
				}
				const g = gummyRef.current;
				if (g) {
					g.style.transition = "transform 420ms cubic-bezier(0.34, 1.56, 0.64, 1)";
					g.style.transform = "translateX(-50%)";
				}
			}, SETTLE_MS);
			st.timer = window.setTimeout(hide, HIDE_MS);
		};

		let update = (target: HTMLElement): void => {
			const oy = getComputedStyle(target).overflowY;
			if (oy !== "auto" && oy !== "scroll" && oy !== "overlay") return;
			if (target.scrollHeight <= target.clientHeight + 1) return;
			const r = target.getBoundingClientRect();
			if (r.width === 0 || r.height === 0) return;
			// This is the container the rail now indicates — keep it for the
			// drag handle (gummy capsule) to scroll.
			st.target = target;
			// Layer the rail with its container (see stackZ): covering
			// dialogs/toasts also cover the rail instead of the rail
			// floating over them.
			bar.style.zIndex = String(stackZ(target) + 1);
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
		// Liveness watch: the idle ghost has no pending timer, so a view
		// switch AFTER the fade-to-faint would otherwise leave the ghost
		// hanging over unrelated UI forever (user: 会话列表的滚动条在进入
		// 设置后仍在). A ~600ms connectivity probe while the rail is
		// visible costs two getBoundingClientRect calls a second and
		// retracts the rail the moment its container unmounts or collapses.
		const watcher = window.setInterval(() => {
			if (bar.dataset.visible === "1" && targetGone()) hideForGood();
		}, 600);

		// Geometry watch (issue #29): the rail only re-measures on `scroll`,
		// so a window resize/maximize or a sidebar/drawer toggle left the idle
		// ghost stranded at the pre-resize X — stuck mid-content. On geometry
		// change: re-measure silently (no show(), no scaleY stretch — idle
		// stays idle), or retract when the container no longer overflows.
		const remeasure = (): void => {
			if (bar.dataset.visible !== "1") return;
			const target = st.target;
			if (!target?.isConnected) {
				hideForGood();
				return;
			}
			// Window grew enough to fit everything → the rail is a ghost over
			// static content; retract fully (same trigger as targetGone).
			if (target.scrollHeight <= target.clientHeight + 1) {
				hideForGood();
				return;
			}
			const r = target.getBoundingClientRect();
			if (r.width === 0 || r.height === 0) {
				hideForGood();
				return;
			}
			const range = target.scrollHeight - target.clientHeight;
			const ratio = range > 0 ? target.scrollTop / range : 0;
			const barH = r.height;
			bar.style.zIndex = String(stackZ(target) + 1);
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
				}
			} else {
				const pacTop = Math.round(ratio * Math.max(0, barH - size));
				if (pacRef.current) pacRef.current.style.top = `${pacTop}px`;
				if (eatenRef.current) eatenRef.current.style.height = `${pacTop}px`;
			}
		};
		// Observe the container the rail currently indicates — sidebar
		// collapse / drawer toggle change its width without a window resize.
		const ro = new ResizeObserver(() => remeasure());
		const originalUpdate = update;
		update = (target: HTMLElement): void => {
			originalUpdate(target);
			if (st.target === target) ro.observe(target);
		};
		window.addEventListener("resize", remeasure);
		return () => {
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", remeasure);
			ro.disconnect();
			window.clearInterval(watcher);
			window.clearTimeout(st.timer);
			window.clearTimeout(st.settle);
			if (st.raf) window.cancelAnimationFrame(st.raf);
		};
	}, [skinId, skin, size]);

	// Drag: both thumbs (gummy capsule / pac-man) are real scrollbar thumbs
	// — dragging either scrolls the last-scrolled container (the one the
	// rail indicates). Pressing also wakes the rail out of its idle faint.
	const onThumbDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
		const thumb = e.currentTarget;
		const bar = barRef.current;
		const target = stRef.current.target;
		if (!bar || !target) return;
		const range = target.scrollHeight - target.clientHeight;
		if (range <= 0) return;
		e.preventDefault();
		thumb.setPointerCapture(e.pointerId);
		// Wake: a grab on the idle-faint rail snaps it back to full opacity
		// immediately (the scroll events below keep it awake while dragging).
		bar.dataset.visible = "1";
		delete bar.dataset.idle;
		// Drag keeps the thumb's grab offset (standard scrollbars don't jump
		// the scroll position to the thumb center on press). The scroll
		// events the drag emits re-run update() → scheduleHide(), which
		// resets the idle timers — the rail stays solid while dragging and
		// fades back to faint ~1s after release.
		const dragMax = Math.max(1, bar.offsetHeight - thumb.offsetHeight);
		const startY = e.clientY;
		const startTop = thumb.offsetTop;
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
		thumb.addEventListener("pointermove", onMove);
		thumb.addEventListener("pointerup", onUp);
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
				<div ref={gummyRef} className="gfs-gummy" onPointerDown={onThumbDown} aria-hidden="true">
					<span className="gfs-gummy-shine" />
				</div>
			) : (
				<>
					<div className="gfs-track" />
					<div className="gfs-beads" />
					<div ref={eatenRef} className="gfs-beads-eaten" />
					<div ref={pacRef} className="gfs-pac" onPointerDown={onThumbDown} aria-hidden="true">
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
