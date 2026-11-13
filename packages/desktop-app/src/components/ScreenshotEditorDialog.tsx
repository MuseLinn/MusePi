import { isTopModal, t, useModalFocus } from "@musepi/client-core";
import {
	ArrowUpRight,
	Check,
	Circle,
	Crop,
	Eraser,
	Grid2x2,
	Maximize,
	Pencil,
	Pipette,
	Redo2,
	Square,
	Trash2,
	Type,
	Undo2,
	X,
} from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { pushActionToast } from "../lib/action-toast";
import { copyToClipboard } from "../lib/electron";
import {
	buildMosaicPatch,
	clampRegion,
	drawShotStrokes,
	formatHex,
	formatRgba,
	hitStroke,
	isUsableRegion,
	normalizeRegion,
	type Point,
	type Region,
	type RgbaPixel,
	regionSize,
	type ShotStroke,
	type ShotTool,
} from "../lib/screenshot-editor-utils";
import { measureTextWidth, TEXT_FONT_STACK, wrapTextLines } from "../lib/sketch-geometry";

/**
 * System screenshot annotator — capture → markup → composer chip.
 *
 * Full-bleed rather than a `DialogFrame`: the shot is the page, so the chrome
 * is a transparent header plus one floating tool pill, exactly like SketchPad.
 * It owns the same focus/escape contract (`useModalFocus` + `isTopModal`)
 * because the inline text editor has to claim Escape before the overlay does.
 *
 * Coordinates are always original image pixels. The preview scale is display
 * only, and brush sizes are stored as `screen px / scale` so an annotation
 * looks identical on screen and in the full-resolution export.
 */

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

type Op =
	| { kind: "add"; stroke: ShotStroke }
	| { kind: "remove"; stroke: ShotStroke }
	| { kind: "clear"; strokes: ShotStroke[] };

const TOOL_ITEMS = [
	["crop", Crop, "composer.screenshotToolCrop"],
	["pen", Pencil, "composer.screenshotToolPen"],
	["arrow", ArrowUpRight, "composer.screenshotToolArrow"],
	["rect", Square, "composer.screenshotToolRect"],
	["ellipse", Circle, "composer.screenshotToolEllipse"],
	["text", Type, "composer.screenshotToolText"],
	["mosaic", Grid2x2, "composer.screenshotToolMosaic"],
	["eraser", Eraser, "composer.screenshotToolEraser"],
	["color", Pipette, "composer.screenshotToolColor"],
] as const;

const COLORS = [
	"#e5484d",
	"#f76b15",
	"#ffb224",
	"#46a758",
	"#00a2c7",
	"#3e63dd",
	"#8e4ec6",
	"#e93d82",
	"#1f2328",
	"#ffffff",
];

const MIN_SIZE = 2;
const MAX_SIZE = 14;
const TEXT_BOX_W = 180;
/** Space the floating pill needs at the bottom of the stage. */
const BAR_ROOM = 88;

function pixelAt(source: HTMLCanvasElement, x: number, y: number): RgbaPixel {
	const sx = Math.max(0, Math.min(source.width - 1, Math.round(x)));
	const sy = Math.max(0, Math.min(source.height - 1, Math.round(y)));
	const data = source.getContext("2d")!.getImageData(sx, sy, 1, 1).data;
	return { r: data[0]!, g: data[1]!, b: data[2]!, a: data[3]! };
}

function labelFont(size: number): number {
	return Math.max(12, Math.round(10 + size * 1.5));
}

function handlePoints(frame: Region, scale: number): Array<[Handle, number, number]> {
	const x0 = frame.x0 * scale;
	const y0 = frame.y0 * scale;
	const x1 = frame.x1 * scale;
	const y1 = frame.y1 * scale;
	const mx = (x0 + x1) / 2;
	const my = (y0 + y1) / 2;
	return [
		["nw", x0, y0],
		["n", mx, y0],
		["ne", x1, y0],
		["e", x1, my],
		["se", x1, y1],
		["s", mx, y1],
		["sw", x0, y1],
		["w", x0, my],
	];
}

function resizeFrame(from: Region, handle: Handle, point: Point, width: number, height: number): Region {
	const west = handle.includes("w");
	const east = handle.includes("e");
	const north = handle.includes("n");
	const south = handle.includes("s");
	const a: Point = {
		x: west ? point.x : from.x0,
		y: north ? point.y : from.y0,
	};
	const b: Point = {
		x: east ? point.x : from.x1,
		y: south ? point.y : from.y1,
	};
	return clampRegion(normalizeRegion(a, b), width, height);
}

export function ScreenshotEditorDialog({
	open,
	src,
	onConfirm,
	onCancel,
}: {
	open: boolean;
	src: string | null;
	onConfirm(dataUrl: string): void;
	onCancel(): void;
}) {
	const [img, setImg] = useState<HTMLImageElement | null>(null);
	const [source, setSource] = useState<HTMLCanvasElement | null>(null);
	const [stage, setStage] = useState({ width: 0, height: 0 });
	const [tool, setTool] = useState<ShotTool>("crop");
	const [color, setColor] = useState(COLORS[0]!);
	const [size, setSize] = useState(3);
	const [format, setFormat] = useState<"hex" | "rgba">("hex");
	const [cursor, setCursor] = useState<Point | null>(null);
	const [crop, setCrop] = useState<Region | null>(null);
	const [draftCrop, setDraftCrop] = useState<Region | null>(null);
	const [cropDrag, setCropDrag] = useState<{ handle: Handle; from: Region; region: Region } | null>(null);
	const [strokes, setStrokes] = useState<ShotStroke[]>([]);
	const [draft, setDraft] = useState<ShotStroke | null>(null);
	const [patches, setPatches] = useState<Record<number, HTMLCanvasElement>>({});
	const [past, setPast] = useState<Op[]>([]);
	const [future, setFuture] = useState<Op[]>([]);
	const [textEditor, setTextEditor] = useState<{ x: number; y: number; w: number } | null>(null);
	const [textDraft, setTextDraft] = useState("");
	const [status, setStatus] = useState<string | null>(null);
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [closing, setClosing] = useState(false);

	const veilRef = useModalFocus<HTMLDivElement>(open);
	const stageRef = useRef<HTMLDivElement | null>(null);
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const loupeRef = useRef<HTMLCanvasElement | null>(null);
	const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
	const idRef = useRef(1);
	const draftRef = useRef<ShotStroke | null>(null);
	const pendingTextRef = useRef<Point | null>(null);
	const erasingRef = useRef(false);
	const strokesRef = useRef<ShotStroke[]>([]);
	const editorRef = useRef<{ x: number; y: number; w: number } | null>(null);
	const cropAnchorRef = useRef<Point | null>(null);
	const closeTimerRef = useRef<Timer | null>(null);

	const scale =
		img && stage.width > 0
			? Math.max(
					0.02,
					Math.min(1, (stage.width - 56) / img.naturalWidth, (stage.height - BAR_ROOM - 32) / img.naturalHeight),
				)
			: 1;
	const viewWidth = img ? Math.max(1, Math.round(img.naturalWidth * scale)) : 0;
	const viewHeight = img ? Math.max(1, Math.round(img.naturalHeight * scale)) : 0;
	const value = (picker: "hex" | "rgba"): string | null => {
		if (!source || !cursor) return null;
		const pixel = pixelAt(source, cursor.x, cursor.y);
		return picker === "hex" ? formatHex(pixel) : formatRgba(pixel);
	};

	useEffect(() => {
		if (open) {
			setClosing(false);
			return;
		}
		setClosing(false);
		if (closeTimerRef.current !== null) {
			clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
	}, [open]);

	// Fresh capture: every piece of edit state belongs to the previous shot.
	useEffect(() => {
		setImg(null);
		setSource(null);
		setCrop(null);
		setDraftCrop(null);
		setCropDrag(null);
		setStrokes([]);
		strokesRef.current = [];
		editorRef.current = null;
		setPatches({});
		setPast([]);
		setFuture([]);
		setDraft(null);
		setCursor(null);
		setStatus(null);
		setTextEditor(null);
		setTextDraft("");
		setTool("crop");
		setPaletteOpen(false);
		idRef.current = 1;
		if (!src) return;
		const image = new Image();
		image.onload = () => {
			const width = image.naturalWidth;
			const height = image.naturalHeight;
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			canvas.getContext("2d")!.drawImage(image, 0, 0);
			setSource(canvas);
			setImg(image);
			setCrop({ x0: 0, y0: 0, x1: width, y1: height });
		};
		image.onerror = () => setStatus(t("composer.screenshotLoadFailed"));
		image.src = src;
		return () => {
			image.onload = null;
			image.onerror = null;
		};
	}, [src]);

	// The stage decides the preview scale, so it has to be measured, not
	// assumed: the overlay is viewport-sized and the shot is usually a
	// physical-pixel display capture (2–4× the CSS size it is shown at).
	useEffect(() => {
		const el = stageRef.current;
		if (!el) return;
		const measure = (): void => setStage({ width: el.clientWidth, height: el.clientHeight });
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, [open]);

	useEffect(() => {
		return () => {
			if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
		};
	}, []);

	// Focus the caret after the click's own focus handling has run; mounting
	// `focus()` inside pointerdown loses the caret to the canvas blur.
	useEffect(() => {
		const el = textAreaRef.current;
		if (!el) return;
		const raf = requestAnimationFrame(() => {
			el.focus();
			el.setSelectionRange(el.value.length, el.value.length);
		});
		return () => cancelAnimationFrame(raf);
	}, [textEditor]);

	useEffect(() => {
		if (!paletteOpen) return;
		const onDown = (event: PointerEvent): void => {
			const target = event.target instanceof Element ? event.target : null;
			if (target?.closest(".gui-shot-swatch, .gui-shot-palette")) return;
			setPaletteOpen(false);
		};
		window.addEventListener("pointerdown", onDown);
		return () => window.removeEventListener("pointerdown", onDown);
	}, [paletteOpen]);

	// Preview paint. The export calls the same drawShotStrokes with scale 1 and
	// the crop origin as offset, so what is on screen is what lands in the chip.
	useEffect(() => {
		const canvas = canvasRef.current;
		const image = img;
		if (!canvas || !image) return;
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		canvas.width = Math.max(1, Math.round(viewWidth * dpr));
		canvas.height = Math.max(1, Math.round(viewHeight * dpr));
		canvas.style.width = `${viewWidth}px`;
		canvas.style.height = `${viewHeight}px`;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, viewWidth, viewHeight);
		ctx.drawImage(image, 0, 0, viewWidth, viewHeight);

		const frame = draftCrop ?? cropDrag?.region ?? crop;
		if (frame) {
			const x0 = frame.x0 * scale;
			const y0 = frame.y0 * scale;
			const x1 = frame.x1 * scale;
			const y1 = frame.y1 * scale;
			ctx.save();
			ctx.fillStyle = "rgba(10, 10, 12, 0.52)";
			ctx.fillRect(0, 0, viewWidth, Math.max(0, y0));
			ctx.fillRect(0, y1, viewWidth, Math.max(0, viewHeight - y1));
			ctx.fillRect(0, y0, Math.max(0, x0), Math.max(0, y1 - y0));
			ctx.fillRect(x1, y0, Math.max(0, viewWidth - x1), Math.max(0, y1 - y0));
			ctx.restore();

			ctx.save();
			ctx.beginPath();
			ctx.rect(x0, y0, x1 - x0, y1 - y0);
			ctx.clip();
			drawShotStrokes(ctx, strokes, {
				scale,
				mosaic: stroke => patches[stroke.id] ?? null,
			});
			if (draft) drawShotStrokes(ctx, [draft], { scale, mosaic: stroke => patches[stroke.id] ?? null });
			ctx.restore();

			ctx.save();
			ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
			ctx.lineWidth = 3;
			ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
			ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
			ctx.lineWidth = 1.5;
			ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
			if (tool === "crop") {
				for (const [, hx, hy] of handlePoints(frame, scale)) {
					ctx.fillStyle = "#ffffff";
					ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
					ctx.lineWidth = 1;
					ctx.beginPath();
					ctx.rect(Math.round(hx) - 4, Math.round(hy) - 4, 8, 8);
					ctx.fill();
					ctx.stroke();
				}
			}
			ctx.restore();
		} else {
			drawShotStrokes(ctx, strokes, { scale, mosaic: stroke => patches[stroke.id] ?? null });
			if (draft) drawShotStrokes(ctx, [draft], { scale, mosaic: stroke => patches[stroke.id] ?? null });
		}
	}, [img, viewWidth, viewHeight, scale, crop, draftCrop, cropDrag, strokes, draft, patches, tool]);

	useEffect(() => {
		const canvas = loupeRef.current;
		if (!canvas || !source || !cursor) return;
		const sample = 11;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		ctx.imageSmoothingEnabled = false;
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		const sx = Math.max(0, Math.min(source.width - sample, Math.round(cursor.x) - Math.floor(sample / 2)));
		const sy = Math.max(0, Math.min(source.height - sample, Math.round(cursor.y) - Math.floor(sample / 2)));
		ctx.drawImage(source, sx, sy, sample, sample, 0, 0, canvas.width, canvas.height);
		const cell = canvas.width / sample;
		// A flat-colour sample would otherwise show an empty square; the grid
		// is what makes the card read as a magnifier at a glance.
		ctx.strokeStyle = "rgba(0, 0, 0, 0.14)";
		ctx.lineWidth = 1;
		for (let index = 1; index < sample; index++) {
			const line = index * cell;
			ctx.beginPath();
			ctx.moveTo(line, 0);
			ctx.lineTo(line, canvas.height);
			ctx.moveTo(0, line);
			ctx.lineTo(canvas.width, line);
			ctx.stroke();
		}
		const center = Math.floor(sample / 2) * cell;
		ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
		ctx.lineWidth = 3;
		ctx.strokeRect(center - 1, center - 1, cell + 2, cell + 2);
		ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
		ctx.lineWidth = 1.5;
		ctx.strokeRect(center, center, cell, cell);
	}, [cursor, source]);

	// Mosaic patches are built from the untouched pixels, so they stay valid
	// when strokes above or below change. One per stroke, rebuilt only when a
	// new mosaic lands (or undo brings one back).
	useEffect(() => {
		if (!source) return;
		const missing = strokes.filter(stroke => stroke.tool === "mosaic" && !patches[stroke.id]);
		if (missing.length === 0) return;
		setPatches(previous => {
			const next = { ...previous };
			for (const stroke of missing) {
				const region = normalizeRegion(
					{ x: stroke.points[0]!, y: stroke.points[1]! },
					{ x: stroke.points[2]!, y: stroke.points[3]! },
				);
				const patch = buildMosaicPatch(source, region, Math.max(2, Math.round(10 / scale)));
				if (patch) next[stroke.id] = patch;
			}
			return next;
		});
	}, [strokes, source, patches, scale]);

	const imagePointOf = (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
		const rect = event.currentTarget.getBoundingClientRect();
		return {
			x: ((event.clientX - rect.left) * (img?.naturalWidth ?? 1)) / Math.max(1, rect.width),
			y: ((event.clientY - rect.top) * (img?.naturalHeight ?? 1)) / Math.max(1, rect.height),
		};
	};

	const pushOp = (op: Op): void => {
		setPast(previous => [...previous.slice(-99), op]);
		setFuture([]);
	};

	/** State and the ref move together: `finish` exports inside the same
	 *  gesture that lands a pending label, so reading `strokes` there would
	 *  serialize the board from before that commit. */
	const applyStrokes = (next: ShotStroke[]): void => {
		strokesRef.current = next;
		setStrokes(next);
	};

	const commitStroke = (stroke: ShotStroke): void => {
		applyStrokes([...strokesRef.current, stroke]);
		pushOp({ kind: "add", stroke });
		// Build the mosaic patch now: waiting for the effect paints one blank
		// frame where the user just dragged, which reads as a dropped gesture.
		if (stroke.tool === "mosaic" && source) {
			const region = normalizeRegion(
				{ x: stroke.points[0]!, y: stroke.points[1]! },
				{ x: stroke.points[2]!, y: stroke.points[3]! },
			);
			const patch = buildMosaicPatch(source, region, Math.max(2, Math.round(10 / scale)));
			if (patch) setPatches(previous => ({ ...previous, [stroke.id]: patch }));
		}
	};

	const copyColorAt = (point: Point): void => {
		if (!source) return;
		const text =
			format === "hex"
				? formatHex(pixelAt(source, point.x, point.y))
				: formatRgba(pixelAt(source, point.x, point.y));
		void (async () => {
			const copied = await copyToClipboard(text);
			const message = copied
				? t("composer.screenshotColorCopiedWithColor", { color: text })
				: t("composer.screenshotColorCopyFailed");
			setStatus(message);
			pushActionToast({ kind: copied ? "success" : "error", message });
		})();
	};

	const removeAt = (point: Point): void => {
		if (!img) return;
		const reach = 6 / scale;
		const current = strokesRef.current;
		for (let index = current.length - 1; index >= 0; index--) {
			const victim = current[index]!;
			if (!hitStroke(victim, point, reach)) continue;
			applyStrokes(current.filter(stroke => stroke.id !== victim.id));
			pushOp({ kind: "remove", stroke: victim });
			return;
		}
	};

	const closeTextEditor = useCallback((): void => {
		const editor = editorRef.current;
		const label = textDraft.trim();
		editorRef.current = null;
		setTextEditor(null);
		setTextDraft("");
		if (!editor || !label) return;
		const font = labelFont(size);
		const lines = wrapTextLines(label, TEXT_BOX_W, font, measureTextWidth);
		const height = Math.max(font * 1.3, lines.length * font * 1.3);
		commitStroke({
			id: idRef.current++,
			tool: "text",
			color,
			size: font / scale,
			points: [editor.x, editor.y, TEXT_BOX_W / scale, height / scale],
			text: label,
		});
	}, [textDraft, size, color, scale]);

	const requestClose = useCallback((): void => {
		if (editorRef.current) {
			closeTextEditor();
			return;
		}
		if (paletteOpen) {
			setPaletteOpen(false);
			return;
		}
		setClosing(true);
		if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
		closeTimerRef.current = setTimeout(onCancel, 180);
	}, [closeTextEditor, onCancel, paletteOpen]);

	const undo = useCallback((): void => {
		const op = past[past.length - 1];
		if (!op) return;
		setPast(previous => previous.slice(0, -1));
		setFuture(previous => [...previous, op]);
		const current = strokesRef.current;
		if (op.kind === "add") applyStrokes(current.filter(stroke => stroke.id !== op.stroke.id));
		else if (op.kind === "remove") applyStrokes([...current, op.stroke]);
		else applyStrokes(op.strokes);
	}, [past]);

	const redo = useCallback((): void => {
		const op = future[future.length - 1];
		if (!op) return;
		setFuture(previous => previous.slice(0, -1));
		setPast(previous => [...previous, op]);
		const current = strokesRef.current;
		if (op.kind === "add") applyStrokes([...current, op.stroke]);
		else if (op.kind === "remove") applyStrokes(current.filter(stroke => stroke.id !== op.stroke.id));
		else applyStrokes([]);
	}, [future]);

	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent): void => {
			const veil = veilRef.current;
			if (!veil || !isTopModal(veil)) return;
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				requestClose();
				return;
			}
			if (editorRef.current) return;
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
				event.preventDefault();
				if (event.shiftKey) redo();
				else undo();
			}
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, [open, requestClose, undo, redo, veilRef]);

	const clearAll = (): void => {
		const current = strokesRef.current;
		if (current.length === 0) return;
		pushOp({ kind: "clear", strokes: current });
		applyStrokes([]);
	};

	const exportDataUrl = (): string | null => {
		const image = img;
		const frame = crop ?? (image ? { x0: 0, y0: 0, x1: image.naturalWidth, y1: image.naturalHeight } : null);
		if (!image || !frame) return null;
		const region = clampRegion(frame, image.naturalWidth, image.naturalHeight);
		const width = Math.max(1, Math.round(region.x1 - region.x0));
		const height = Math.max(1, Math.round(region.y1 - region.y0));
		const output = document.createElement("canvas");
		output.width = width;
		output.height = height;
		const ctx = output.getContext("2d");
		if (!ctx) return null;
		ctx.drawImage(image, region.x0, region.y0, width, height, 0, 0, width, height);
		drawShotStrokes(ctx, strokesRef.current, {
			scale: 1,
			offsetX: region.x0,
			offsetY: region.y0,
			mosaic: stroke => patches[stroke.id] ?? null,
		});
		return output.toDataURL("image/png");
	};

	const finish = (): void => {
		if (editorRef.current) closeTextEditor();
		const dataUrl = exportDataUrl();
		setClosing(true);
		if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
		closeTimerRef.current = setTimeout(() => {
			if (dataUrl) onConfirm(dataUrl);
			else onCancel();
		}, 180);
	};

	const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
		if (!img) return;
		const point = imagePointOf(event);
		const frame = cropDrag?.region ?? crop;
		if (tool === "crop") {
			if (!frame) return;
			const tolerance = 10 / scale;
			const hit = handlePoints(frame, 1).find(
				([, hx, hy]) => Math.abs(hx - point.x) <= tolerance && Math.abs(hy - point.y) <= tolerance,
			);
			if (hit) {
				event.currentTarget.setPointerCapture(event.pointerId);
				setCropDrag({ handle: hit[0], from: frame, region: frame });
				return;
			}
			event.currentTarget.setPointerCapture(event.pointerId);
			cropAnchorRef.current = point;
			setDraftCrop({ x0: point.x, y0: point.y, x1: point.x, y1: point.y });
			return;
		}
		if (tool === "color") {
			copyColorAt(point);
			return;
		}
		if (tool === "eraser") {
			erasingRef.current = true;
			event.currentTarget.setPointerCapture(event.pointerId);
			removeAt(point);
			return;
		}
		if (tool === "text") {
			if (editorRef.current) {
				closeTextEditor();
				return;
			}
			// The caret is planted on pointerup: focusing a textarea inside
			// pointerdown lets the click's own focus handling blur it again,
			// which discards the empty draft before a character is typed.
			pendingTextRef.current = point;
			return;
		}
		event.currentTarget.setPointerCapture(event.pointerId);
		const stroke: ShotStroke = {
			id: idRef.current++,
			tool,
			color,
			size: tool === "mosaic" ? 1 : size / scale,
			points: tool === "pen" ? [point.x, point.y] : [point.x, point.y, point.x, point.y],
		};
		draftRef.current = stroke;
		setDraft(stroke);
	};

	const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
		if (!img) return;
		const point = imagePointOf(event);
		setCursor(point);
		if (cropDrag) {
			setCropDrag(current =>
				current
					? {
							...current,
							region: resizeFrame(current.from, current.handle, point, img.naturalWidth, img.naturalHeight),
						}
					: current,
			);
			return;
		}
		const anchor = cropAnchorRef.current;
		if (anchor && draftCrop) {
			setDraftCrop(clampRegion(normalizeRegion(anchor, point), img.naturalWidth, img.naturalHeight));
			return;
		}
		if (erasingRef.current) {
			removeAt(point);
			return;
		}
		const current = draftRef.current;
		if (!current) return;
		if (current.tool === "pen") {
			const lastX = current.points[current.points.length - 2]!;
			const lastY = current.points[current.points.length - 1]!;
			if (Math.hypot(point.x - lastX, point.y - lastY) * scale < 1.5) return;
			current.points.push(point.x, point.y);
		} else {
			current.points[2] = point.x;
			current.points[3] = point.y;
		}
		setDraft({ ...current, points: [...current.points] });
	};

	const onPointerUp = (): void => {
		erasingRef.current = false;
		if (cropDrag) {
			const region = cropDrag.region;
			setCropDrag(null);
			if (isUsableRegion(region)) setCrop(region);
			return;
		}
		const anchor = cropAnchorRef.current;
		cropAnchorRef.current = null;
		if (anchor) {
			const region = draftCrop;
			setDraftCrop(null);
			if (region && isUsableRegion(region)) setCrop(region);
			return;
		}
		const pending = pendingTextRef.current;
		pendingTextRef.current = null;
		if (pending) {
			editorRef.current = { x: pending.x, y: pending.y, w: TEXT_BOX_W };
			setTextEditor(editorRef.current);
			setTextDraft("");
			return;
		}
		const current = draftRef.current;
		draftRef.current = null;
		setDraft(null);
		if (!current) return;
		if (current.tool === "pen") {
			if (current.points.length >= 4) commitStroke(current);
			return;
		}
		const region = normalizeRegion(
			{ x: current.points[0]!, y: current.points[1]! },
			{ x: current.points[2]!, y: current.points[3]! },
		);
		if (!isUsableRegion(region)) return;
		commitStroke(current);
	};

	const onToolbarFocus = (event: React.FocusEvent<HTMLDivElement>): void => {
		if (!(event.target instanceof HTMLButtonElement)) return;
		if (!event.target.matches("[data-shot-roving]")) return;
		const buttons = Array.from(
			event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-shot-roving]:not(:disabled)"),
		);
		for (const button of buttons) button.tabIndex = button === event.target ? 0 : -1;
	};

	const onToolbarKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
		if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
		if (!(document.activeElement instanceof HTMLButtonElement)) return;
		const buttons = Array.from(
			event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-shot-roving]:not(:disabled)"),
		);
		const current = buttons.indexOf(document.activeElement);
		if (current < 0 || buttons.length === 0) return;
		event.preventDefault();
		const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
		const next =
			event.key === "Home"
				? 0
				: event.key === "End"
					? buttons.length - 1
					: (current + (event.key === "ArrowRight" ? (rtl ? -1 : 1) : rtl ? 1 : -1) + buttons.length) %
						buttons.length;
		for (const [index, button] of buttons.entries()) button.tabIndex = index === next ? 0 : -1;
		buttons[next]?.focus();
	};

	if (!open && !closing) return null;

	const frame = draftCrop ?? cropDrag?.region ?? crop;
	const cropSize = frame ? regionSize(frame) : null;
	const fullCrop =
		!!img &&
		!!crop &&
		crop.x0 === 0 &&
		crop.y0 === 0 &&
		crop.x1 === img.naturalWidth &&
		crop.y1 === img.naturalHeight;
	const canUndo = past.length > 0;
	const canRedo = future.length > 0;
	const cursorStyle = tool === "text" ? "text" : tool === "eraser" ? "cell" : tool === "color" ? "copy" : "crosshair";
	const loupeLeft = cursor ? cursor.x * scale + 20 : 0;
	const loupeTop = cursor ? cursor.y * scale + 20 : 0;
	const flipX = cursor ? loupeLeft + 168 > viewWidth : false;
	const flipY = cursor ? loupeTop + 196 > viewHeight : false;

	return (
		<div
			ref={veilRef}
			role="dialog"
			aria-modal="true"
			aria-label={t("composer.screenshotEditor")}
			className={`gui-shot-veil${closing ? " gui-shot-veil--closing" : ""}`}
		>
			<header className="gui-shot-head">
				<div className="gui-shot-head-start">
					<button
						type="button"
						className="gui-shot-icon"
						title={t("settings.cancel")}
						aria-label={t("settings.cancel")}
						onClick={requestClose}
					>
						<X size={16} />
					</button>
					<span className="gui-shot-title">{t("composer.screenshotTitle")}</span>
					{img && (
						<span className="gui-shot-meta">
							{img.naturalWidth} × {img.naturalHeight}
						</span>
					)}
				</div>
				<div className="gui-shot-head-end">
					<span className="gui-shot-zoom" title={t("composer.screenshotZoom")}>
						{Math.round(scale * 100)}%
					</span>
					<div className="gui-shot-segment" role="group" aria-label={t("composer.screenshotFormat")}>
						{(["hex", "rgba"] as const).map(option => (
							<button
								key={option}
								type="button"
								className={`gui-shot-segment-item${format === option ? " gui-shot-segment-item--on" : ""}`}
								aria-pressed={format === option}
								onClick={() => setFormat(option)}
							>
								{option.toUpperCase()}
							</button>
						))}
					</div>
					<button
						type="button"
						className="gui-shot-icon"
						title={t("composer.screenshotSelectAll")}
						aria-label={t("composer.screenshotSelectAll")}
						disabled={!img || fullCrop}
						onClick={() => {
							if (!img) return;
							setCrop({ x0: 0, y0: 0, x1: img.naturalWidth, y1: img.naturalHeight });
						}}
					>
						<Maximize size={15} />
					</button>
				</div>
			</header>

			<div ref={stageRef} className="gui-shot-stage">
				{img && crop ? (
					<div className="gui-shot-frame" style={{ width: viewWidth, height: viewHeight }}>
						<canvas
							ref={canvasRef}
							className="gui-shot-canvas"
							style={{ cursor: cursorStyle }}
							aria-label={t("composer.screenshotCanvas")}
							tabIndex={0}
							onPointerDown={onPointerDown}
							onPointerMove={onPointerMove}
							onPointerUp={onPointerUp}
							onPointerCancel={() => {
								erasingRef.current = false;
								cropAnchorRef.current = null;
								draftRef.current = null;
								pendingTextRef.current = null;
								setDraft(null);
								setDraftCrop(null);
								setCropDrag(null);
							}}
							onPointerLeave={() => setCursor(null)}
							onKeyDown={event => {
								if (event.key === "Enter") {
									event.preventDefault();
									finish();
								}
							}}
						/>
						{cropSize && (
							<span
								className="gui-shot-crop-size"
								style={{
									left: Math.max(0, Math.min(viewWidth - 96, (frame ? frame.x0 : 0) * scale)),
									top: Math.max(0, (frame ? frame.y0 : 0) * scale - 24),
								}}
							>
								{Math.round(cropSize.width)} × {Math.round(cropSize.height)}
							</span>
						)}
						{textEditor && (
							<textarea
								ref={textAreaRef}
								className="gui-shot-text-input"
								value={textDraft}
								placeholder={t("composer.screenshotTextPlaceholder")}
								style={{
									left: textEditor.x * scale,
									top: textEditor.y * scale,
									width: textEditor.w,
									color,
									fontSize: labelFont(size),
									fontFamily: TEXT_FONT_STACK,
								}}
								onChange={event => setTextDraft(event.currentTarget.value)}
								onPointerDown={event => event.stopPropagation()}
								onBlur={closeTextEditor}
							/>
						)}
						{cursor && source && !draft && !draftCrop && !cropDrag && (
							<div
								className="gui-shot-loupe"
								style={{
									left: flipX ? cursor.x * scale - 168 - 20 : loupeLeft,
									top: flipY ? cursor.y * scale - 196 - 20 : loupeTop,
								}}
							>
								<canvas ref={loupeRef} width={132} height={132} aria-hidden="true" />
								<div className="gui-shot-loupe-readout">
									<span className="gui-shot-hex">{value(format)}</span>
									<span className={tool === "color" ? "gui-shot-loupe-hint" : "gui-shot-coord"}>
										{tool === "color"
											? t("composer.screenshotCopyColor")
											: `${Math.round(cursor.x)}, ${Math.round(cursor.y)}`}
									</span>
								</div>
							</div>
						)}
					</div>
				) : (
					<div className="gui-shot-loading">{src ? (status ?? t("composer.screenshotLoading")) : null}</div>
				)}
			</div>

			<div
				className="gui-shot-bar"
				role="toolbar"
				aria-label={t("composer.screenshotToolbar")}
				onFocus={onToolbarFocus}
				onKeyDownCapture={onToolbarKeyDown}
			>
				{TOOL_ITEMS.map(([id, Icon, labelKey], index) => (
					<button
						key={id}
						type="button"
						className={`gui-shot-tool${tool === id ? " gui-shot-tool--on" : ""}`}
						data-shot-roving="true"
						tabIndex={index === 0 ? 0 : -1}
						title={t(labelKey)}
						aria-label={t(labelKey)}
						aria-pressed={tool === id}
						onClick={() => {
							if (editorRef.current) closeTextEditor();
							setTool(id);
							if (id !== "text") pendingTextRef.current = null;
						}}
					>
						<Icon size={16} />
					</button>
				))}
				<span className="gui-shot-sep" aria-hidden />
				<button
					type="button"
					className="gui-shot-tool"
					data-shot-roving="true"
					tabIndex={-1}
					title={t("composer.sketchUndo")}
					aria-label={t("composer.sketchUndo")}
					disabled={!canUndo}
					onClick={undo}
				>
					<Undo2 size={16} />
				</button>
				<button
					type="button"
					className="gui-shot-tool"
					data-shot-roving="true"
					tabIndex={-1}
					title={t("composer.sketchRedo")}
					aria-label={t("composer.sketchRedo")}
					disabled={!canRedo}
					onClick={redo}
				>
					<Redo2 size={16} />
				</button>
				<button
					type="button"
					className="gui-shot-tool"
					data-shot-roving="true"
					tabIndex={-1}
					title={t("composer.sketchClear")}
					aria-label={t("composer.sketchClear")}
					disabled={strokes.length === 0}
					onClick={clearAll}
				>
					<Trash2 size={16} />
				</button>
				<span className="gui-shot-sep" aria-hidden />
				<div className="gui-shot-swatch">
					<button
						type="button"
						className="gui-shot-color"
						data-shot-roving="true"
						tabIndex={-1}
						title={t("composer.screenshotPalette")}
						aria-label={t("composer.screenshotPalette")}
						aria-expanded={paletteOpen}
						aria-haspopup="dialog"
						style={{ background: color }}
						onClick={() => setPaletteOpen(openPicker => !openPicker)}
					/>
					{paletteOpen && (
						<div className="gui-shot-palette" role="dialog" aria-label={t("composer.screenshotPalette")}>
							<div className="gui-shot-colors">
								{COLORS.map(option => (
									<button
										key={option}
										type="button"
										className={`gui-shot-color-swatch${color === option ? " gui-shot-color-swatch--on" : ""}`}
										style={{ background: option }}
										title={option}
										aria-label={option}
										aria-pressed={color === option}
										onClick={() => {
											setColor(option);
											setPaletteOpen(false);
										}}
									/>
								))}
							</div>
							<label className="gui-shot-weight">
								<span>{t("composer.screenshotThickness")}</span>
								<input
									type="range"
									min={MIN_SIZE}
									max={MAX_SIZE}
									step={1}
									value={size}
									aria-label={t("composer.screenshotThickness")}
									onChange={event => setSize(Number(event.currentTarget.value))}
								/>
								<span className="gui-shot-weight-value">
									{t("composer.screenshotThicknessValue", { value: size })}
								</span>
							</label>
						</div>
					)}
				</div>
				<span className="gui-shot-spacer" />
				<button type="button" className="gui-shot-cancel" onClick={requestClose}>
					{t("settings.cancel")}
				</button>
				<button
					type="button"
					className="gui-shot-done"
					disabled={!img}
					title={t("composer.sketchDone")}
					aria-label={t("composer.sketchDone")}
					onClick={finish}
				>
					<Check size={16} />
					<span>{t("composer.sketchDone")}</span>
				</button>
			</div>
			<span className="gui-shot-status" role="status">
				{status}
			</span>
		</div>
	);
}
