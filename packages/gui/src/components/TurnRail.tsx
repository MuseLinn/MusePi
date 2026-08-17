import { t } from "@musepi/collab-web";
import type { ReactNode, RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

interface TurnMarker {
	/** Content-space top of the user row (valid as the transcript scrolls). */
	top: number;
	summary: string;
}

export type TurnRailSide = "right" | "left";
export type TurnRailStyle = "burger" | "pacman";

const TURN_RAIL_SIDE_KEY = "omp-collab-turnrail-side";
const TURN_RAIL_STYLE_KEY = "omp-collab-turnrail-style";
const TURN_RAIL_CHANGED_EVENT = "omp-turnrail-changed";

// openchamber PromptNavigatorRail parity: one tick per USER message (each
// turn starts at the user's prompt), stacked at a fixed 12px pitch. The
// track hugs its tick window (height = visible ticks × pitch) and the rail
// centers on the session column — with few turns the ticks sit dead-center
// instead of clustering at the top of a fixed 360px track. Long sessions
// show a 30-tick window with edge-hover carousel. Hovering opens a gliding
// multi-row panel listing ALL turns at once (the hovered row stays in
// view); a scroll-spy marks the turn currently displayed with the accent.
const MAX_VISIBLE_TICKS = 30;
const TICK_PITCH_PX = 12;
const EDGE_ZONE_PX = 18;
const CAROUSEL_INTERVAL_MS = 80;
const TICK_OVERSCAN = 4;
// Codex-style proximity wave: the hovered tick stretches, neighbours
// taper off (length multiplier per distance).
const FALLOFF = [1, 0.6, 0.35, 0.15] as const;
const TICK_BASE_PX = 10;
const TICK_ACTIVE_PX = 14;
const TICK_FOCUS_PX = 20;
// Hover panel: a scrolling mini-list of all prompts — the highlighted row
// stays in view while the list glides, and the panel is interactive so
// imprecise gutter hits can be corrected inside the list. Rows are
// fixed-pitch and fit up to two preview lines; short prompts just center
// vertically. Fixed pitch keeps the glide/virtualization math simple.
const PANEL_ROW_HEIGHT_PX = 54;
const PANEL_ROW_INSET_Y_PX = 4;
const PANEL_MAX_ROWS = 8;
const PANEL_SCROLL_MARGIN_ROWS = 2;
const PANEL_HIDE_DELAY_MS = 160;
// The turn whose prompt row sits at/above this offset from the viewport
// top is the "active" (currently displayed) one.
const ACTIVE_TOP_OFFSET_PX = 24;

function loadPref(key: string, fallback: string): string {
	try {
		return localStorage.getItem(key) ?? fallback;
	} catch {
		return fallback;
	}
}

/**
 * Transcript turn-position rail (openchamber PromptNavigatorRail parity):
 * one burger-layer tick per user message, stacked at a fixed pitch,
 * vertically centered. Hover opens a multi-row panel of all turns with the
 * hovered row kept in view; click (or Enter) smooth-scrolls. The tick for
 * the turn currently in view (scroll-spy) carries the accent. Side
 * (left/right) and glyph style (burger/pacman) are user settings
 * (SettingsView writes them + dispatches TURN_RAIL_CHANGED_EVENT).
 */
export function TurnRail({
	rootRef,
	entryCount,
}: {
	rootRef: RefObject<HTMLDivElement | null>;
	/** Re-measure when the transcript grows (entries append). */
	entryCount: number;
}): ReactNode {
	const [turns, setTurns] = useState<TurnMarker[]>([]);
	const [hover, setHover] = useState<number | null>(null);
	/** Scroll-spy: absolute index of the turn currently in view. */
	const [active, setActive] = useState<number | null>(null);
	const [side, setSide] = useState<TurnRailSide>(() => loadPref(TURN_RAIL_SIDE_KEY, "right") as TurnRailSide);
	const [style, setStyle] = useState<TurnRailStyle>(() => loadPref(TURN_RAIL_STYLE_KEY, "burger") as TurnRailStyle);
	const [windowStart, setWindowStart] = useState(0);
	const trackRef = useRef<HTMLDivElement | null>(null);
	const panelRef = useRef<HTMLDivElement | null>(null);
	const carouselRef = useRef<Timer | null>(null);
	const hideTimerRef = useRef<Timer | null>(null);
	const panelOffsetRef = useRef<number | null>(null);
	const wheelRemainderRef = useRef(0);
	// Refs mirroring hot values so event handlers read fresh state.
	const turnsRef = useRef<TurnMarker[]>([]);
	const windowStartRef = useRef(windowStart);
	windowStartRef.current = windowStart;
	const hoverRef = useRef(hover);
	hoverRef.current = hover;

	const visibleCount = Math.min(turns.length, MAX_VISIBLE_TICKS);
	const maxWindowStart = Math.max(0, turns.length - visibleCount);
	const clampedWindowStart = Math.min(windowStart, maxWindowStart);
	const windowEnd = clampedWindowStart + visibleCount;
	const hasMoreAbove = clampedWindowStart > 0;
	const hasMoreBelow = windowEnd < turns.length;

	// Preferences are set from SettingsView; pick them up live.
	useEffect(() => {
		const onChange = (): void => {
			setSide(loadPref(TURN_RAIL_SIDE_KEY, "right") as TurnRailSide);
			setStyle(loadPref(TURN_RAIL_STYLE_KEY, "burger") as TurnRailStyle);
		};
		window.addEventListener(TURN_RAIL_CHANGED_EVENT, onChange);
		return () => window.removeEventListener(TURN_RAIL_CHANGED_EVENT, onChange);
	}, []);

	// Scroll-spy: the turn whose prompt row is at/above the viewport top
	// is active (its tick carries the accent).
	const computeActive = useCallback((): void => {
		const root = rootRef.current;
		const ts = turnsRef.current;
		if (!root || ts.length === 0) {
			setActive(null);
			return;
		}
		const threshold = root.scrollTop + ACTIVE_TOP_OFFSET_PX;
		let idx = -1;
		for (let i = 0; i < ts.length; i++) {
			if (ts[i].top <= threshold) idx = i;
			else break;
		}
		setActive(idx >= 0 ? idx : null);
	}, [rootRef]);

	// Re-measure turn positions (entryCount is only a re-measure trigger;
	// the measurement is stateless). Tops are content-space values: the
	// viewport-relative top plus the current scroll offset, so they stay
	// valid as the transcript scrolls and compare directly with scrollTop.
	// A MutationObserver re-measures as rows stream in: the transcript
	// renders user rows progressively (subscribe replay), so entryCount
	// alone leaves the rail stale mid-stream.
	useEffect(() => {
		void entryCount;
		const root = rootRef.current;
		if (!root) return;
		const measure = (): void => {
			const rootRect = root.getBoundingClientRect();
			const scrollTop = root.scrollTop;
			const rows = [...root.querySelectorAll<HTMLElement>(".tr-row--user")];
			const measured = rows.map(r => ({
				top: r.getBoundingClientRect().top - rootRect.top + scrollTop,
				summary: (r.querySelector<HTMLElement>(".tr-md")?.textContent ?? "").trim().slice(0, 90),
			}));
			turnsRef.current = measured;
			setTurns(measured);
			computeActive();
		};
		measure();
		let timer = 0;
		const mo = new MutationObserver(() => {
			if (timer === 0) {
				timer = requestAnimationFrame(() => {
					timer = 0;
					measure();
				});
			}
		});
		mo.observe(root, { childList: true, subtree: true });
		return () => {
			mo.disconnect();
			if (timer !== 0) cancelAnimationFrame(timer);
		};
	}, [rootRef, entryCount, computeActive]);

	// Scroll-spy updates, rAF-throttled (the latch releases inside the
	// frame so a burst of scroll events collapses into one compute).
	useEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		let raf = 0;
		const onScroll = (): void => {
			if (raf === 0) {
				raf = requestAnimationFrame(() => {
					raf = 0;
					computeActive();
				});
			}
		};
		root.addEventListener("scroll", onScroll, { passive: true });
		computeActive();
		return () => {
			root.removeEventListener("scroll", onScroll);
			if (raf !== 0) cancelAnimationFrame(raf);
		};
	}, [rootRef, computeActive]);

	// While the user isn't interacting with the rail, the tape glides so
	// the active prompt stays centered — the scale moves, not the marker.
	useEffect(() => {
		if (hover !== null || active === null) return;
		const count = Math.min(turns.length, MAX_VISIBLE_TICKS);
		const maxStart = Math.max(0, turns.length - count);
		setWindowStart(Math.min(maxStart, Math.max(0, active - Math.floor(count / 2))));
	}, [hover, active, turns.length]);

	const stopCarousel = useCallback((): void => {
		if (carouselRef.current !== null) {
			clearInterval(carouselRef.current ?? undefined);
			carouselRef.current = null;
		}
	}, []);
	useEffect(() => stopCarousel, [stopCarousel]);

	const startCarousel = useCallback(
		(dir: -1 | 1): void => {
			stopCarousel();
			carouselRef.current = setInterval(() => {
				setWindowStart(w => {
					const count = Math.min(turnsRef.current.length, MAX_VISIBLE_TICKS);
					const max = Math.max(0, turnsRef.current.length - count);
					return Math.min(max, Math.max(0, w + dir));
				});
			}, CAROUSEL_INTERVAL_MS);
		},
		[stopCarousel],
	);

	// Leaving the rail hides the panel after a short grace period so the
	// pointer can travel into the panel and interact with the list directly.
	const cancelHide = useCallback((): void => {
		if (hideTimerRef.current !== null) {
			clearTimeout(hideTimerRef.current);
			hideTimerRef.current = null;
		}
	}, []);
	const scheduleHide = useCallback((): void => {
		cancelHide();
		hideTimerRef.current = setTimeout(() => {
			hideTimerRef.current = null;
			setHover(null);
		}, PANEL_HIDE_DELAY_MS);
	}, [cancelHide]);
	useEffect(
		() => () => {
			clearTimeout(hideTimerRef.current ?? undefined);
		},
		[],
	);

	const jumpTo = useCallback(
		(index: number): void => {
			const m = turnsRef.current[index];
			if (!m) return;
			rootRef.current?.scrollTo({ top: Math.max(0, m.top - 12), behavior: "smooth" });
		},
		[rootRef],
	);

	const relativeFromY = useCallback((clientY: number, el: HTMLElement): number | null => {
		const rect = el.getBoundingClientRect();
		const rel = Math.floor((clientY - rect.top) / TICK_PITCH_PX);
		const count = Math.min(turnsRef.current.length, MAX_VISIBLE_TICKS);
		if (count === 0) return null;
		return Math.max(0, Math.min(count - 1, rel));
	}, []);

	// The whole gutter is one hover/click target: the cursor's vertical
	// position maps to the nearest tick, so tick density never demands
	// pointer precision. Edge zones carousel the window (openchamber).
	const onTrackPointerMove = useCallback(
		(e: React.PointerEvent<HTMLDivElement>): void => {
			cancelHide();
			const el = e.currentTarget;
			const rel = relativeFromY(e.clientY, el);
			if (rel !== null) {
				setHover(Math.min(turnsRef.current.length - 1, windowStartRef.current + rel));
			}
			const rect = el.getBoundingClientRect();
			const y = e.clientY - rect.top;
			let dir: -1 | 0 | 1 = 0;
			if (y <= EDGE_ZONE_PX && hasMoreAbove) dir = -1;
			else if (y >= rect.height - EDGE_ZONE_PX && hasMoreBelow) dir = 1;
			if (dir !== 0) startCarousel(dir);
			else stopCarousel();
		},
		[cancelHide, hasMoreAbove, hasMoreBelow, relativeFromY, startCarousel, stopCarousel],
	);

	const onTrackPointerDown = useCallback(
		(e: React.PointerEvent<HTMLDivElement>): void => {
			const rel = relativeFromY(e.clientY, e.currentTarget);
			if (rel !== null) jumpTo(windowStartRef.current + rel);
		},
		[jumpTo, relativeFromY],
	);

	// Keyboard navigation (openchamber parity): the gutter is focusable
	// (tab), arrows move the highlight, Enter jumps, Escape closes.
	const onTrackKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLDivElement>): void => {
			const length = turnsRef.current.length;
			if (length === 0) return;
			const current = hoverRef.current ?? active ?? length - 1;
			const moveTo = (index: number): void => {
				const next = Math.max(0, Math.min(length - 1, index));
				setHover(next);
				const count = Math.min(length, MAX_VISIBLE_TICKS);
				const maxStart = Math.max(0, length - count);
				setWindowStart(w => {
					const clamped = Math.min(w, maxStart);
					if (next < clamped) return next;
					if (next >= clamped + count) return Math.min(maxStart, next - count + 1);
					return clamped;
				});
			};
			if (e.key === "ArrowUp") {
				e.preventDefault();
				moveTo(current - 1);
			} else if (e.key === "ArrowDown") {
				e.preventDefault();
				moveTo(current + 1);
			} else if (e.key === "Home") {
				e.preventDefault();
				moveTo(0);
			} else if (e.key === "End") {
				e.preventDefault();
				moveTo(length - 1);
			} else if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				jumpTo(current);
				setHover(null);
			} else if (e.key === "Escape") {
				e.preventDefault();
				setHover(null);
				e.currentTarget.blur();
			}
		},
		[active, jumpTo],
	);

	// Wheel over the panel steps the highlight instead of scrolling the
	// chat underneath; a native non-passive listener is required for
	// preventDefault. The listener lives on the panel element via a ref
	// callback cleanup (React 19), so it follows the panel's mount/unmount
	// without a mount-trigger effect.
	const panelWheelRef = useCallback((el: HTMLDivElement | null) => {
		panelRef.current = el;
		if (!el) return;
		const onWheel = (e: WheelEvent): void => {
			e.preventDefault();
			e.stopPropagation();
			wheelRemainderRef.current += e.deltaY;
			const steps = Math.trunc(wheelRemainderRef.current / PANEL_ROW_HEIGHT_PX);
			if (steps === 0) return;
			wheelRemainderRef.current -= steps * PANEL_ROW_HEIGHT_PX;
			const current = hoverRef.current;
			if (current === null) return;
			const next = Math.max(0, Math.min(turnsRef.current.length - 1, current + steps));
			if (next !== current) setHover(next);
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, []);

	const resolveWidth = useCallback(
		(index: number): number => {
			const base = index === active ? TICK_ACTIVE_PX : TICK_BASE_PX;
			if (hover === null) return base;
			const dist = Math.abs(index - hover);
			const factor = FALLOFF[Math.min(dist, FALLOFF.length - 1)] ?? 0;
			return Math.round(base + (TICK_FOCUS_PX - base) * factor);
		},
		[active, hover],
	);

	// Panel list geometry: centered on the highlight when the panel opens,
	// then a dead zone — the list only glides when the highlighted row gets
	// within one row of the window edge, so small pointer moves don't
	// scroll (openchamber).
	const panelVisibleRows = Math.min(turns.length, PANEL_MAX_ROWS);
	const panelHeight = panelVisibleRows * PANEL_ROW_HEIGHT_PX;
	const panelMaxOffset = turns.length * PANEL_ROW_HEIGHT_PX - panelHeight;
	const clampPanelOffset = (offset: number): number => Math.max(0, Math.min(panelMaxOffset, offset));
	let panelScrollOffset = 0;
	if (hover === null) {
		panelOffsetRef.current = null;
	} else if (panelOffsetRef.current === null) {
		panelScrollOffset = clampPanelOffset(hover * PANEL_ROW_HEIGHT_PX - (panelHeight - PANEL_ROW_HEIGHT_PX) / 2);
		panelOffsetRef.current = panelScrollOffset;
	} else {
		let offset = panelOffsetRef.current;
		// Keep two rows of context visible above and below the highlight —
		// the dead zone is the middle third of the window, so the list
		// glides noticeably before the highlight reaches the edge but small
		// pointer moves around the center don't scroll.
		const highestAllowed = (hover - PANEL_SCROLL_MARGIN_ROWS) * PANEL_ROW_HEIGHT_PX;
		const lowestAllowed = (hover + 1 + PANEL_SCROLL_MARGIN_ROWS) * PANEL_ROW_HEIGHT_PX - panelHeight;
		if (offset > highestAllowed) offset = highestAllowed;
		else if (offset < lowestAllowed) offset = lowestAllowed;
		panelScrollOffset = clampPanelOffset(offset);
		panelOffsetRef.current = panelScrollOffset;
	}
	// Only rows near the visible window are rendered; extra rows slide in
	// under the mask during the glide instead of popping in at the edges.
	const panelFirstVisibleRow = Math.floor(panelScrollOffset / PANEL_ROW_HEIGHT_PX);
	const panelSliceStart = Math.max(0, panelFirstVisibleRow - TICK_OVERSCAN);
	const panelSliceEnd = Math.min(turns.length, panelFirstVisibleRow + panelVisibleRows + TICK_OVERSCAN);
	const panelClippedAbove = panelScrollOffset > 0;
	const panelClippedBelow = panelScrollOffset < panelMaxOffset;
	const panelMask =
		panelClippedAbove || panelClippedBelow
			? `linear-gradient(to bottom, ${panelClippedAbove ? "transparent, black 10%" : "black"}, ${panelClippedBelow ? "black 90%, transparent" : "black"})`
			: undefined;

	// Overscan a few ticks beyond the window so they slide in under the
	// gradient mask instead of popping into existence at the edges.
	const overscanStart = Math.max(0, clampedWindowStart - TICK_OVERSCAN);
	const overscanEnd = Math.min(turns.length, windowEnd + TICK_OVERSCAN);
	const gutterMask =
		hasMoreAbove || hasMoreBelow
			? `linear-gradient(to bottom, ${hasMoreAbove ? "transparent, black 14%" : "black"}, ${hasMoreBelow ? "black 86%, transparent" : "black"})`
			: undefined;

	if (turns.length === 0) return null;

	return (
		<div
			className={`gui-turn-rail${style === "pacman" ? " gui-turn-rail--pacman" : ""}`}
			data-side={side}
			onPointerLeave={() => {
				stopCarousel();
				scheduleHide();
			}}
		>
			<div
				ref={trackRef}
				className="gui-turn-track"
				role="listbox"
				tabIndex={0}
				aria-label={t("jump to turn")}
				aria-activedescendant={hover !== null ? `gui-turn-tick-${hover}` : undefined}
				style={{ height: `${visibleCount * TICK_PITCH_PX}px` }}
				onPointerMove={onTrackPointerMove}
				onPointerDown={onTrackPointerDown}
				onKeyDown={onTrackKeyDown}
				onBlur={() => {
					stopCarousel();
					setHover(null);
				}}
			>
				<div
					className="gui-turn-tape-wrap"
					style={gutterMask ? { maskImage: gutterMask, WebkitMaskImage: gutterMask } : undefined}
				>
					{/* The tape: ticks keep their absolute position on the
					 * strip, and the strip itself glides. */}
					<div
						className="gui-turn-tape"
						style={{ transform: `translateY(-${clampedWindowStart * TICK_PITCH_PX}px)` }}
					>
						{turns.slice(overscanStart, overscanEnd).map((_m, slot) => {
							const index = overscanStart + slot;
							return (
								<div
									key={index}
									id={`gui-turn-tick-${index}`}
									role="option"
									aria-selected={hover === index}
									aria-current={active === index ? "true" : undefined}
									className={`gui-turn-tick${hover === index ? " gui-turn-tick--hover" : ""}${active === index ? " gui-turn-tick--active" : ""}`}
									style={{ top: `${index * TICK_PITCH_PX}px` }}
								>
									<span className="gui-turn-tick-bar" style={{ width: `${resolveWidth(index)}px` }} />
								</div>
							);
						})}
					</div>
				</div>
				{hover !== null && turns[hover] && (
					<div
						ref={panelWheelRef}
						className="gui-turn-panel"
						role="listbox"
						onPointerDown={e => e.stopPropagation()}
						onMouseEnter={cancelHide}
						onMouseLeave={scheduleHide}
					>
						<div
							className="gui-turn-panel-list"
							style={{
								height: `${panelVisibleRows * PANEL_ROW_HEIGHT_PX}px`,
								maskImage: panelMask,
								WebkitMaskImage: panelMask,
							}}
						>
							{/* The list glides so the highlighted row stays in
							 * view while scrubbing the rail. */}
							<div
								className="gui-turn-panel-glide"
								style={{
									height: `${turns.length * PANEL_ROW_HEIGHT_PX}px`,
									transform: `translateY(-${panelScrollOffset}px)`,
								}}
							>
								{turns.slice(panelSliceStart, panelSliceEnd).map((m, slot) => {
									const index = panelSliceStart + slot;
									return (
										<div
											key={index}
											role="option"
											aria-selected={hover === index}
											aria-current={active === index ? "true" : undefined}
											className={`gui-turn-panel-row${hover === index ? " gui-turn-panel-row--hover" : ""}${active === index ? " gui-turn-panel-row--active" : ""}`}
											style={{
												top: `${index * PANEL_ROW_HEIGHT_PX + PANEL_ROW_INSET_Y_PX}px`,
												height: `${PANEL_ROW_HEIGHT_PX - PANEL_ROW_INSET_Y_PX * 2}px`,
											}}
											onMouseMove={() => {
												cancelHide();
												if (hoverRef.current !== index) setHover(index);
											}}
											onClick={() => {
												jumpTo(index);
												setHover(null);
											}}
										>
											<div className="gui-turn-panel-card">
												<span className="gui-turn-panel-text">{m.summary || t("no text")}</span>
											</div>
										</div>
									);
								})}
							</div>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

export { TURN_RAIL_CHANGED_EVENT, TURN_RAIL_SIDE_KEY, TURN_RAIL_STYLE_KEY };
