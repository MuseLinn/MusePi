import { t } from "@musepi/client-core";
import type Konva from "konva";
import {
	ArrowUpRight,
	Check,
	Circle,
	Diamond,
	Eraser,
	Heart,
	Minus,
	MousePointer2,
	Pencil,
	Redo2,
	Shapes,
	Slash,
	Square,
	Star,
	Trash2,
	Triangle,
	Type,
	Undo2,
	X,
} from "lucide-react";
import { getStroke } from "perfect-freehand";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Arrow, Ellipse, Image as KonvaImage, Layer, Line, Rect, Stage, Text } from "react-konva";
import { useConfirm } from "../lib/prompt-dialog";
import {
	acceptsShapeDrag,
	caretWrapWidth,
	MIN_DRAG,
	measureTextWidth,
	outlinePoints,
	type ShapeTool,
	scalePoints,
	shiftPoints,
	strokeBox,
	strokeExtent,
	TEXT_DEFAULT_W,
	TEXT_FONT_STACK,
	type Tool,
	textAutoBox,
	textFontSize,
} from "../lib/sketch-geometry";
import {
	nextStrokeId,
	type SketchScene,
	type SketchStroke,
	sceneStrokesFor,
	serializeScene,
} from "../lib/sketch-scene";

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
 * Codex-parity pass (2026-09-19): text tool, the full shape flyout
 * (line/arrow/rect/ellipse/diamond/triangle/star/heart), a 10-swatch
 * palette, a continuous thickness slider, and the app-wide liquid-glass +
 * spring motion on the board chrome. All shape maths lives in
 * lib/sketch-geometry.ts so it can be unit-tested without a canvas.
 *
 * Flow: draw → 完成 exports a PNG (pixelRatio 2, canvas background
 * included) through the composer's normal image attachment pipeline — and
 * hands the stroke list over as a scene (lib/sketch-scene.ts), which the
 * chip keeps beside its pixels. Clicking a board-drawn chip therefore
 * restores A0 (every object still selectable / movable / erasable) instead
 * of pasting A1's PNG back as one flat picture you can only paint over;
 * 完成 then swaps the chip's pixels AND its scene, so the round trip
 * survives any number of re-edits. A chip without a scene (a restored
 * draft, a plain image from the lightbox) still mounts its PNG as the base
 * layer. Closing plays the same scale-out as completing, so the board
 * reads as "falling back" into the composer (Codex's zoom-away,
 * simplified to a 180ms transform toward the composer row).
 */

/** Undo/redo ops: single-stroke adds, batch clears, and moves all keep the
 *  stacks small. A move records `from`/`to` deltas so undo is exact. */
type Op =
	| { kind: "add"; stroke: SketchStroke }
	| { kind: "clear"; strokes: SketchStroke[] }
	| { kind: "move"; id: number; from: number[]; to: number[] }
	| { kind: "edit"; id: number; from: string; to: string };

/** Codex's swatch row: ink, greys, then a warm→cool wheel. The first entry
 *  is the default so the board opens on the theme's ink colour. */
const PALETTE = [
	"#1f2328",
	"#6b7280",
	"#a1a1aa",
	"#e5484d",
	"#a3521c",
	"#f76b15",
	"#ffb224",
	"#46a758",
	"#00a2c7",
	"#3e63dd",
	"#8e4ec6",
	"#e93d82",
];

/** Thickness ladder bounds. The slider is continuous between them (Codex's
 *  left-edge knob) — the old four discrete buttons are gone, but the numbers
 *  still clamp to a sane ink range. */
const MIN_SIZE = 1;
const MAX_SIZE = 24;

/** Tools sharing the flyout; the first entry is the always-visible button. */
const SHAPE_ITEMS = [
	["line", Slash, "sketch tool line"],
	["arrow", ArrowUpRight, "sketch tool arrow"],
	["rect", Square, "sketch tool rect"],
	["ellipse", Circle, "sketch tool ellipse"],
	["diamond", Diamond, "sketch tool diamond"],
	["triangle", Triangle, "sketch tool triangle"],
	["star", Star, "sketch tool star"],
	["heart", Heart, "sketch tool heart"],
] as const satisfies ReadonlyArray<readonly [ShapeTool, unknown, string]>;

const SHAPE_TOOLS = SHAPE_ITEMS.map(item => item[0]) as readonly ShapeTool[];

const TOOL_ITEMS = [
	["select", MousePointer2, "sketch tool select"],
	["pen", Pencil, "sketch tool pen"],
	["eraser", Eraser, "sketch tool eraser"],
	["text", Type, "sketch tool text"],
] as const;

function themeCanvasColor(): string {
	if (typeof document === "undefined") return "#ffffff";
	const scheme = document.documentElement.dataset.colorScheme ?? document.documentElement.dataset.theme;
	return scheme === "dark" ? "#1c1d21" : "#ffffff";
}

/** Resolve the app accent to a concrete color value. Konva paints through
 *  the canvas 2D API, where `var(--accent)` is an invalid fillStyle that is
 *  silently dropped (the previous style sticks) — CSS variables never reach
 *  the canvas, so selection chrome must be resolved to a real value. */
function themeAccentColor(): string {
	if (typeof document === "undefined") return "#d9a441";
	const v = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
	return v || "#d9a441";
}

/** Default ink for a fresh board. The palette's first swatch is a dark ink
 *  meant for light ground; on the dark canvas it lands at ~1.04:1 contrast
 *  — strokes and typed labels go in invisible. Dark boards therefore open
 *  on the palette's light grey instead. */
function defaultInk(): string {
	return themeCanvasColor() === "#ffffff" ? PALETTE[0] : "#a1a1aa";
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
	initialScene = null,
	onDone,
	onClose,
}: {
	/** Image (data URL / remote URL) mounted as the editable base layer.
	 *  Ignored when `initialScene` is set — a scene already carries the
	 *  objects, and importing the chip's own PNG on top would paste the
	 *  exported picture (with its baked background) over the live drawing. */
	initialImage?: string | null;
	/** Saved board to reopen (from a board-drawn chip). Restored as live
	 *  strokes, so every object stays individually editable. */
	initialScene?: SketchScene | null;
	/** `scene` is the editable snapshot: the composer stores it on the chip so
	 *  the next click reopens these very strokes instead of the PNG. */
	onDone(dataUrl: string, scene: SketchScene): void;
	onClose(): void;
}): ReactNode {
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const stageRef = useRef<Konva.Stage | null>(null);
	const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
	const [tool, setTool] = useState<Tool>("pen");
	const [color, setColor] = useState(defaultInk);
	const [size, setSize] = useState(4);
	const [strokes, setStrokes] = useState<SketchStroke[]>([]);
	const [past, setPast] = useState<Op[]>([]);
	const [future, setFuture] = useState<Op[]>([]);
	const [closing, setClosing] = useState(false);
	const drawRef = useRef<SketchStroke | null>(null);
	/** Eraser drag state: pointerdown on the eraser arms it, pointerup clears. */
	const erasingRef = useRef(false);
	const [preview, setPreview] = useState<SketchStroke | null>(null);
	const baseImage = useLoadedImage(initialImage);
	/** Konva paints a decoded HTMLImageElement, so image strokes keep a small
	 *  cache keyed by src: the stroke itself stores only the URL, which is
	 *  what makes undo/redo and the op stack cheap. */
	const [imageCache, setImageCache] = useState<Record<string, HTMLImageElement>>({});
	const idRef = useRef(1);
	const [dirty, setDirty] = useState(false);
	/** 浅色底导出 (user request): dark-theme sketches export on white so
	 *  shared/sent images stay readable outside the app. */
	const [lightExport, setLightExport] = useState(false);
	/** Non-null while a snapshot is in flight: the live board stays
	 *  transparent (it reads as the same glass as the chrome around it),
	 *  so every export paints its background on just for the shot. */
	const [exportBg, setExportBg] = useState<string | null>(null);
	/** Select tool: the picked stroke renders a dashed frame, drag moves it. */
	const [selectedId, setSelectedId] = useState<number | null>(null);
	/** Drag-translation state; `tool` rides along because the geometry
	 *  helpers stride by tool. */
	const moveRef = useRef<{
		id: number;
		tool: SketchStroke["tool"];
		from: number[];
		start: { x: number; y: number };
	} | null>(null);
	/** Scale drag state: a corner handle grabbed at (sx,sy), scaling `from`
	 *  about the fixed anchor (ax,ay). Committed through the same move op as
	 *  translation, so undo/redo need no new branch. */
	const scaleRef = useRef<{
		id: number;
		tool: SketchStroke["tool"];
		from: number[];
		ax: number;
		ay: number;
		sx: number;
		sy: number;
	} | null>(null);
	/** Text tool: where a tap planted the caret, how wide the box is, and the
	 *  label being typed. `null` means nothing is being edited, so no overlay
	 *  is mounted. `w` is the wrap width — the overlay grows downward as the
	 *  text wraps, and the committed stroke inherits the resulting box.
	 *  `pinned` marks `w` as a width the USER chose (a re-edit of an existing
	 *  label, or a corner-handle drag) rather than the generous default a new
	 *  caret is born with: a pinned width survives the commit, an unpinned one
	 *  auto-fits so two characters are not left in a 200px frame. */
	const [textEditor, setTextEditor] = useState<{
		x: number;
		y: number;
		w: number;
		id: number | null;
		pinned: boolean;
	} | null>(null);
	/** A text tap parked at pointerdown, planted at pointerup. See the note in
	 *  `onPointerDown`: mounting the caret inside pointerdown lets the
	 *  browser's own mousedown default action (focus the clicked element, or
	 *  blur the current focus when it isn't focusable — a canvas never is)
	 *  take the focus straight back, so the caret blurs and its empty draft
	 *  is discarded before the user can type a character. */
	const pendingTextRef = useRef<{ x: number; y: number } | null>(null);
	const [textDraft, setTextDraft] = useState("");
	const [flyout, setFlyout] = useState(false);
	const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
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

	// Focus follows the caret into the canvas: mounting the textarea is the
	// same gesture as placing the cursor, and re-mounting for an existing
	// label has to select it so typing replaces rather than appends.
	// The focus is deferred by a frame — a synchronous focus() here can still
	// be undone by the click's own default focus handling, which runs after
	// the pointerdown/mousedown handlers have returned.
	useEffect(() => {
		const el = textAreaRef.current;
		if (!el) return;
		const raf = requestAnimationFrame(() => {
			el.focus();
			el.setSelectionRange(el.value.length, el.value.length);
		});
		return () => cancelAnimationFrame(raf);
	}, [textEditor]);

	// A click anywhere outside the flyout dismisses it — the flyout is a
	// second-level menu, and leaving it armed while the user draws would make
	// the rail read as stuck.
	useEffect(() => {
		if (!flyout) return;
		const onDown = (e: MouseEvent): void => {
			const el = e.target instanceof HTMLElement ? e.target : null;
			if (el?.closest(".gui-sketch-flyout, .gui-sketch-shapes")) return;
			setFlyout(false);
		};
		window.addEventListener("pointerdown", onDown);
		return () => window.removeEventListener("pointerdown", onDown);
	}, [flyout]);

	const commit = useCallback((stroke: SketchStroke): void => {
		setStrokes(prev => [...prev, stroke]);
		setPast(prev => [...prev.slice(-99), { kind: "add", stroke }]);
		setFuture([]);
		setDirty(true);
	}, []);

	/** Decode every image stroke's src once, so Konva has a node to paint. */
	useEffect(() => {
		for (const s of strokes) {
			if (s.tool !== "image" || !s.src || imageCache[s.src]) continue;
			const el = new Image();
			el.onload = () => setImageCache(prev => ({ ...prev, [s.src as string]: el }));
			el.src = s.src;
		}
	}, [strokes, imageCache]);

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

	/** Text edits are a first-class op so Ctrl+Z walks back through retypes,
	 *  not just placements — otherwise the only way to undo a changed label
	 *  would be to delete the whole stroke. */
	const commitTextEdit = useCallback((id: number, from: string, to: string): void => {
		if (from === to) return;
		setStrokes(prev => prev.map(s => (s.id === id ? { ...s, text: to } : s)));
		setPast(prev => [...prev.slice(-99), { kind: "edit", id, from, to }]);
		setFuture([]);
		setDirty(true);
	}, []);

	/** The imported picture becomes a stroke rather than a background bitmap:
	 *  it rides in `strokes` like any drawn object, which is the only way the
	 *  eraser, the clear button, undo and the select tool's scale handles can
	 *  all reach it. It lands in `past` as an add op, so the first Ctrl+Z on a
	 *  re-opened board takes the picture back off — before this, a board
	 *  opened from an attachment showed content that no control could touch.
	 *  Runs once, when the image has decoded and the stage has a box to fit it
	 *  into. */
	const importedRef = useRef(false);
	useEffect(() => {
		const src = initialImage;
		// A scene already carries this board's objects; importing the chip's
		// own PNG alongside it would paste the exported picture (background
		// baked in) on top of the live drawing.
		if (!src || initialScene || !baseImage || stageSize.w === 0 || importedRef.current) return;
		importedRef.current = true;
		const box = fitImage(baseImage, stageSize.w, stageSize.h);
		const stroke: SketchStroke = {
			id: idRef.current++,
			tool: "image",
			color,
			size,
			points: [box.x, box.y, box.width, box.height],
			src,
		};
		// Importing is not an edit, so `dirty` stays false — but the op is
		// recorded, which is what makes the picture undoable.
		setStrokes(prev => [...prev, stroke]);
		setPast(prev => [...prev.slice(-99), { kind: "add", stroke }]);
	}, [initialImage, initialScene, baseImage, stageSize, color, size]);

	/** Reopening a board-drawn chip restores the SAVED STROKES, not the
	 *  exported PNG: mounting the PNG made every object fuse into one bitmap,
	 *  so a re-edit could only paint over the picture — the original ink, and
	 *  with it any chance of fixing one local detail, was gone. Restoring the
	 *  scene brings each pen stroke, shape and label back as its own node
	 *  (selectable, movable, scalable, erasable).
	 *
	 *  No op is recorded and `dirty` stays false: this is the board's opening
	 *  content, not something the user just did, so Ctrl+Z must not take it
	 *  away and closing an untouched board must not prompt. */
	const restoredRef = useRef(false);
	useEffect(() => {
		if (!initialScene || stageSize.w === 0 || restoredRef.current) return;
		restoredRef.current = true;
		const restored = sceneStrokesFor(initialScene, stageSize.w, stageSize.h);
		setStrokes(restored);
		// Ids continue past the restored set: two nodes sharing an id would
		// make the eraser and the select tool hit the wrong object.
		idRef.current = nextStrokeId(restored);
	}, [initialScene, stageSize]);

	/** Mirror of `strokes` for the snapshot path: `finish` exports inside an
	 *  async gap (and may land a pending text label first), so reading the
	 *  `strokes` of that render would serialize the board as it was BEFORE
	 *  the last commit — the PNG and the saved scene would disagree. */
	const strokesRef = useRef<SketchStroke[]>([]);
	useEffect(() => {
		strokesRef.current = strokes;
	}, [strokes]);

	const undo = useCallback((): void => {
		const op = past[past.length - 1];
		if (!op) return;
		setPast(prev => prev.slice(0, -1));
		if (op.kind === "add") {
			setStrokes(s => s.filter(x => x.id !== op.stroke.id));
		} else if (op.kind === "move") {
			setStrokes(s => s.map(x => (x.id === op.id ? { ...x, points: op.from } : x)));
		} else if (op.kind === "edit") {
			setStrokes(s => s.map(x => (x.id === op.id ? { ...x, text: op.from } : x)));
		} else {
			setStrokes(op.strokes);
		}
		setFuture(f => [...f, op]);
		// Undoing the imported picture (or anything else) leaves the board
		// different from what was handed over, so the discard guard stays on.
		setDirty(true);
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
		} else if (op.kind === "edit") {
			setStrokes(s => s.map(x => (x.id === op.id ? { ...x, text: op.to } : x)));
			setPast(p => [...p, op]);
		} else {
			setPast(p => [...p, { kind: "clear", strokes: op.strokes }]);
			setStrokes([]);
		}
		setDirty(true);
	}, [future]);

	const clearAll = useCallback((): void => {
		if (strokes.length === 0) return;
		setPast(p => [...p.slice(-99), { kind: "clear", strokes }]);
		setFuture([]);
		setStrokes([]);
		// An emptied board holds nothing worth a discard prompt.
		setDirty(false);
	}, [strokes]);

	/** Land whatever is in the caret, then close the overlay. Anything that
	 *  dismisses the editor (blur, Escape, switching tools) has to route
	 *  through here or typed text would silently vanish. */
	const closeTextEditor = useCallback((): void => {
		const ed = textEditor;
		const value = textDraft.trim();
		setTextEditor(null);
		setTextDraft("");
		if (!ed) return;
		// The box the user typed into IS the stroke's box: width is the wrap
		// width the caret was given (or the box a re-edit inherited), height is
		// however many lines the text wrapped to. Typing therefore extends the
		// box by itself, and a scale-handle drag just writes a new w/h here.
		// Measured with the real canvas metric — an estimate clips CJK labels.
		const fit = textAutoBox(size, value, caretWrapWidth(ed, value, size), measureTextWidth);
		if (ed.id === null) {
			if (!value) return;
			commit({
				id: idRef.current++,
				tool: "text",
				color,
				size,
				points: [ed.x, ed.y, fit.w, fit.h],
				text: value,
			});
			return;
		}
		setStrokes(prev => {
			const existing = prev.find(s => s.id === ed.id);
			if (!existing) return prev;
			const from = existing.text ?? "";
			if (from === value) return prev;
			// Nudged inside the updater so the recorded `from` is the value
			// actually on screen — reading it from `strokes` in the closure
			// could see a stale label after a fast retype.
			setPast(p => [...p.slice(-99), { kind: "edit", id: ed.id as number, from, to: value }]);
			setFuture([]);
			setDirty(true);
			if (!value) return prev.filter(s => s.id !== ed.id);
			return prev.map(s =>
				s.id === ed.id ? { ...s, text: value, points: [s.points[0], s.points[1], fit.w, fit.h] } : s,
			);
		});
	}, [textEditor, textDraft, color, size, commit]);

	const requestClose = useCallback((): void => {
		if (textEditor) {
			// Escape inside the caret dismisses the caret, not the whole board —
			// losing a board's worth of drawing to a typo would be hostile.
			closeTextEditor();
			return;
		}
		if (!dirty) {
			onClose();
			return;
		}
		void confirm(t("sketch discard title"), t("discard")).then(ok => {
			if (ok) onClose();
		});
	}, [dirty, confirm, onClose, textEditor, closeTextEditor]);

	// Escape closes (with the discard guard); Ctrl/Cmd+Z undo, +Shift redo.
	// Rebound whenever the editor state changes so the caret gets first claim
	// on Escape (see requestClose).
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
				// Corner handles sit on their own listening layer above the
				// strokes, so getIntersection already prefers them — this
				// branch just has to run before the stroke pick below.
				if (hit?.name() === "sk-handle" && selectedId !== null) {
					const victim = strokes.find(s => s.id === selectedId);
					// Text included on purpose: a label carries its own
					// rectangle now, so its corner handles scale exactly like a
					// shape's. Leaving the old `tool !== "text"` guard here is
					// what made the handles draw but do nothing — the hit fell
					// through with `scaleRef` unset, so the drag was a no-op.
					if (victim) {
						// The anchor is the corner opposite the grabbed handle,
						// taken from the stroke's own extent (not the padded
						// frame) so the content corner stays visually pinned
						// while the stroke scales.
						const ext = strokeExtent(victim);
						const corner = String(hit.getAttr("corner"));
						scaleRef.current = {
							id: victim.id,
							tool: victim.tool,
							from: [...victim.points],
							ax: corner.includes("w") ? ext.x + ext.w : ext.x,
							ay: corner.includes("n") ? ext.y + ext.h : ext.y,
							sx: pos.x,
							sy: pos.y,
						};
					}
					return;
				}
				const id = Number(hit?.name() === "sk-stroke" ? hit.id() : NaN);
				if (Number.isNaN(id)) {
					setSelectedId(null);
					if (textEditor) closeTextEditor();
					return;
				}
				// A text box behaves like every other object now that it carries
				// its own rectangle: a press selects and drags it. Reopening the
				// caret moved to the double-click path below (which is where the
				// old single-click handler's intent now lives).
				const victim = strokes.find(s => s.id === id);
				setSelectedId(id);
				if (victim) {
					moveRef.current = { id, tool: victim.tool, from: victim.points, start: pos };
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
			if (tool === "text") {
				// Park the tap instead of mounting the caret: the caret is
				// planted at pointerup, once the click's own focus handling
				// has run. Mounting it here made the textarea appear and blur
				// inside the same gesture, and an empty draft is discarded on
				// blur — the board looked as if the text tool were not wired
				// up at all. Cancelling the pointerdown also suppresses the
				// compatibility mouse events, which are what moved the focus.
				if (e.evt.cancelable) e.evt.preventDefault();
				// Planting the caret lands the previous label first, so rapid
				// tap-typing never drops a word.
				if (textEditor) {
					closeTextEditor();
					return;
				}
				pendingTextRef.current = { x: pos.x, y: pos.y };
				return;
			}
			const pressure = e.evt.pressure > 0 ? e.evt.pressure : 0.5;
			const stroke: SketchStroke = {
				id: idRef.current++,
				tool,
				color,
				size,
				points: tool === "pen" ? [pos.x, pos.y, pressure] : [pos.x, pos.y, pos.x, pos.y],
			};
			drawRef.current = stroke;
			setPreview(stroke);
		},
		[tool, color, size, dropStroke, strokes, selectedId, textEditor, closeTextEditor],
	);

	const onPointerMove = useCallback(
		(e: Konva.KonvaEventObject<PointerEvent>): void => {
			const draw = drawRef.current;
			const stage = stageRef.current;
			if (!stage) return;
			const pos = stage.getPointerPosition();
			if (!pos) return;
			if (tool === "select") {
				const sc = scaleRef.current;
				if (sc) {
					// Factor = pointer-to-anchor distance ratio. A grab that
					// started on top of the anchor (<2px away) would divide by
					// ~0, so it holds scale 1 until the pointer moves off.
					const d0 = Math.hypot(sc.sx - sc.ax, sc.sy - sc.ay);
					const factor = d0 < MIN_DRAG ? 1 : Math.hypot(pos.x - sc.ax, pos.y - sc.ay) / d0;
					setStrokes(prev =>
						prev.map(s =>
							s.id === sc.id ? { ...s, points: scalePoints(sc.tool, sc.from, sc.ax, sc.ay, factor) } : s,
						),
					);
					return;
				}
				const mv = moveRef.current;
				if (!mv) return;
				setStrokes(prev =>
					prev.map(s =>
						s.id === mv.id
							? { ...s, points: shiftPoints(mv.tool, mv.from, pos.x - mv.start.x, pos.y - mv.start.y) }
							: s,
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
			// Shapes must write the moving corner back onto the draft in place:
			// onPointerUp commits `drawRef.current`, not the preview copy. When
			// this only built a preview object, the committed shape kept its
			// pointerdown corner on both ends → zero width/height → a rect or
			// ellipse you watched during the drag vanished the moment you let
			// go. (Pen never hit this because it mutates `draw.points` above.)
			draw.points[2] = pos.x;
			draw.points[3] = pos.y;
			setPreview({ ...draw, points: [...draw.points] });
		},
		[tool, dropStroke],
	);

	const onPointerUp = useCallback((): void => {
		erasingRef.current = false;
		// A parked text tap becomes the caret now that the click's focus
		// handling is done — this is what makes a tap with the text tool
		// actually leave an editable box on the board.
		const pending = pendingTextRef.current;
		if (pending) {
			pendingTextRef.current = null;
			setTextEditor({ x: pending.x, y: pending.y, w: TEXT_DEFAULT_W, id: null, pinned: false });
			setTextDraft("");
			return;
		}
		const sc = scaleRef.current;
		if (sc) {
			scaleRef.current = null;
			const after = strokes.find(s => s.id === sc.id)?.points;
			if (after && after !== sc.from) commitMove(sc.id, sc.from, after);
			return;
		}
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
		// A tap with a shape tool draws nothing: committing it would leave an
		// invisible zero-size node that still eats undo steps and hit-tests.
		if (draw.tool !== "pen" && !acceptsShapeDrag(draw.tool as ShapeTool, draw.points)) return;
		commit(draw);
	}, [commit, strokes, commitMove]);

	/** Leaving the canvas finishes the gesture but must not plant a caret the
	 *  user never released inside the board. */
	const onPointerLeave = useCallback((): void => {
		pendingTextRef.current = null;
		onPointerUp();
	}, [onPointerUp]);

	/** Double-click opens a text box's caret. This is the ONLY way back into a
	 *  label for editing, because a single click now selects-and-drags it —
	 *  text gained a real rectangle, so it should behave like every other
	 *  object on the board. */
	const onDblClick = useCallback(
		(e: Konva.KonvaEventObject<MouseEvent>): void => {
			if (tool !== "select") return;
			const id = Number(e.target?.name?.() === "sk-stroke" ? e.target.id() : NaN);
			if (Number.isNaN(id)) return;
			const victim = strokes.find(s => s.id === id);
			if (victim?.tool !== "text") return;
			// A box the user had scaled stays the wrap width; the caret
			// inherits it as a PINNED width so retyping reflows inside the same
			// rectangle instead of collapsing back to the default.
			setSelectedId(id);
			setTextEditor({
				x: victim.points[0],
				y: victim.points[1],
				w: victim.points[2],
				id,
				pinned: true,
			});
			setTextDraft(victim.text ?? "");
		},
		[tool, strokes],
	);

	const finish = (): void => {
		const stage = stageRef.current;
		if (!stage) return;
		// A pending caret is content — land it before the snapshot, or the
		// export silently loses the label the user was mid-way through.
		if (textEditor) closeTextEditor();
		setClosing(true);
		// 180ms: let the scale-out read as "falling back into the composer",
		// then hand the PNG over (the composer adds the chip as the veil
		// unmounts — the two halves of the Codex zoom animation).
		void (async () => {
			// The live canvas is transparent (the board's glass shows
			// through, so the drawing surface and its chrome read as one
			// material instead of two slabs of different grey). Every
			// snapshot therefore paints its background on for the shot —
			// white under the light-export toggle, else the theme colour —
			// waits a frame for React to apply it, then restores.
			setExportBg(lightExport ? "#ffffff" : bg);
			await new Promise(resolve => setTimeout(resolve, 80));
			const url = stage.toDataURL({ pixelRatio: 2 });
			setExportBg(null);
			// The scene is read from the mirror, not from this closure: a
			// caret label landed moments ago only reaches `strokes` on the
			// next render, and a scene that missed it would silently reopen
			// the board without its text.
			onDone(url, serializeScene(strokesRef.current, stageSize.w, stageSize.h));
		})();
	};

	const renderStroke = useCallback(
		(s: SketchStroke, isPreview = false): ReactNode => {
			// The list key is set per-branch, never through `common`: React 19
			// treats a spread that carries `key` as an error-level warning.
			const nodeKey = isPreview ? "sk-preview" : s.id;
			const common = {
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
						key={nodeKey}
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
			if (s.tool === "image") {
				// Until the src decodes there is nothing to paint; the stroke
				// itself stays in the model, so it is already undoable/erasable.
				const img = s.src ? imageCache[s.src] : undefined;
				if (!img) return null;
				return (
					<KonvaImage
						key={nodeKey}
						{...common}
						image={img}
						x={s.points[0]}
						y={s.points[1]}
						width={s.points[2]}
						height={s.points[3]}
					/>
				);
			}
			if (s.tool === "text") {
				const label = s.text ?? "";
				return (
					<Text
						key={nodeKey}
						{...common}
						x={s.points[0]}
						y={s.points[1]}
						text={label}
						fontSize={textFontSize(s.size)}
						// Painted with the exact family `measureTextWidth`
						// measures with: a different stack would make the wrap
						// decision and the painted lines disagree.
						fontFamily={TEXT_FONT_STACK}
						fill={s.color}
						// The stored box drives the layout: `wrap="word"` keeps the
						// label inside its width and grows downward into the height,
						// which is what makes the box resizable and self-expanding.
						// `lineHeight` matches `textLineHeight` so the box the select
						// frame draws is the box Konva paints.
						width={s.points[2]}
						height={s.points[3]}
						wrap="word"
						lineHeight={1.25}
						perfectDrawEnabled={false}
					/>
				);
			}
			const [x0, y0, x1, y1] = s.points;
			if (s.tool === "line" || s.tool === "arrow") {
				return s.tool === "line" ? (
					<Line
						key={nodeKey}
						{...common}
						points={[x0, y0, x1, y1]}
						stroke={s.color}
						strokeWidth={s.size}
						lineCap="round"
					/>
				) : (
					<Arrow
						key={nodeKey}
						{...common}
						points={[x0, y0, x1, y1]}
						stroke={s.color}
						fill={s.color}
						strokeWidth={s.size}
						lineCap="round"
						pointerLength={Math.max(8, s.size * 3)}
						pointerWidth={Math.max(8, s.size * 3)}
					/>
				);
			}
			if (s.tool === "rect") {
				return (
					<Rect
						key={nodeKey}
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
			if (s.tool === "ellipse") {
				return (
					<Ellipse
						key={nodeKey}
						{...common}
						x={(x0 + x1) / 2}
						y={(y0 + y1) / 2}
						radiusX={Math.abs(x1 - x0) / 2}
						radiusY={Math.abs(y1 - y0) / 2}
						stroke={s.color}
						strokeWidth={s.size}
					/>
				);
			}
			// diamond / triangle / star / heart share one closed-polyline path.
			const pts = outlinePoints(s.tool as ShapeTool, s.points) ?? [];
			return (
				<Line
					key={nodeKey}
					{...common}
					points={pts}
					closed
					stroke={s.color}
					strokeWidth={s.size}
					lineJoin="round"
					lineCap="round"
				/>
			);
		},
		[imageCache],
	);

	const bg = themeCanvasColor();
	// Selection chrome paints on the canvas, where CSS vars don't resolve.
	const accent = themeAccentColor();
	const canUndo = past.length > 0;
	const canRedo = future.length > 0;
	const selected = selectedId === null ? undefined : strokes.find(s => s.id === selectedId);
	// Konva renders text itself, but the select frame lives in a separate
	// listener-less layer and needs the label's measured extent to draw around
	// it — that measurement comes from the same helper the Text node uses.
	//
	// While the caret is open the frame tracks the DRAFT, not the stroke: the
	// stroke still holds the pre-edit box, so without this the dashed frame
	// sits at the old size while you type and only snaps on commit.
	const box = useMemo(() => {
		if (textEditor) {
			// Same wrap width the commit will use (see `closeTextEditor`), so
			// the dashed frame tracks the label instead of snapping on commit.
			const fit = textAutoBox(
				size,
				textDraft.trim(),
				caretWrapWidth(textEditor, textDraft.trim(), size),
				measureTextWidth,
			);
			return { x: textEditor.x, y: textEditor.y, w: fit.w, h: fit.h };
		}
		return selected ? strokeBox(selected) : null;
	}, [selected, textEditor, textDraft, size]);
	const activeShape = SHAPE_TOOLS.includes(tool as ShapeTool) ? (tool as ShapeTool) : null;
	const activeShapeItem = SHAPE_ITEMS.find(item => item[0] === activeShape);
	const ActiveShapeIcon = activeShapeItem ? activeShapeItem[1] : Shapes;
	const drawing = tool !== "select" && tool !== "eraser" && tool !== "text";

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
								if (textEditor) closeTextEditor();
								pendingTextRef.current = null;
								setTool(key);
								if (key !== "select") setSelectedId(null);
							}}
						>
							<IconCmp size={14} />
						</button>
					))}
					<span className="gui-sketch-toolbar-sep" aria-hidden />
					{/* Shape flyout: the rail shows the armed shape so the board
					 *  never hides which tool is live (a plain "Shapes" glyph
					 *  would make rect vs diamond indistinguishable). */}
					<div className="gui-sketch-shapes">
						<button
							type="button"
							className={`gui-sketch-tool${activeShape ? " gui-sketch-tool--on" : ""}`}
							title={t("sketch tool shapes")}
							aria-label={t("sketch tool shapes")}
							aria-expanded={flyout}
							aria-haspopup="menu"
							onClick={() => setFlyout(v => !v)}
						>
							<ActiveShapeIcon size={14} />
						</button>
						{flyout && (
							<div className="gui-sketch-flyout" role="menu">
								{SHAPE_ITEMS.map(([key, IconCmp, labelKey]) => (
									<button
										type="button"
										role="menuitemradio"
										aria-checked={tool === key}
										key={key}
										className={`gui-sketch-flyout-item${tool === key ? " gui-sketch-flyout-item--on" : ""}`}
										title={t(labelKey)}
										onClick={() => {
											if (textEditor) closeTextEditor();
											pendingTextRef.current = null;
											setTool(key);
											setSelectedId(null);
											setFlyout(false);
										}}
									>
										<IconCmp size={15} />
									</button>
								))}
							</div>
						)}
					</div>
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
						disabled={!strokes.length}
						onClick={clearAll}
					>
						<Trash2 size={14} />
					</button>
					<span className="gui-sketch-spacer" />
					<button
						type="button"
						className={`gui-sketch-tool${lightExport ? " gui-sketch-tool--on" : ""}`}
						title={t("sketch export light")}
						aria-label={t("sketch export light")}
						aria-pressed={lightExport}
						onClick={() => setLightExport(v => !v)}
					>
						<Circle size={14} />
					</button>
				</div>
				<div className="gui-sketch-body">
					{/* Thickness slider lives on the left edge (Codex's vertical rail).
					 *  Continuous — the old four-step ladder went 2/4/8/14 and could
					 *  not express the mid weights people actually reach for. */}
					<div className="gui-sketch-thickness">
						<input
							type="range"
							className="gui-sketch-range"
							min={MIN_SIZE}
							max={MAX_SIZE}
							step={1}
							value={size}
							aria-label={t("sketch thickness")}
							title={`${size}px`}
							onChange={e => setSize(Number(e.currentTarget.value))}
						/>
						<span className="gui-sketch-knob" style={{ width: 4 + size, height: 4 + size }} aria-hidden />
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
								onPointerLeave={onPointerLeave}
								onDblClick={onDblClick}
								style={{
									cursor: tool === "eraser" ? "cell" : tool === "select" ? "default" : "crosshair",
									touchAction: "none",
								}}
							>
								<Layer listening={false}>
									{exportBg && <Rect x={0} y={0} width={stageSize.w} height={stageSize.h} fill={exportBg} />}
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
											stroke={accent}
											strokeWidth={1.5}
											dash={[6, 4]}
											cornerRadius={4}
											perfectDrawEnabled={false}
										/>
									)}
								</Layer>
								{/* Scale handles live on their own listening layer: the
								 *  dashed frame's layer is listener-less by design, and a
								 *  node that cannot be hit cannot be dragged. Text boxes
								 *  carry a real rectangle, so they resize with the same
								 *  handles as everything else — dragging a corner sets the
								 *  wrap width and the label reflows inside it. */}
								<Layer>
									{box &&
										(
											[
												["nw", box.x, box.y],
												["ne", box.x + box.w, box.y],
												["sw", box.x, box.y + box.h],
												["se", box.x + box.w, box.y + box.h],
											] as const
										).map(([corner, hx, hy]) => (
											<Rect
												key={corner}
												name="sk-handle"
												corner={corner}
												x={hx - 4}
												y={hy - 4}
												width={8}
												height={8}
												fill="#ffffff"
												stroke={accent}
												strokeWidth={1}
												perfectDrawEnabled={false}
											/>
										))}
								</Layer>
							</Stage>
						)}
						{/* The caret is a real textarea so IME composition, selection
						 *  and paste all behave; it is positioned in canvas pixels and
						 *  only exists while something is being typed. */}
						{textEditor && (
							<textarea
								ref={textAreaRef}
								className="gui-sketch-text-input"
								value={textDraft}
								style={{
									left: textEditor.x,
									top: textEditor.y,
									// Grows with the text exactly as the committed label
									// does; `field-sizing: content` supplies the height.
									// Shares `caretWrapWidth` with the frame and the
									// commit, so the caret reflows where the label will.
									width: caretWrapWidth(textEditor, textDraft.trim(), size),
									color,
									fontSize: textFontSize(size),
								}}
								onChange={e => setTextDraft(e.currentTarget.value)}
								onPointerDown={e => e.stopPropagation()}
								onBlur={closeTextEditor}
								placeholder={t("sketch text placeholder")}
							/>
						)}
					</div>
				</div>
				<div className="gui-sketch-palette">
					{PALETTE.map(c => (
						<button
							type="button"
							key={c}
							className={`gui-sketch-color${color === c ? " gui-sketch-color--on" : ""}`}
							style={{ background: c }}
							title={t("sketch color")}
							aria-label={t("sketch color")}
							aria-pressed={color === c}
							onClick={() => {
								setColor(c);
								if (tool === "eraser") setTool("pen");
							}}
						/>
					))}
					{/* The ladder's ends are marked so the row reads as "ink →
					 *  weight" rather than as an unlabelled control. */}
					<span className="gui-sketch-thickness-inline">
						<Minus size={12} aria-hidden />
						<input
							type="range"
							className="gui-sketch-range gui-sketch-range--inline"
							min={MIN_SIZE}
							max={MAX_SIZE}
							step={1}
							value={size}
							aria-label={t("sketch thickness")}
							onChange={e => setSize(Number(e.currentTarget.value))}
						/>
					</span>
					<span className="gui-sketch-spacer" />
					<button
						type="button"
						className="gui-sketch-done"
						title={t("sketch done")}
						aria-label={t("sketch done")}
						disabled={!drawing && !strokes.length}
						onClick={finish}
					>
						<Check size={16} />
					</button>
				</div>
			</div>
		</div>
	);
}
