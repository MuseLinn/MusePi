import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n/index.js";
import "./image-lightbox.css";

/** Exit animation length — must match tr-img-lb-out in image-lightbox.css. */
const EXIT_MS = 150;

/**
 * Full-screen image preview lightbox — patterns absorbed from four
 * references: openchamber ImagePreviewDialog (gallery + wrap-around
 * navigation, backdrop mousedown close), proma ImageLightbox (four
 * arrow keys navigate), bitfun UserMessageItem (simple overlay), and
 * craft-agents ImagePreviewOverlay / useRichBlockInteractions (wheel
 * zoom anchored at the cursor, drag-to-pan when zoomed, double-click
 * and `0` reset, `+`/`-` zoom, scale readout).
 *
 * Esc / ✕ / backdrop-click closes (with a fade-out); ←↑→↓ wrap through
 * the gallery with a directional slide-in when there is more than one
 * image. Portals to document.body so windowed/masked scrollers
 * (transcript, composer) can never clip it. Host-agnostic: pure data
 * props, no GuestClient coupling — shared by the transcript message
 * images and the GUI composer attachment chips.
 */
export function ImageLightbox({
	items,
	index,
	onClose,
	onIndexChange,
}: {
	items: readonly { src: string; alt?: string }[];
	/** Currently shown item; null hides the lightbox (no portal). */
	index: number | null;
	onClose(): void;
	onIndexChange(index: number): void;
}): ReactNode {
	const open = index !== null && index >= 0 && index < items.length;
	const hasNav = items.length > 1;

	// ── Zoom / pan (craft-agents useRichBlockInteractions, simplified) ──
	const ZOOM_STEP = 1.25;
	const MAX_SCALE = 4;
	const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 });
	const viewRef = useRef(view);
	const setViewBoth = (v: { scale: number; tx: number; ty: number }): void => {
		viewRef.current = v;
		setView(v);
	};
	const [dragging, setDragging] = useState(false);
	const dragRef = useRef<{ sx: number; sy: number; tx: number; ty: number } | null>(null);
	const stageRef = useRef<HTMLDivElement | null>(null);
	const imgRef = useRef<HTMLImageElement | null>(null);

	// Clamp pan so the scaled image can't leave the stage entirely.
	const clampPan = (tx: number, ty: number, scale: number): { tx: number; ty: number } => {
		const img = imgRef.current;
		const stage = stageRef.current;
		if (!img || !stage) return { tx, ty };
		const maxX = Math.max(0, (img.offsetWidth * scale - stage.clientWidth) / 2);
		const maxY = Math.max(0, (img.offsetHeight * scale - stage.clientHeight) / 2);
		return { tx: Math.min(maxX, Math.max(-maxX, tx)), ty: Math.min(maxY, Math.max(-maxY, ty)) };
	};
	const resetView = (): void => setViewBoth({ scale: 1, tx: 0, ty: 0 });
	const zoomBy = (factor: number, cx?: number, cy?: number): void => {
		const { scale, tx, ty } = viewRef.current;
		const next = Math.min(MAX_SCALE, Math.max(1, scale * factor));
		if (next === scale) return;
		const stage = stageRef.current;
		let nx = tx;
		let ny = ty;
		if (stage && cx !== undefined && cy !== undefined) {
			// Anchor: keep the point under the cursor fixed.
			const r = stage.getBoundingClientRect();
			const px = cx - r.left - r.width / 2;
			const py = cy - r.top - r.height / 2;
			const k = next / scale;
			nx = px - (px - tx) * k;
			ny = py - (py - ty) * k;
		}
		setViewBoth({ scale: next, ...clampPan(nx, ny, next) });
	};

	// ── Exit animation: hold the last content while the overlay plays
	// tr-img-lb-out (EXIT_MS), then drop it. Reopening cancels. ──
	const lastOpenRef = useRef<{ items: readonly { src: string; alt?: string }[]; index: number } | null>(null);
	const exitTimerRef = useRef<Timer | undefined>(undefined);
	// State flip to force the final render once the exit timer drops the
	// held content (mutating the ref alone would leave the overlay stuck).
	const [exited, setExited] = useState(false);
	useEffect(() => {
		if (open) {
			lastOpenRef.current = { items, index: index as number };
			clearTimeout(exitTimerRef.current);
			exitTimerRef.current = undefined;
			setExited(false);
			return;
		}
		if (!lastOpenRef.current) return;
		exitTimerRef.current = setTimeout(() => {
			lastOpenRef.current = null;
			exitTimerRef.current = undefined;
			setExited(true);
		}, EXIT_MS);
		return () => clearTimeout(exitTimerRef.current);
	}, [open, items, index]);

	// ── Gallery nav direction → directional slide-in on the new frame ──
	const prevIndexRef = useRef<number | null>(open ? (index as number) : null);
	const [dir, setDir] = useState(0);
	useEffect(() => {
		if (!open) return;
		if (prevIndexRef.current !== null && index !== prevIndexRef.current && items.length > 1) {
			const n = items.length;
			setDir((index - prevIndexRef.current + n) % n === 1 ? 1 : -1);
		} else {
			setDir(0);
		}
		prevIndexRef.current = index;
	}, [open, index, items.length]);

	// Native (non-passive) wheel listener: React attaches wheel passively,
	// which would make preventDefault a no-op and let the page scroll.
	useEffect(() => {
		const stage = stageRef.current;
		if (!stage) return;
		const onWheel = (e: WheelEvent): void => {
			e.preventDefault();
			e.stopPropagation();
			zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, e.clientX, e.clientY);
		};
		stage.addEventListener("wheel", onWheel, { passive: false });
		return () => stage.removeEventListener("wheel", onWheel);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	// A different image (gallery nav / new gallery) starts at 1:1.
	useEffect(() => {
		if (open) resetView();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, index, items]);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") {
				onClose();
			} else if (hasNav && (e.key === "ArrowLeft" || e.key === "ArrowUp")) {
				e.preventDefault();
				onIndexChange((index - 1 + items.length) % items.length);
			} else if (hasNav && (e.key === "ArrowRight" || e.key === "ArrowDown")) {
				e.preventDefault();
				onIndexChange((index + 1) % items.length);
			} else if (e.key === "+" || e.key === "=") {
				e.preventDefault();
				zoomBy(ZOOM_STEP);
			} else if (e.key === "-") {
				e.preventDefault();
				zoomBy(1 / ZOOM_STEP);
			} else if (e.key === "0") {
				e.preventDefault();
				resetView();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, hasNav, index, items.length, onClose, onIndexChange]);

	const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
		if (viewRef.current.scale <= 1) return;
		dragRef.current = {
			sx: e.clientX,
			sy: e.clientY,
			tx: viewRef.current.tx,
			ty: viewRef.current.ty,
		};
		e.currentTarget.setPointerCapture(e.pointerId);
		setDragging(true);
	};
	const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
		const d = dragRef.current;
		if (!d) return;
		const { scale } = viewRef.current;
		setViewBoth({ scale, ...clampPan(d.tx + (e.clientX - d.sx), d.ty + (e.clientY - d.sy), scale) });
	};
	const endDrag = (): void => {
		dragRef.current = null;
		setDragging(false);
	};

	// Content to show: live while open, otherwise the held exit frame.
	const shown = open ? { items, index: index as number } : lastOpenRef.current;
	if (!shown || shown.items[shown.index] === undefined) return null;
	const isClosing = !open && !exited;
	const shownItem = shown.items[shown.index];
	const shownHasNav = shown.items.length > 1;
	const scale = view.scale;
	const cursor = dragging ? "grabbing" : scale > 1 ? "grab" : "zoom-in";
	const prev = (): void => onIndexChange((shown.index - 1 + shown.items.length) % shown.items.length);
	const next = (): void => onIndexChange((shown.index + 1) % shown.items.length);
	return createPortal(
		// Backdrop closes on mousedown (openchamber parity); inner controls
		// stop propagation so they never dismiss the dialog.
		<div
			className={`tr-img-lb${isClosing ? " tr-img-lb--closing" : ""}`}
			role="dialog"
			aria-modal="true"
			aria-label={t("preview image")}
			onMouseDown={isClosing ? undefined : onClose}
		>
			<button
				type="button"
				className="tr-img-lb-x"
				aria-label={t("close")}
				onMouseDown={e => e.stopPropagation()}
				onClick={onClose}
			>
				<X size={16} />
			</button>
			{shownHasNav && (
				<>
					<button
						type="button"
						className="tr-img-lb-nav tr-img-lb-nav--prev"
						aria-label={t("previous image")}
						onMouseDown={e => e.stopPropagation()}
						onClick={prev}
					>
						<ChevronLeft size={22} />
					</button>
					<button
						type="button"
						className="tr-img-lb-nav tr-img-lb-nav--next"
						aria-label={t("next image")}
						onMouseDown={e => e.stopPropagation()}
						onClick={next}
					>
						<ChevronRight size={22} />
					</button>
				</>
			)}
			<div
				ref={stageRef}
				className="tr-img-lb-stage"
				style={{ cursor }}
				onMouseDown={e => e.stopPropagation()}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={endDrag}
				onPointerCancel={endDrag}
				onDoubleClick={resetView}
			>
				<div
					key={shown.index}
					className={`tr-img-lb-frame${dir === 1 ? " tr-img-lb-frame--next" : dir === -1 ? " tr-img-lb-frame--prev" : ""}`}
				>
					<img
						ref={imgRef}
						className="tr-img-lb-img"
						src={shownItem.src}
						alt={shownItem.alt ?? t("attachment")}
						style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${scale})` }}
						draggable={false}
					/>
				</div>
			</div>
			{shownHasNav && (
				<div className="tr-img-lb-count" aria-hidden="true">
					{shown.index + 1} / {shown.items.length}
					{scale > 1 ? ` · ${Math.round(scale * 100)}%` : ""}
				</div>
			)}
		</div>,
		document.body,
	);
}
