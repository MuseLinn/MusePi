import { t } from "@musepi/guest-client";
import type Konva from "konva";
import {
	ArrowUpRight,
	Check,
	Circle,
	Eraser,
	MousePointer2,
	Pencil,
	Redo2,
	Slash,
	Square,
	Trash2,
	Undo2,
	X,
} from "lucide-react";
import { getStroke } from "perfect-freehand";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Arrow, Ellipse, Image as KonvaImage, Layer, Line, Rect, Stage } from "react-konva";
import { useConfirm } from "../lib/prompt-dialog";

/**
 * SketchPad (Codex 绘画 parity) — a lightweight drawing overlay launched
 * from the composer attach menu (or an image lightbox's edit button).
 *
 * Stack choice (long-termism review, 2026-09-18): react-konva for the
 * scene graph (hit-detection eraser, per-shape nodes) plus
 * perfect-freehand for pressure-simulated ink strokes. Both MIT, both
 * actively maintained; paper.js was rejected (stalled upstream), tldraw
 * (license/watermark) and Excalidraw (opinionated full editor UI, heavy)
 * were the other candidates. openchamber has no freehand board to copy —
 * its react-drawio is a diagrams.net embed.
 *
 * Flow: draw → 完成 exports a PNG (pixelRatio 2, canvas background
 * included) through the composer's normal image attachment pipeline;
 * editing an existing attachment / lightbox image mounts it as the base
 * layer. Closing plays the same scale-out as completing, so the board
 * reads as "falling back" into the composer (Codex's zoom-away,
 * simplified to a 180ms transform toward the composer row).
 */

type Tool = "select" | "pen" | "eraser" | "line" | "arrow" | "rect" | "ellipse";

interface Stroke {
	id: number;
	tool: Exclude<Tool, "eraser">;
	color: string;
	size: number;
	/** pen: flat [x,y,pressure,…]; shapes: [x0,y0,x1,y1]. */
	points: number[];
}

/** Undo/redo ops: single-stroke adds, batch clears, and moves all keep the
 *  stacks small. A move records `from`/`to` deltas so undo is exact. */
type Op =
	| { kind: "add"; stroke: Stroke }
	| { kind: "clear"; strokes: Stroke[] }
	| { kind: "move"; id: number; from: number[]; to: number[] };

const PALETTE = [
	"#1f2328",
	"#6b7280",
	"#f4f4f5",
	"#e5484d",
	"#f76b15",
	"#ffb224",
	"#46a758",
	"#00a2c7",
	"#3e63dd",
	"#8e4ec6",
];

const SIZES = [2, 4, 8, 14];

const TOOL_ITEMS = [
	["select", MousePointer2, "sketch tool select"],
	["pen", Pencil, "sketch tool pen"],
	["eraser", Eraser, "sketch tool eraser"],
	["line", Slash, "sketch tool line"],
	["arrow", ArrowUpRight, "sketch tool arrow"],
	["rect", Square, "sketch tool rect"],
	["ellipse", Circle, "sketch tool ellipse"],
] as const;

function themeCanvasColor(): string {
	if (typeof document === "undefined") return "#ffffff";
	const scheme = document.documentElement.dataset.colorScheme ?? document.documentElement.dataset.theme;
	return scheme === "dark" ? "#1c1d21" : "#ffffff";
}

/** Load a data/remote URL into an HTMLImageElement for the base layer. */
function useLoadedImage(src: string | null): HTMLImageElement | null {
	const [img, setImg] = useState<HTMLImageElement | null>(null);
	useEffect(() => {
		if (!src) {
			setImg(null);
			return;
		}
		const el = new Image();
		el.onload = () => setImg(el);
		el.src = src;
	}, [src]);
	return img;
}

/** perfect-freehand outline → Konva Line points (flat x,y pairs).
 *  Input is our flat [x,y,pressure,…] storage, regrouped into the
 *  triplets the library expects. */
function inkOutline(points: number[], size: number): number[] {
	const triplets: Array<[number, number, number]> = [];
	for (let i = 0; i + 2 < points.length; i += 3) triplets.push([points[i], points[i + 1], points[i + 2]]);
	const outline = getStroke(triplets, {
		size: size * 2.2,
		thinning: 0.55,
		smoothing: 0.62,
		streamline: 0.5,
		simulatePressure: true,
		easing: (t: number): number => Math.sin((t * Math.PI) / 2),
	});
	const flat: number[] = [];
	for (const p of outline) flat.push(p[0], p[1]);
	return flat;
}

/** Bounding box of a stroke, padded for line width — the select tool draws
 *  its dashed frame from this. */
function strokeBox(s: Stroke): { x: number; y: number; w: number; h: number } {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	if (s.tool === "pen") {
		for (let i = 0; i + 1 < s.points.length; i += 3) {
			const x = s.points[i];
			const y = s.points[i + 1];
			if (x < minX) minX = x;
			if (y < minY) minY = y;
			if (x > maxX) maxX = x;
			if (y > maxY) maxY = y;
		}
	} else {
		const [x0, y0, x1, y1] = s.points;
		minX = Math.min(x0, x1);
		minY = Math.min(y0, y1);
		maxX = Math.max(x0, x1);
		maxY = Math.max(y0, y1);
	}
	const pad = s.size * 1.8 + 4;
	return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}

/** Contain-fit an image into the stage box, centered. */
function fitImage(
	img: { width: number; height: number },
	w: number,
	h: number,
): { x: number; y: number; width: number; height: number } {
	const scale = Math.min(w / img.width, h / img.height);
	return {
		x: (w - img.width * scale) / 2,
		y: (h - img.height * scale) / 2,
		width: img.width * scale,
		height: img.height * scale,
	};
}

/** Translate a stroke's points by (dx,dy). Pen points are [x,y,pressure,…],
 *  shapes are [x0,y0,x1,y1] — both carry x at even and y at odd indices, so
 *  the same stride rule shifts either. Committing moves through this instead
 *  of walking raw arrays at every call site. */
function shiftPoints(points: number[], dx: number, dy: number): number[] {
	return points.map((v, i) => (i % 3 === 2 ? v : v + (i % 2 === 0 ? dx : dy)));
}

/** perfect-freehand emits a closed outline; Konva needs an explicit closing
 *  segment or the ink renders as an open sliver. */
function inkPathLength(flat: number[]): number {
	let sum = 0;
	for (let i = 2; i + 1 < flat.length; i += 2) {
		sum += Math.hypot(flat[i] - flat[i - 2], flat[i + 1] - flat[i - 1]);
	}
	return sum;
}

export function SketchPad({
	initialImage = null,
	onDone,
	onClose,
}: {
	/** Image (data URL / remote URL) mounted as the editable base layer. */
	initialImage?: string | null;
	onDone(dataUrl: string): void;
	onClose(): void;
}): ReactNode {
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const stageRef = useRef<Konva.Stage | null>(null);
	const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
	const [tool, setTool] = useState<Tool>("pen");
	const [color, setColor] = useState(PALETTE[0]);
	const [size, setSize] = useState(4);
	const [strokes, setStrokes] = useState<Stroke[]>([]);
	const [past, setPast] = useState<Op[]>([]);
	const [future, setFuture] = useState<Op[]>([]);
	const [closing, setClosing] = useState(false);
	const drawRef = useRef<Stroke | null>(null);
	/** Eraser drag state: pointerdown on the eraser arms it, pointerup clears. */
	const erasingRef = useRef(false);
	const [preview, setPreview] = useState<Stroke | null>(null);
	const baseImage = useLoadedImage(initialImage);
	const idRef = useRef(1);
	const [dirty, setDirty] = useState(false);
	/** 浅色底导出 (user request): dark-theme sketches export on white so
	 *  shared/sent images stay readable outside the app. */
	const [lightExport, setLightExport] = useState(false);
	const [forceWhite, setForceWhite] = useState(false);
	/** Select tool: the picked stroke renders a dashed frame, drag moves it. */
	const [selectedId, setSelectedId] = useState<number | null>(null);
	const moveRef = useRef<{ id: number; from: number[]; start: { x: number; y: number } } | null>(null);
	const { confirm } = useConfirm();

	// Track the overlay's available box; the stage fills it.
	useEffect(() => {
		const el = wrapRef.current;
		if (!el) return;
		const measure = (): void => setStageSize({ w: el.clientWidth, h: el.clientHeight });
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const commit = useCallback((stroke: Stroke): void => {
		setStrokes(prev => [...prev, stroke]);
		setPast(prev => [...prev.slice(-99), { kind: "add", stroke }]);
		setFuture([]);
		setDirty(true);
	}, []);

	const dropStroke = useCallback((id: number): void => {
		setStrokes(prev => {
			const victim = prev.find(s => s.id === id);
			if (!victim) return prev;
			setPast(p => [...p.slice(-99), { kind: "clear", strokes: [victim] }]);
			setFuture([]);
			return prev.filter(s => s.id !== id);
		});
	}, []);

	const commitMove = useCallback((id: number, from: number[], to: number[]): void => {
		setStrokes(prev => prev.map(s => (s.id === id ? { ...s, points: to } : s)));
		setPast(prev => [...prev.slice(-99), { kind: "move", id, from, to }]);
		setFuture([]);
		setDirty(true);
	}, []);

	const undo = useCallback((): void => {
		const op = past[past.length - 1];
		if (!op) return;
		setPast(prev => prev.slice(0, -1));
		if (op.kind === "add") {
			setStrokes(s => s.filter(x => x.id !== op.stroke.id));
		} else if (op.kind === "move") {
			setStrokes(s => s.map(x => (x.id === op.id ? { ...x, points: op.from } : x)));
		} else {
			setStrokes(op.strokes);
		}
		setFuture(f => [...f, op]);
	}, [past]);

	const redo = useCallback((): void => {
		const op = future[future.length - 1];
		if (!op) return;
		setFuture(prev => prev.slice(0, -1));
		if (op.kind === "add") {
			setStrokes(s => [...s, op.stroke]);
			setPast(p => [...p, op]);
		} else if (op.kind === "move") {
			setStrokes(s => s.map(x => (x.id === op.id ? { ...x, points: op.to } : x)));
			setPast(p => [...p, op]);
		} else {
			setPast(p => [...p, { kind: "clear", strokes: op.strokes }]);
			setStrokes([]);
		}
	}, [future]);

	const clearAll = useCallback((): void => {
		setStrokes(prev => {
			if (prev.length === 0) return prev;
			setPast(p => [...p.slice(-99), { kind: "clear", strokes: prev }]);
			setFuture([]);
			return [];
		});
	}, []);

	const requestClose = useCallback((): void => {
		if (!dirty) {
			onClose();
			return;
		}
		void confirm(t("sketch discard title"), t("discard")).then(ok => {
			if (ok) onClose();
		});
	}, [dirty, confirm, onClose]);

	// Escape closes (with the discard guard); Ctrl/Cmd+Z undo, +Shift redo.
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") {
				e.preventDefault();
				requestClose();
			} else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
				e.preventDefault();
				if (e.shiftKey) redo();
				else undo();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [requestClose, undo, redo]);

	const onPointerDown = useCallback(
		(e: Konva.KonvaEventObject<PointerEvent>): void => {
			const stage = stageRef.current;
			const pos = stage?.getPointerPosition();
			if (!stage || !pos) return;
			if (tool === "select") {
				const hit = stage.getIntersection(pos);
				const id = Number(hit?.name() === "sk-stroke" ? hit.id() : NaN);
				if (Number.isNaN(id)) {
					setSelectedId(null);
					return;
				}
				setSelectedId(id);
				const victim = strokes.find(s => s.id === id);
				if (victim) {
					moveRef.current = { id, from: victim.points, start: pos };
				}
				return;
			}
			if (tool === "eraser") {
				erasingRef.current = true;
				const hit = stage.getIntersection(pos);
				const id = Number(hit?.name() === "sk-stroke" ? hit.id() : NaN);
				if (!Number.isNaN(id)) dropStroke(id);
				return;
			}
			const pressure = e.evt.pressure > 0 ? e.evt.pressure : 0.5;
			const stroke: Stroke = {
				id: idRef.current++,
				tool,
				color,
				size,
				points: tool === "pen" ? [pos.x, pos.y, pressure] : [pos.x, pos.y, pos.x, pos.y],
			};
			drawRef.current = stroke;
			setPreview(stroke);
		},
		[tool, color, size, dropStroke, strokes],
	);

	const onPointerMove = useCallback(
		(e: Konva.KonvaEventObject<PointerEvent>): void => {
			const draw = drawRef.current;
			const stage = stageRef.current;
			if (!stage) return;
			const pos = stage.getPointerPosition();
			if (!pos) return;
			if (tool === "select") {
				const mv = moveRef.current;
				if (!mv) return;
				setStrokes(prev =>
					prev.map(s =>
						s.id === mv.id ? { ...s, points: shiftPoints(mv.from, pos.x - mv.start.x, pos.y - mv.start.y) } : s,
					),
				);
				return;
			}
			if (tool === "eraser") {
				// Drag-erase (while the pointer is down — onPointerDown gated
				// the start): sweep-delete every stroke the pointer crosses.
				if (!erasingRef.current) return;
				const hit = stage.getIntersection(pos);
				const id = Number(hit?.name() === "sk-stroke" ? hit.id() : NaN);
				if (!Number.isNaN(id)) dropStroke(id);
				return;
			}
			if (!draw) return;
			if (draw.tool === "pen") {
				draw.points.push(pos.x, pos.y, 0.5);
				setPreview({ ...draw, points: [...draw.points] });
				return;
			}
			setPreview({ ...draw, points: [draw.points[0], draw.points[1], pos.x, pos.y] });
		},
		[tool, dropStroke],
	);

	const onPointerUp = useCallback((): void => {
		erasingRef.current = false;
		const mv = moveRef.current;
		if (mv) {
			moveRef.current = null;
			const after = strokes.find(s => s.id === mv.id)?.points;
			if (after && after !== mv.from) commitMove(mv.id, mv.from, after);
			return;
		}
		const draw = drawRef.current;
		drawRef.current = null;
		if (!draw) return;
		setPreview(null);
		// A tap with the pen (no movement) still commits — a dot is content.
		if (draw.tool === "pen" && draw.points.length < 6) return;
		commit(draw);
	}, [commit, strokes, commitMove]);

	const finish = (): void => {
		const stage = stageRef.current;
		if (!stage) return;
		setClosing(true);
		// 180ms: let the scale-out read as "falling back into the composer",
		// then hand the PNG over (the composer adds the chip as the veil
		// unmounts — the two halves of the Codex zoom animation).
		void (async () => {
			if (lightExport && bg !== "#ffffff") {
				// Light-background export: paint the canvas rect white for the
				// snapshot, wait a frame for React to apply it, then restore.
				setForceWhite(true);
				await new Promise(resolve => setTimeout(resolve, 80));
				const url = stage.toDataURL({ pixelRatio: 2 });
				setForceWhite(false);
				onDone(url);
				return;
			}
			onDone(stage.toDataURL({ pixelRatio: 2 }));
		})();
	};

	const renderStroke = (s: Stroke, isPreview = false): ReactNode => {
		const common = {
			key: isPreview ? "sk-preview" : s.id,
			...(isPreview ? {} : { id: String(s.id), name: "sk-stroke" as const }),
			perfectDrawEnabled: false,
			// Thin pen ink (size 2 → outline 4.4px) is a miserable click
			// target; widen the hit region without touching the rendering.
			hitStrokeWidth: Math.max(14, s.size * 2.5),
		};
		if (s.tool === "pen") {
			const outline = inkOutline(s.points, s.size);
			return (
				<Line
					{...common}
					points={outline}
					closed
					fill={s.color}
					lineJoin="round"
					lineCap="round"
					pathLength={inkPathLength(outline)}
					opacity={isPreview ? 0.92 : 1}
				/>
			);
		}
		const [x0, y0, x1, y1] = s.points;
		if (s.tool === "line" || s.tool === "arrow") {
			return s.tool === "line" ? (
				<Line {...common} points={[x0, y0, x1, y1]} stroke={s.color} strokeWidth={s.size} lineCap="round" />
			) : (
				<Arrow
					{...common}
					points={[x0, y0, x1, y1]}
					stroke={s.color}
					fill={s.color}
					strokeWidth={s.size}
					lineCap="round"
					pointerLength={s.size * 3}
					pointerWidth={s.size * 3}
				/>
			);
		}
		if (s.tool === "rect") {
			return (
				<Rect
					{...common}
					x={Math.min(x0, x1)}
					y={Math.min(y0, y1)}
					width={Math.abs(x1 - x0)}
					height={Math.abs(y1 - y0)}
					stroke={s.color}
					strokeWidth={s.size}
					cornerRadius={Math.min(6, Math.abs(x1 - x0) / 4)}
				/>
			);
		}
		return (
			<Ellipse
				{...common}
				x={(x0 + x1) / 2}
				y={(y0 + y1) / 2}
				radiusX={Math.abs(x1 - x0) / 2}
				radiusY={Math.abs(y1 - y0) / 2}
				stroke={s.color}
				strokeWidth={s.size}
			/>
		);
	};

	const bg = themeCanvasColor();
	const canUndo = past.length > 0;
	const canRedo = future.length > 0;
	const selected = selectedId === null ? undefined : strokes.find(s => s.id === selectedId);
	const box = selected ? strokeBox(selected) : null;

	return (
		<div className={`gui-sketch-veil${closing ? " gui-sketch-veil--closing" : ""}`} role="dialog" aria-modal="true">
			<div className="gui-sketch-board">
				<div className="gui-sketch-toolbar">
					<button type="button" className="gui-btn gui-btn-icon" title={t("close")} onClick={requestClose}>
						<X size={14} />
					</button>
					<span className="gui-sketch-toolbar-sep" aria-hidden />
					{TOOL_ITEMS.map(([key, IconCmp, labelKey]) => (
						<button
							type="button"
							key={key}
							className={`gui-sketch-tool${tool === key ? " gui-sketch-tool--on" : ""}`}
							title={t(labelKey)}
							aria-label={t(labelKey)}
							aria-pressed={tool === key}
							onClick={() => {
								setTool(key);
								if (key !== "select") setSelectedId(null);
							}}
						>
							<IconCmp size={14} />
						</button>
					))}
					<span className="gui-sketch-toolbar-sep" aria-hidden />
					<button
						type="button"
						className="gui-sketch-tool"
						title={t("sketch undo")}
						aria-label={t("sketch undo")}
						disabled={!canUndo}
						onClick={undo}
					>
						<Undo2 size={14} />
					</button>
					<button
						type="button"
						className="gui-sketch-tool"
						title={t("sketch redo")}
						aria-label={t("sketch redo")}
						disabled={!canRedo}
						onClick={redo}
					>
						<Redo2 size={14} />
					</button>
					<button
						type="button"
						className="gui-sketch-tool"
						title={t("sketch clear")}
						aria-label={t("sketch clear")}
						disabled={strokes.length === 0}
						onClick={clearAll}
					>
						<Trash2 size={14} />
					</button>
				</div>
				<div ref={wrapRef} className="gui-sketch-canvas">
					{stageSize.w > 0 && (
						<Stage
							ref={stageRef}
							width={stageSize.w}
							height={stageSize.h}
							onPointerDown={onPointerDown}
							onPointerMove={onPointerMove}
							onPointerUp={onPointerUp}
							onPointerLeave={onPointerUp}
							style={{
								cursor: tool === "eraser" ? "cell" : tool === "select" ? "default" : "crosshair",
								touchAction: "none",
							}}
						>
							<Layer listening={false}>
								<Rect x={0} y={0} width={stageSize.w} height={stageSize.h} fill={forceWhite ? "#ffffff" : bg} />
								{baseImage && (
									<KonvaImage {...fitImage(baseImage, stageSize.w, stageSize.h)} image={baseImage} />
								)}
							</Layer>
							<Layer>
								{strokes.map(s => renderStroke(s))}
								{preview && renderStroke(preview, true)}
							</Layer>
							<Layer listening={false}>
								{box && (
									<Rect
										x={box.x}
										y={box.y}
										width={box.w}
										height={box.h}
										stroke="var(--accent)"
										strokeWidth={1.5}
										dash={[6, 4]}
										cornerRadius={4}
										perfectDrawEnabled={false}
									/>
								)}
							</Layer>
						</Stage>
					)}
				</div>
				<div className="gui-sketch-palette">
					{PALETTE.map(c => (
						<button
							type="button"
							key={c}
							className={`gui-sketch-color${color === c ? " gui-sketch-color--on" : ""}`}
							style={{ background: c }}
							aria-label={c}
							onClick={() => {
								setColor(c);
								if (tool === "eraser") setTool("pen");
							}}
						/>
					))}
					<span className="gui-sketch-toolbar-sep" aria-hidden />
					{SIZES.map(s => (
						<button
							type="button"
							key={s}
							className={`gui-sketch-size${size === s ? " gui-sketch-size--on" : ""}`}
							title={`${s}px`}
							onClick={() => setSize(s)}
						>
							<span style={{ width: 4 + s, height: 4 + s }} />
						</button>
					))}
					<span className="gui-sketch-spacer" />
					<button
						type="button"
						className="gui-sketch-done"
						title={t("sketch done")}
						aria-label={t("sketch done")}
						onClick={finish}
					>
						<Check size={16} />
					</button>
				</div>
			</div>
		</div>
	);
}
