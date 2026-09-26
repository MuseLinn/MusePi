import { ChevronLeft, ChevronRight, Download, Pencil, X } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n/index.js";
import {
	computeMorph,
	MORPH_EASING_IN,
	MORPH_EASING_OUT,
	MORPH_MS,
	type MorphRect,
	motionDisabled,
} from "./image-morph.js";
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
	onAnnotate,
	onEdit,
	originRect = null,
}: {
	items: readonly { src: string; alt?: string }[];
	/** Currently shown item; null hides the lightbox (no portal). */
	index: number | null;
	onClose(): void;
	onIndexChange(index: number): void;
	/** Source thumbnail rect (the chip's getBoundingClientRect at open
	 *  time). M1.10 §3.3 一镜到底: present → the image flies from this rect
	 *  to the stage on open and back on close (backdrop fades independently
	 *  — it is not a shared element). Absent/null → the legacy fade. The
	 *  host re-measures at close time: a chip deleted or scrolled away
	 *  mid-preview yields null and the close degrades to the fade. */
	originRect?: MorphRect | null;
	/** Open-science FigureBlock parity: click-to-pin annotations with a
	 * note, delivered back to the host (forwarded to the agent / pasted
	 * into the composer). Optional — omit for plain preview. */
	onAnnotate?(annotations: { index: number; x: number; y: number; note: string }[]): void;
	/** Codex 编辑预览 parity: open the shown image in a drawing board.
	 * Optional — the edit button hides when absent. */
	onEdit?(src: string): void;
}): ReactNode {
	const open = index !== null && index >= 0 && index < items.length;
	const hasNav = items.length > 1;

	// ── Annotations (open-science FigureBlock absorption) ────────────────
	const [annotateMode, setAnnotateMode] = useState(false);
	const [pins, setPins] = useState<{ index: number; x: number; y: number; note: string }[]>([]);
	const [editing, setEditing] = useState<number | null>(null);
	const [noteDraft, setNoteDraft] = useState("");
	const imgWrapRef = useRef<HTMLDivElement | null>(null);

	const startAnnotate = (): void => {
		setAnnotateMode(true);
		setPins([]);
		setEditing(null);
	};
	const cancelAnnotate = (): void => {
		setAnnotateMode(false);
		setPins([]);
		setEditing(null);
	};
	const finishAnnotate = (): void => {
		if (onAnnotate && pins.length > 0) onAnnotate(pins);
		setAnnotateMode(false);
		setPins([]);
		setEditing(null);
		onClose();
	};
	const addPinAt = (e: React.MouseEvent<HTMLDivElement>): void => {
		if (!annotateMode) return;
		const wrap = imgWrapRef.current;
		if (!wrap) return;
		const rect = wrap.getBoundingClientRect();
		const x = rect.width ? ((e.clientX - rect.left) / rect.width) * 100 : 0;
		const y = rect.height ? ((e.clientY - rect.top) / rect.height) * 100 : 0;
		const pin = {
			index: pins.length + 1,
			x: Math.min(100, Math.max(0, x)),
			y: Math.min(100, Math.max(0, y)),
			note: "",
		};
		setPins(prev => [...prev, pin]);
		setEditing(pin.index);
		setNoteDraft("");
	};
	const commitPinNote = (): void => {
		if (editing === null) return;
		setPins(prev => prev.map(p => (p.index === editing ? { ...p, note: noteDraft.trim() } : p)));
		setEditing(null);
		setNoteDraft("");
	};

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
	// tr-img-lb-out (EXIT_MS), then drop it. Reopening cancels. When the
	// open morph played, the exit instead flies the frame back into the
	// source chip (MORPH_MS, see below). ──
	const lastOpenRef = useRef<{ items: readonly { src: string; alt?: string }[]; index: number } | null>(null);
	const exitTimerRef = useRef<Timer | undefined>(undefined);
	// State flip to force the final render once the exit timer drops the
	// held content (mutating the ref alone would leave the overlay stuck).
	const [exited, setExited] = useState(false);
	// Morph machinery: the flying frame element, whether the open flight
	// actually played (drives the reverse flight), the close animation
	// itself (cancelled on reopen — its fill:forwards would otherwise pin
	// the landed transform), and the render flag for the morph-close class.
	const frameRef = useRef<HTMLDivElement | null>(null);
	const morphLiveRef = useRef(false);
	const closeAnimRef = useRef<Animation | null>(null);
	const [morphClosing, setMorphClosing] = useState(false);
	useEffect(() => {
		if (open) {
			lastOpenRef.current = { items, index: index as number };
			clearTimeout(exitTimerRef.current);
			exitTimerRef.current = undefined;
			setExited(false);
			setMorphClosing(false);
			return;
		}
		if (!lastOpenRef.current) return;
		// Close flight (M1.10 §3.3): when the open morph played, fly the
		// frame back into the source chip's rect before unmounting. The host
		// re-measures the chip at close time, so a chip deleted/scrolled away
		// mid-preview yields a null originRect and we fall back to the fade.
		const origin = originRect;
		if (morphLiveRef.current && origin != null && !motionDisabled()) {
			setMorphClosing(true);
			const raf = requestAnimationFrame(() => {
				const img = imgRef.current;
				const frame = frameRef.current;
				if (!img || !frame) return;
				const target = img.getBoundingClientRect();
				const m = computeMorph(origin, target);
				if (!m) return;
				// fill:forwards pins the landed transform during the hold;
				// the animation is cancelled on reopen (open-morph effect).
				closeAnimRef.current = frame.animate(
					[
						{ transform: "none", transformOrigin: "top left" },
						{
							transform: `translate(${m.dx}px, ${m.dy}px) scale(${m.sx}, ${m.sy})`,
							transformOrigin: "top left",
						},
					],
					{ duration: MORPH_MS, easing: MORPH_EASING_OUT, fill: "forwards" },
				);
			});
			exitTimerRef.current = setTimeout(() => {
				lastOpenRef.current = null;
				exitTimerRef.current = undefined;
				setExited(true);
				setMorphClosing(false);
			}, MORPH_MS);
			return () => {
				cancelAnimationFrame(raf);
				clearTimeout(exitTimerRef.current);
			};
		}
		exitTimerRef.current = setTimeout(() => {
			lastOpenRef.current = null;
			exitTimerRef.current = undefined;
			setExited(true);
		}, EXIT_MS);
		return () => clearTimeout(exitTimerRef.current);
	}, [open, items, index, originRect]);

	// ── Open morph (M1.10 §3.3 一镜到底): render at final layout, measure
	// the stage rect, then fly the frame FROM the source thumbnail's rect
	// (FLIP). Runs in a layout effect — after the DOM commit but before
	// paint, so the un-morphed frame never paints (same discipline as the
	// scene-switch morphFrame). WAAPI rather than a class-toggle rAF dance
	// for the reason morphFrame documents: an explicit animation always
	// plays its timeline. Deliberately keyed on `open` alone — gallery
	// navigation must never re-run the flight (only the first open morphs);
	// originRect is read from the opening render's closure. ──
	useLayoutEffect(() => {
		// NOTE: on !open this effect does NOTHING (early return) — the close
		// flight below reads morphLiveRef in its own effect, which must see
		// the value the open phase left behind (layout effects run first and
		// would otherwise wipe it before the close effect reads it).
		if (!open) return;
		morphLiveRef.current = false;
		closeAnimRef.current?.cancel();
		closeAnimRef.current = null;
		if (!originRect || motionDisabled()) return;
		const img = imgRef.current;
		const frame = frameRef.current;
		if (!img || !frame) return;
		const fly = (): void => {
			const target = img.getBoundingClientRect();
			const m = computeMorph(originRect, target);
			if (!m) return;
			morphLiveRef.current = true;
			frame.animate(
				[
					{
						transform: `translate(${m.dx}px, ${m.dy}px) scale(${m.sx}, ${m.sy})`,
						transformOrigin: "top left",
					},
					{ transform: "none", transformOrigin: "top left" },
				],
				{ duration: MORPH_MS, easing: MORPH_EASING_IN },
			);
		};
		// The stage rect is only meaningful once the image has intrinsic
		// size; until then the frame is held invisible (a not-yet-loaded
		// image would collapse the layout and morph into a tiny box).
		let done = false;
		const settle = (): void => {
			if (done) return;
			done = true;
			frame.style.visibility = "";
			fly();
		};
		const fail = (): void => {
			if (done) return;
			done = true;
			frame.style.visibility = "";
		};
		if (img.complete && img.naturalWidth > 0) fly();
		else {
			frame.style.visibility = "hidden";
			img.addEventListener("load", settle, { once: true });
			img.addEventListener("error", fail, { once: true });
		}
		return () => {
			done = true;
			img.removeEventListener("load", settle);
			img.removeEventListener("error", fail);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

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
		if (annotateMode || viewRef.current.scale <= 1) return;
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

	// Download the shown image (ZCode preview parity): refetch the src into
	// a blob so both data URLs and remote URLs save, name from the mime
	// type with a timestamp stamp; a failed fetch falls back to opening the
	// source in a new tab rather than doing nothing.
	const downloadImage = (item: { src: string; alt?: string }): void => {
		void (async () => {
			try {
				const res = await fetch(item.src);
				const blob = await res.blob();
				const ext = blob.type.includes("jpeg")
					? "jpg"
					: blob.type.includes("webp")
						? "webp"
						: blob.type.includes("gif")
							? "gif"
							: blob.type.includes("svg")
								? "svg"
								: "png";
				const d = new Date();
				const p2 = (n: number): string => String(n).padStart(2, "0");
				const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
				const url = URL.createObjectURL(blob);
				const a = document.createElement("a");
				a.href = url;
				a.download = `musepi-image-${stamp}.${ext}`;
				a.click();
				setTimeout(() => URL.revokeObjectURL(url), 4000);
			} catch {
				window.open(item.src, "_blank");
			}
		})();
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
			className={`tr-img-lb${isClosing && !morphClosing ? " tr-img-lb--closing" : ""}${
				morphClosing ? " tr-img-lb--morph-closing" : ""
			}`}
			role="dialog"
			aria-modal="true"
			aria-label={t("preview image")}
			onMouseDown={isClosing || morphClosing ? undefined : onClose}
		>
			{/* Backdrop plate: the dimmed/blurred floor is NOT a shared element,
			 * so it fades independently of the morphing image (M1.10 §3.3) —
			 * split out of .tr-img-lb so an open/close morph never fades the
			 * flying frame with the room. */}
			<div className="tr-img-lb-backdrop" aria-hidden />
			{/* Download + close as one group (ZCode preview parity), inset
			    from the corner so the pair clears the window chrome and reads
			    as a row rather than a lone floating X. */}
			<div className="tr-img-lb-actions" onMouseDown={e => e.stopPropagation()}>
				{onEdit && (
					<button
						type="button"
						className="tr-img-lb-x"
						aria-label={t("sketch")}
						title={t("sketch")}
						onClick={() => {
							onClose();
							onEdit(shownItem.src);
						}}
					>
						<Pencil size={16} />
					</button>
				)}
				<button
					type="button"
					className="tr-img-lb-x"
					aria-label={t("download image")}
					title={t("download image")}
					onClick={() => downloadImage(shownItem)}
				>
					<Download size={16} />
				</button>
				<button
					type="button"
					className="tr-img-lb-x"
					aria-label={t("close")}
					onClick={annotateMode ? cancelAnnotate : onClose}
				>
					<X size={16} />
				</button>
			</div>
			{onAnnotate && (
				<div className="tr-img-lb-tools" onMouseDown={e => e.stopPropagation()}>
					{annotateMode ? (
						<>
							<span className="tr-img-lb-annotate-hint">{t("click on image to place a pin")}</span>
							<button
								type="button"
								className="tr-img-lb-tool tr-img-lb-tool--primary"
								onClick={finishAnnotate}
								disabled={pins.length === 0}
							>
								{t("send annotations")}
							</button>
							<button type="button" className="tr-img-lb-tool" onClick={cancelAnnotate}>
								{t("cancel")}
							</button>
						</>
					) : (
						<button type="button" className="tr-img-lb-tool" onClick={startAnnotate}>
							{t("annotate image")}
						</button>
					)}
				</div>
			)}
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
					ref={frameRef}
					className={`tr-img-lb-frame${dir === 1 ? " tr-img-lb-frame--next" : dir === -1 ? " tr-img-lb-frame--prev" : ""}`}
				>
					<div
						ref={imgWrapRef}
						className="tr-img-lb-imgwrap"
						style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${scale})` }}
						onClick={annotateMode ? addPinAt : undefined}
					>
						<img
							ref={imgRef}
							className="tr-img-lb-img"
							src={shownItem.src}
							alt={shownItem.alt ?? t("attachment")}
							draggable={false}
						/>
						{pins.map(p => (
							<button
								type="button"
								key={p.index}
								className="tr-img-lb-pin"
								style={{ left: `${p.x}%`, top: `${p.y}%` }}
								aria-label={t("annotation {index}", { index: String(p.index) })}
								onMouseDown={e => e.stopPropagation()}
								onClick={e => {
									e.stopPropagation();
									if (editing === p.index) {
										commitPinNote();
									} else {
										setEditing(p.index);
										setNoteDraft(p.note);
									}
								}}
							>
								{p.index}
							</button>
						))}
						{editing !== null && (
							<div className="tr-img-lb-note" onMouseDown={e => e.stopPropagation()}>
								<input
									className="tr-img-lb-note-input"
									value={noteDraft}
									autoFocus
									placeholder={t("annotation note placeholder")}
									onChange={e => setNoteDraft(e.target.value)}
									onKeyDown={e => {
										if (e.key === "Enter") commitPinNote();
										if (e.key === "Escape") setEditing(null);
									}}
								/>
							</div>
						)}
					</div>
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
