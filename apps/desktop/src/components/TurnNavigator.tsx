import { type TurnIndexItem, t } from "@musepi/client-core";
import { ArrowUp as ArrowUpIconData, LoaderCircle as LoaderCircleIconData } from "lucide";
import { MorphIcon } from "morphicons/react";
import type { ReactNode, RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PacMan } from "../vendor/pac-man";

/** Chat-mode source: one record per turn from the daemon index, plus the
 *  paging state for history the index does not cover yet. */
export interface TurnNavigatorDataSource {
	turns: readonly TurnIndexItem[];
	/** Daemon still has history older than the index — the load control pages it. */
	hasMoreAbove: boolean;
	/** A page is in flight; the control owns its own pending state. */
	loadingOlder: boolean;
	onRequestOlder?: () => void;
}

export type TurnNavigatorSide = "right" | "left";
export type TurnNavigatorStyle = "burger" | "pacman";

const TURN_RAIL_SIDE_KEY = "omp-collab-turnrail-side";
const TURN_RAIL_STYLE_KEY = "omp-collab-turnrail-style";
const TURN_RAIL_CHANGED_EVENT = "omp-turnrail-changed";

/** Fixed pitch between marks. The pac-man glyph needs a taller slot. */
const PITCH_BURGER = 10;
const PITCH_PACMAN = 12;
/** Padding above the first mark and below the last. */
const INSET_PX = 6;
/** Rows rendered beyond the viewport so marks slide in under the fade. */
const OVERSCAN = 4;
/** Fade band reserved at a scrollable end. */
const FADE_PX = 24;
const MAX_FRAME_PX = 420;
/** Within this distance of the bottom the reader is following the tail. */
const NEAR_BOTTOM_PX = 32;
/** Reading line from the scrollport's top, capped for tall viewports. */
const READING_LINE_MAX_PX = 96;
/** Proximity wave: the previewed mark stretches, neighbours taper. */
const FALLOFF = [1, 0.6, 0.35, 0.15] as const;
const MARK_BASE_PX = 10;
const MARK_ACTIVE_PX = 14;
const MARK_FOCUS_PX = 20;
const MARK_FOCUS_PACMAN_PX = 16;

interface NavigatorTurn {
	summary: string;
	kind: "user" | "advisor";
	/** Chat mode: stable entry id the jump dispatcher resolves. */
	entryId?: string;
	/** Canvas mode: node id the caller selects. */
	id?: string;
}

function loadPref(key: string, fallback: string): string {
	try {
		return localStorage.getItem(key) ?? fallback;
	} catch {
		return fallback;
	}
}

function reducedMotion(): boolean {
	return (
		document.documentElement.classList.contains("gui-motion-off") ||
		window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
	);
}

/**
 * Transcript turn navigator: one fixed-pitch mark per turn inside a scrollable
 * frame. Hover or focus previews the turn's prompt in a non-interactive
 * tooltip; click navigates. The active mark centres itself only while the
 * pointer is outside the frame, so the rail never moves under the hand.
 *
 * The active turn follows reading, not the first row that happens to sit at the
 * top: near the bottom it is the latest turn, otherwise the last turn whose
 * start row is above a reading line (`min(96px, 20% of the scrollport)`).
 * Canvas mode supplies its own active node instead.
 */
export function TurnNavigator({
	rootRef,
	nodeTurns,
	activeTurnIndex,
	onSelectNode,
	turnsData,
	onJumpToTurn,
}: {
	rootRef: RefObject<HTMLDivElement | null>;
	/** Canvas mode: the transcript scroller is not mounted there, so the marks
	 *  ARE the active-path user messages and clicks hand the node to the caller. */
	nodeTurns?: readonly { id: string; summary: string }[];
	/** Index into nodeTurns of the turn the active leaf belongs to. */
	activeTurnIndex?: number | null;
	onSelectNode?(nodeId: string): void;
	/** Chat mode: the turn index and the daemon paging state. */
	turnsData?: TurnNavigatorDataSource;
	/** Chat mode: the clicked turn's entry id — the caller pages history in and
	 *  dispatches the jump, so an unloaded row is still reachable. */
	onJumpToTurn?(entryId: string): void;
}): ReactNode {
	const [side, setSide] = useState<TurnNavigatorSide>(
		() => loadPref(TURN_RAIL_SIDE_KEY, "right") as TurnNavigatorSide,
	);
	const [style, setStyle] = useState<TurnNavigatorStyle>(
		() => loadPref(TURN_RAIL_STYLE_KEY, "burger") as TurnNavigatorStyle,
	);
	const [preview, setPreview] = useState<number | null>(null);
	const [active, setActive] = useState<number | null>(null);
	const [scrollTop, setScrollTop] = useState(0);
	const [frameHeight, setFrameHeight] = useState(0);
	const frameRef = useRef<HTMLDivElement | null>(null);
	/** While the pointer works the rail, the active mark must not move under it. */
	const pointerInsideRef = useRef(false);

	const pitch = style === "pacman" ? PITCH_PACMAN : PITCH_BURGER;

	const turns = useMemo<NavigatorTurn[]>(() => {
		if (nodeTurns) return nodeTurns.map(turn => ({ summary: turn.summary, kind: "user" as const, id: turn.id }));
		return (turnsData?.turns ?? []).map(turn => ({
			summary: turn.summary,
			kind: turn.kind,
			entryId: turn.entryId,
		}));
	}, [nodeTurns, turnsData]);

	/** Timestamp → absolute mark index; the transcript rows carry the same key. */
	const tsToIndex = useMemo(() => {
		const map = new Map<string, number>();
		if (nodeTurns) return map;
		(turnsData?.turns ?? []).forEach((turn, index) => map.set(turn.timestamp, index));
		return map;
	}, [nodeTurns, turnsData]);

	// Preferences are written by the appearance settings; pick them up live.
	useEffect(() => {
		const onChange = (): void => {
			setSide(loadPref(TURN_RAIL_SIDE_KEY, "right") as TurnNavigatorSide);
			setStyle(loadPref(TURN_RAIL_STYLE_KEY, "burger") as TurnNavigatorStyle);
		};
		window.addEventListener(TURN_RAIL_CHANGED_EVENT, onChange);
		return () => window.removeEventListener(TURN_RAIL_CHANGED_EVENT, onChange);
	}, []);

	const computeActive = useCallback((): void => {
		if (nodeTurns) {
			setActive(activeTurnIndex ?? null);
			return;
		}
		const root = rootRef.current;
		if (!root || turns.length === 0) {
			setActive(null);
			return;
		}
		// Following the tail: the latest turn is what the reader is looking at,
		// even when its start row sits below the reading line (a short turn).
		const remaining = root.scrollHeight - root.scrollTop - root.clientHeight;
		if (remaining <= NEAR_BOTTOM_PX) {
			setActive(turns.length - 1);
			return;
		}
		const rootTop = root.getBoundingClientRect().top;
		const line = Math.min(READING_LINE_MAX_PX, root.clientHeight * 0.2);
		let index = 0;
		for (const el of root.querySelectorAll<HTMLElement>(
			".tr-row[data-turn-start-ts], .tr-round-fold[data-turn-start-ts]",
		)) {
			if (el.getBoundingClientRect().top - rootTop > line) break;
			const found = tsToIndex.get(el.dataset.turnStartTs ?? "");
			if (found !== undefined) index = found;
		}
		setActive(index);
	}, [activeTurnIndex, nodeTurns, rootRef, tsToIndex, turns.length]);

	useEffect(() => {
		computeActive();
	}, [computeActive]);

	// Scroll-spy, rAF-throttled: a burst of scroll events collapses into one read.
	useEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		let raf = 0;
		const onScroll = (): void => {
			if (raf !== 0) return;
			raf = requestAnimationFrame(() => {
				raf = 0;
				computeActive();
			});
		};
		root.addEventListener("scroll", onScroll, { passive: true });
		window.addEventListener("resize", computeActive);
		return () => {
			root.removeEventListener("scroll", onScroll);
			window.removeEventListener("resize", computeActive);
			if (raf !== 0) cancelAnimationFrame(raf);
		};
	}, [computeActive, rootRef]);

	// The frame's height decides which marks are rendered and where the preview
	// sits; observe it rather than assume the max-height.
	useEffect(() => {
		const frame = frameRef.current;
		if (!frame) return;
		const sync = (): void => setFrameHeight(frame.clientHeight);
		sync();
		if (typeof ResizeObserver !== "function") return;
		const observer = new ResizeObserver(sync);
		observer.observe(frame);
		return () => observer.disconnect();
	}, [turns.length, style]);

	// Keep the active mark inside the fade-free band while the pointer is outside.
	useEffect(() => {
		const frame = frameRef.current;
		if (!frame || active === null || pointerInsideRef.current) return;
		const top = INSET_PX + active * pitch;
		const viewTop = frame.scrollTop + FADE_PX;
		const viewBottom = frame.scrollTop + frame.clientHeight - FADE_PX;
		if (top >= viewTop && top + pitch <= viewBottom) return;
		const target = Math.max(0, top - (frame.clientHeight - pitch) / 2);
		if (typeof frame.scrollTo === "function") {
			frame.scrollTo({ top: target, behavior: reducedMotion() ? "auto" : "smooth" });
		} else {
			frame.scrollTop = target;
		}
	}, [active, frameHeight, pitch, turns.length]);

	const reveal = useCallback(
		(index: number): void => {
			const frame = frameRef.current;
			if (!frame) return;
			const top = INSET_PX + index * pitch;
			const viewTop = frame.scrollTop + FADE_PX;
			const viewBottom = frame.scrollTop + frame.clientHeight - FADE_PX;
			if (top >= viewTop && top + pitch <= viewBottom) return;
			frame.scrollTop = Math.max(0, top - (frame.clientHeight - pitch) / 2);
		},
		[pitch],
	);

	const jumpTo = useCallback(
		(index: number): void => {
			const turn = turns[index];
			if (!turn) return;
			if (turn.id && onSelectNode) {
				onSelectNode(turn.id);
				return;
			}
			if (turn.entryId) onJumpToTurn?.(turn.entryId);
		},
		[onJumpToTurn, onSelectNode, turns],
	);

	const onFrameKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLDivElement>): void => {
			const length = turns.length;
			if (length === 0) return;
			const current = preview ?? active ?? length - 1;
			const moveTo = (index: number): void => {
				const next = Math.max(0, Math.min(length - 1, index));
				setPreview(next);
				reveal(next);
			};
			switch (event.key) {
				case "ArrowUp":
					event.preventDefault();
					moveTo(current - 1);
					break;
				case "ArrowDown":
					event.preventDefault();
					moveTo(current + 1);
					break;
				case "Home":
					event.preventDefault();
					moveTo(0);
					break;
				case "End":
					event.preventDefault();
					moveTo(length - 1);
					break;
				case "Enter":
				case " ":
					event.preventDefault();
					jumpTo(current);
					setPreview(null);
					break;
				case "Escape":
					event.preventDefault();
					setPreview(null);
					event.currentTarget.blur();
					break;
				default:
					break;
			}
		},
		[active, jumpTo, preview, reveal, turns.length],
	);

	const markWidth = (index: number): number => {
		const base = index === active ? MARK_ACTIVE_PX : MARK_BASE_PX;
		if (preview === null) return base;
		const factor = FALLOFF[Math.min(Math.abs(index - preview), FALLOFF.length - 1)] ?? 0;
		const focus = style === "pacman" ? MARK_FOCUS_PACMAN_PX : MARK_FOCUS_PX;
		return Math.round(base + (focus - base) * factor);
	};

	if (turns.length === 0) return null;

	const totalHeight = INSET_PX * 2 + turns.length * pitch;
	const viewport = frameHeight || MAX_FRAME_PX;
	const maxScroll = Math.max(0, totalHeight - viewport);
	const fadeTop = scrollTop > 1;
	const fadeBottom = scrollTop < maxScroll - 1;
	const mask =
		fadeTop || fadeBottom
			? `linear-gradient(to bottom, ${
					fadeTop ? `transparent, black ${FADE_PX}px` : "black"
				}, ${fadeBottom ? `black calc(100% - ${FADE_PX}px), transparent` : "black"})`
			: undefined;

	const firstVisible = Math.max(0, Math.floor((scrollTop - INSET_PX) / pitch) - OVERSCAN);
	const lastVisible = Math.min(turns.length, Math.ceil((scrollTop + viewport - INSET_PX) / pitch) + OVERSCAN);
	const previewTop =
		preview === null
			? 0
			: Math.min(Math.max(INSET_PX + preview * pitch + pitch / 2 - scrollTop, pitch / 2), viewport - pitch / 2);
	const previewTurn = preview === null ? undefined : turns[preview];
	// Only the daemon's verdict may raise the pager; "more marks above the
	// window" is a different condition (the frame scrolls instead).
	const olderPager = turnsData?.hasMoreAbove === true ? turnsData : null;

	return (
		<div
			className="gui-turn-nav"
			data-side={side}
			data-style={style}
			onPointerEnter={() => {
				pointerInsideRef.current = true;
			}}
			onPointerLeave={() => {
				pointerInsideRef.current = false;
				setPreview(null);
			}}
		>
			{olderPager && (
				<button
					type="button"
					className="gui-turn-loadmore"
					aria-label={t("settings.loadMorePrompts")}
					title={t("settings.loadMorePrompts")}
					disabled={olderPager.loadingOlder}
					onClick={() => {
						if (!olderPager.loadingOlder) olderPager.onRequestOlder?.();
					}}
				>
					<MorphIcon
						icon={olderPager.loadingOlder ? LoaderCircleIconData : ArrowUpIconData}
						size={14}
						spring="snappy"
						reducedMotion="user"
						className="gui-turn-loadmore-icon"
					/>
				</button>
			)}
			<div
				ref={frameRef}
				className="gui-turn-frame"
				role="listbox"
				tabIndex={0}
				aria-label={t("settings.jumpTurn")}
				aria-activedescendant={preview !== null ? `gui-turn-mark-${preview}` : undefined}
				style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
				onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
				onKeyDown={onFrameKeyDown}
				onBlur={() => setPreview(null)}
			>
				<div className="gui-turn-marks" style={{ height: `${totalHeight}px` }}>
					{turns.slice(firstVisible, lastVisible).map((turn, slot) => {
						const index = firstVisible + slot;
						return (
							<button
								key={index}
								id={`gui-turn-mark-${index}`}
								type="button"
								role="option"
								tabIndex={-1}
								aria-selected={preview === index}
								aria-current={active === index ? "true" : undefined}
								aria-label={turn.summary || t("settings.noText")}
								className={`gui-turn-mark${preview === index ? " gui-turn-mark--preview" : ""}${
									active === index ? " gui-turn-mark--active" : ""
								}`}
								style={{ top: `${INSET_PX + index * pitch}px`, height: `${pitch}px` }}
								onPointerEnter={() => setPreview(index)}
								onFocus={() => setPreview(index)}
								onClick={() => jumpTo(index)}
							>
								<span className="gui-turn-mark-bar" style={{ width: `${markWidth(index)}px` }}>
									{style === "pacman" && (
										<PacMan
											size={markWidth(index)}
											side={side === "left" ? "left" : "right"}
											mouth={active === index ? 0.04 : preview === index ? 0.6 : 0.3}
											animating={preview === index}
										/>
									)}
								</span>
							</button>
						);
					})}
				</div>
			</div>
			{previewTurn && (
				<div className="gui-turn-preview" role="tooltip" style={{ top: `${previewTop}px` }}>
					{previewTurn.kind === "advisor" && <span className="gui-turn-preview-kind">{t("general.advisor")}</span>}
					<span className="gui-turn-preview-text">{previewTurn.summary || t("settings.noText")}</span>
				</div>
			)}
		</div>
	);
}

export { TURN_RAIL_CHANGED_EVENT, TURN_RAIL_SIDE_KEY, TURN_RAIL_STYLE_KEY };
