import { t } from "@musepi/client-core";
import type {
	FocusEvent as ReactFocusEvent,
	KeyboardEvent as ReactKeyboardEvent,
	PointerEvent as ReactPointerEvent,
} from "react";
import { useEffect, useId, useRef, useState } from "react";
import { pushActionToast } from "../lib/action-toast";
import { copyToClipboard } from "../lib/electron";
import { usePrompt } from "../lib/prompt-dialog";
import {
	clampRegion,
	drawAnnotations,
	formatHex,
	formatRgba,
	type Point,
	type RgbaPixel,
	type ScreenshotAnnotation,
	type ScreenshotRegion,
} from "../lib/screenshot-editor-utils";
import { DialogFrame } from "./DialogFrame";

type Tool = "select" | "arrow" | "text" | "color";

const TOOL_ITEMS = [
	["select", "composer.screenshotToolSelect"],
	["arrow", "composer.screenshotToolArrow"],
	["text", "composer.screenshotToolText"],
	["color", "composer.screenshotToolColor"],
] as const;

function posOf(event: ReactPointerEvent<HTMLCanvasElement>): Point {
	const canvas = event.currentTarget;
	const rect = canvas.getBoundingClientRect();
	return {
		x: Math.round(((event.clientX - rect.left) * canvas.width) / rect.width),
		y: Math.round(((event.clientY - rect.top) * canvas.height) / rect.height),
	};
}

function pixelAt(source: HTMLCanvasElement, x: number, y: number): RgbaPixel {
	const sx = Math.max(0, Math.min(source.width - 1, Math.round(x)));
	const sy = Math.max(0, Math.min(source.height - 1, Math.round(y)));
	const data = source.getContext("2d")!.getImageData(sx, sy, 1, 1).data;
	return { r: data[0]!, g: data[1]!, b: data[2]!, a: data[3]! };
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
	const [view, setView] = useState({ width: 0, height: 0, scale: 1 });
	const [loupeSource, setLoupeSource] = useState<HTMLCanvasElement | null>(null);
	const [tool, setTool] = useState<Tool>("select");
	const [loupe, setLoupe] = useState(true);
	const [format, setFormat] = useState<"hex" | "rgba">("hex");
	const [cursor, setCursor] = useState<Point | null>(null);
	const [region, setRegion] = useState<ScreenshotRegion | null>(null);
	const [draft, setDraft] = useState<ScreenshotRegion | null>(null);
	const [annotations, setAnnotations] = useState<ScreenshotAnnotation[]>([]);
	const [status, setStatus] = useState<string | null>(null);
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const loupeCanvasRef = useRef<HTMLCanvasElement | null>(null);
	const toolbarRef = useRef<HTMLDivElement | null>(null);
	const canvasId = useId();
	const { prompt } = usePrompt();

	useEffect(() => {
		setImg(null);
		setLoupeSource(null);
		setRegion(null);
		setDraft(null);
		setAnnotations([]);
		setCursor(null);
		setStatus(null);
		setTool("select");
		if (!src) return;
		const image = new Image();
		image.onload = () => {
			const scale = Math.min(1, 720 / image.naturalWidth, 440 / image.naturalHeight);
			setView({
				width: Math.round(image.naturalWidth * scale),
				height: Math.round(image.naturalHeight * scale),
				scale,
			});
			const source = document.createElement("canvas");
			source.width = image.naturalWidth;
			source.height = image.naturalHeight;
			source.getContext("2d")!.drawImage(image, 0, 0);
			setLoupeSource(source);
			setImg(image);
		};
		image.onerror = () => setStatus(t("composer.screenshotLoadFailed"));
		image.src = src;
		return () => {
			image.onload = null;
			image.onerror = null;
		};
	}, [src]);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || !img) return;
		const ctx = canvas.getContext("2d")!;
		ctx.clearRect(0, 0, view.width, view.height);
		ctx.drawImage(img, 0, 0, view.width, view.height);
		drawAnnotations(ctx, annotations, { scale: view.scale });
		if (region) drawAnnotations(ctx, [region], { scale: view.scale });
		if (draft) drawAnnotations(ctx, [draft], { scale: view.scale });
	}, [img, view, region, annotations, draft]);

	useEffect(() => {
		const canvas = loupeCanvasRef.current;
		if (!canvas || !loupeSource || !cursor || !loupe) return;
		const sample = Math.min(15, loupeSource.width, loupeSource.height);
		if (sample <= 0) return;
		const ctx = canvas.getContext("2d")!;
		ctx.imageSmoothingEnabled = false;
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		const sx = Math.max(0, Math.min(loupeSource.width - sample, cursor.x - Math.floor(sample / 2)));
		const sy = Math.max(0, Math.min(loupeSource.height - sample, cursor.y - Math.floor(sample / 2)));
		ctx.drawImage(loupeSource, sx, sy, sample, sample, 0, 0, canvas.width, canvas.height);
	}, [cursor, loupeSource, loupe]);

	const copyColorAt = (point: Point): void => {
		if (!loupeSource) return;
		const pixel = pixelAt(loupeSource, point.x, point.y);
		const text = format === "hex" ? formatHex(pixel) : formatRgba(pixel);
		void (async () => {
			const copied = await copyToClipboard(text);
			const message = copied
				? t("composer.screenshotColorCopiedWithColor", { color: text })
				: t("composer.screenshotColorCopyFailed");
			setStatus(message);
			pushActionToast({ kind: copied ? "success" : "error", message });
		})();
	};

	const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
		if (!img) return;
		const point = posOf(event);
		if (tool === "color") {
			copyColorAt(point);
			return;
		}
		if (tool === "text") {
			void prompt({
				title: t("composer.screenshotTextPrompt"),
				placeholder: t("composer.screenshotTextPlaceholder"),
			}).then(label => {
				if (label) setAnnotations(previous => [...previous, { type: "text", x: point.x, y: point.y, text: label }]);
			});
			return;
		}
		event.currentTarget.setPointerCapture(event.pointerId);
		setDraft({ x0: point.x, y0: point.y, x1: point.x, y1: point.y, type: tool === "select" ? "select" : "arrow" });
	};

	const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
		if (!img) return;
		const point = posOf(event);
		setCursor(point);
		if (draft) setDraft(current => (current ? { ...current, x1: point.x, y1: point.y } : current));
	};

	const onPointerUp = (): void => {
		if (!draft) return;
		if (draft.type === "select") setRegion(draft);
		else setAnnotations(previous => [...previous, draft]);
		setDraft(null);
	};

	const onConfirmClick = (): void => {
		if (!img) return;
		const selected = region
			? clampRegion(region, img.naturalWidth, img.naturalHeight)
			: { x0: 0, y0: 0, x1: img.naturalWidth, y1: img.naturalHeight };
		const width = Math.max(1, Math.round(selected.x1 - selected.x0));
		const height = Math.max(1, Math.round(selected.y1 - selected.y0));
		const output = document.createElement("canvas");
		output.width = width;
		output.height = height;
		const ctx = output.getContext("2d")!;
		ctx.drawImage(img, selected.x0, selected.y0, width, height, 0, 0, width, height);
		drawAnnotations(ctx, annotations, { scale: 1, offsetX: selected.x0, offsetY: selected.y0 });
		onConfirm(output.toDataURL("image/png"));
	};

	const onToolbarFocus = (event: ReactFocusEvent<HTMLDivElement>): void => {
		if (!(event.target instanceof HTMLButtonElement)) return;
		const buttons = Array.from(event.currentTarget.querySelectorAll("button"));
		for (const button of buttons) button.tabIndex = button === event.target ? 0 : -1;
	};

	const onToolbarKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
		const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
		if (!keys.includes(event.key)) return;
		const buttons = Array.from(event.currentTarget.querySelectorAll("button"));
		const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
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

	return (
		<DialogFrame
			open={open}
			onClose={onCancel}
			label={t("composer.screenshotEditor")}
			className="gui-dialog--screenshot"
		>
			<div className="gui-shot-editor">
				<div
					ref={toolbarRef}
					className="gui-shot-toolbar"
					role="toolbar"
					aria-label={t("composer.screenshotToolbar")}
					aria-controls={canvasId}
					onFocus={onToolbarFocus}
					onKeyDownCapture={onToolbarKeyDown}
				>
					<div className="gui-shot-tool-group" role="group" aria-label={t("composer.screenshotTools")}>
						{TOOL_ITEMS.map(([id, key], index) => (
							<button
								key={id}
								type="button"
								className="gui-shot-tool"
								aria-pressed={tool === id}
								tabIndex={index === 0 ? 0 : -1}
								onClick={() => setTool(id)}
							>
								{t(key)}
							</button>
						))}
					</div>
					<div className="gui-shot-tool-group" role="group" aria-label={t("composer.screenshotInspection")}>
						<button
							type="button"
							className="gui-shot-tool"
							aria-pressed={loupe}
							tabIndex={-1}
							onClick={() => setLoupe(value => !value)}
						>
							{t("composer.screenshotLoupe")}
						</button>
						{(["hex", "rgba"] as const).map(value => (
							<button
								key={value}
								type="button"
								className="gui-shot-tool"
								aria-pressed={format === value}
								tabIndex={-1}
								onClick={() => setFormat(value)}
							>
								{value.toUpperCase()}
							</button>
						))}
					</div>
					<div className="gui-shot-tool-group" role="group" aria-label={t("composer.screenshotActions")}>
						<button
							type="button"
							className="gui-shot-tool"
							aria-disabled={annotations.length === 0}
							tabIndex={-1}
							onClick={() => {
								if (annotations.length > 0) setAnnotations(previous => previous.slice(0, -1));
							}}
						>
							{t("composer.sketchUndo")}
						</button>
						<button
							type="button"
							className="gui-shot-tool"
							aria-disabled={annotations.length === 0 && !region}
							tabIndex={-1}
							onClick={() => {
								setAnnotations([]);
								setRegion(null);
							}}
						>
							{t("composer.sketchClear")}
						</button>
					</div>
				</div>
				<span className="gui-shot-status" role="status">
					{status}
				</span>
				{img ? (
					<div className="gui-shot-stage">
						<canvas
							id={canvasId}
							ref={canvasRef}
							width={view.width}
							height={view.height}
							className="gui-shot-canvas"
							aria-label={t("composer.screenshotCanvas")}
							onPointerDown={onPointerDown}
							onPointerMove={onPointerMove}
							onPointerUp={onPointerUp}
							onPointerCancel={() => setDraft(null)}
							onPointerLeave={() => setCursor(null)}
							onKeyDown={event => {
								if (event.key.toLowerCase() === "c" && cursor && !event.ctrlKey && !event.metaKey)
									copyColorAt(cursor);
								if (event.key === "Shift" && !event.repeat)
									setFormat(value => (value === "hex" ? "rgba" : "hex"));
							}}
							tabIndex={0}
						/>
					</div>
				) : (
					<div className="gui-shot-loading">{src ? (status ?? t("composer.screenshotLoading")) : null}</div>
				)}
				{loupe && loupeSource && (
					<div className="gui-shot-loupe">
						<canvas ref={loupeCanvasRef} width={120} height={120} aria-hidden="true" />
						{cursor ? (
							<span>
								({cursor.x}, {cursor.y}) ·{" "}
								{format === "hex"
									? formatHex(pixelAt(loupeSource, cursor.x, cursor.y))
									: formatRgba(pixelAt(loupeSource, cursor.x, cursor.y))}
							</span>
						) : (
							<span>{t("composer.screenshotLoupeHint")}</span>
						)}
						<button
							type="button"
							className="gui-shot-tool"
							aria-disabled={!cursor}
							onClick={() => cursor && copyColorAt(cursor)}
						>
							{t("composer.screenshotCopyColor")}
						</button>
					</div>
				)}
				<div className="gui-shot-footer">
					<span>{t("composer.screenshotKeyboardHint")}</span>
					<div className="gui-shot-footer-actions">
						<button type="button" className="gui-shot-tool" onClick={onCancel}>
							{t("settings.cancel")}
						</button>
						<button
							type="button"
							className="gui-shot-tool gui-shot-tool--primary"
							aria-disabled={!img}
							onClick={onConfirmClick}
						>
							{t("composer.sketchDone")}
						</button>
					</div>
				</div>
			</div>
		</DialogFrame>
	);
}
