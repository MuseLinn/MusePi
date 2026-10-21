/**
 * The file pane's zoomable image preview.
 *
 * The lightbox (image-lightbox.tsx) already zooms, but it is a full-screen
 * overlay: you cannot judge an image's crop or spacing inside a file pane, and
 * the overlay cannot shrink below 1:1 — a 4000px screenshot has no way to be
 * seen whole.
 *
 * This is the in-pane answer: fit first, then closer. Fit never upscales, so a
 * small icon stays its real size instead of blurring across the panel. Zoom
 * follows the pointer — Ctrl/⌘ + wheel or a trackpad pinch, a two-finger touch
 * pinch, the − and + steps, or a double-click between fit and 1:1 — and a zoomed
 * image larger than the viewer pans by dragging.
 */

import {
	clampImageScale,
	fitImageScale,
	type GestureEventLike,
	IMAGE_VIEWPORT_PADDING,
	type ImageSize as Size,
	stepImageScale,
	t,
	wheelZoomFactor,
} from "@musepi/client-core";
import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

/** An image point that must stay under a screen point once a zoom renders. */
interface ZoomAnchor {
	imageX: number;
	imageY: number;
	clientX: number;
	clientY: number;
}

interface DragState {
	pointerId: number;
	x: number;
	y: number;
	left: number;
	top: number;
}

interface TouchPinch {
	distance: number;
	scale: number;
}

function touchDistance(a: Touch, b: Touch): number {
	return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

export interface ImagePreviewProps {
	src: string;
	name: string;
	/** Natural size, when the host already knows it. */
	natural?: Size | null;
	/** The viewer's size, when the host measures it. */
	viewport?: Size | null;
	onOpenLightbox?(): void;
}

/**
 * The zoomable preview.
 *
 * The scale and the pan live here rather than in the pane, because the pan is
 * expressed in the viewer's scroll offsets — a native scroll container, not a
 * transform — so the image stays crisp and the scrollbars stay honest.
 */
export function ImagePreview({ src, name, natural: naturalProp = null, onOpenLightbox }: ImagePreviewProps): ReactNode {
	// null is fit: the scale then follows the viewer's size.
	const [scale, setScale] = useState<number | null>(null);
	const [natural, setNatural] = useState<Size | null>(naturalProp);
	const [viewport, setViewport] = useState<Size | null>(null);
	const [dragging, setDragging] = useState(false);
	const viewportRef = useRef<HTMLDivElement | null>(null);
	const imageRef = useRef<HTMLImageElement | null>(null);
	const anchorRef = useRef<ZoomAnchor | null>(null);
	const dragRef = useRef<DragState | null>(null);

	useEffect(() => {
		setNatural(naturalProp);
		setScale(null);
	}, [src, naturalProp]);

	useEffect(() => {
		const element = viewportRef.current;
		if (!element) return;
		const observer = new ResizeObserver(() => {
			setViewport({ width: element.clientWidth, height: element.clientHeight });
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	const fitScale = natural && viewport ? fitImageScale(natural, viewport) : 1;
	const shownScale = scale ?? fitScale;
	const canPan =
		scale !== null &&
		natural !== null &&
		viewport !== null &&
		(natural.width * scale + IMAGE_VIEWPORT_PADDING * 2 > viewport.width ||
			natural.height * scale + IMAGE_VIEWPORT_PADDING * 2 > viewport.height);

	/**
	 * Zooms so the image point under (clientX, clientY) stays there.
	 *
	 * The render is flushed at once so the next wheel or pinch event measures
	 * the new size rather than the old one.
	 */
	const zoomTo = (nextScale: number, clientX: number, clientY: number): void => {
		const image = imageRef.current;
		if (!image || !natural) return;
		const rect = image.getBoundingClientRect();
		const rendered = image.clientWidth / natural.width;
		if (rendered <= 0) return;
		anchorRef.current = {
			imageX: (clientX - rect.left - image.clientLeft) / rendered,
			imageY: (clientY - rect.top - image.clientTop) / rendered,
			clientX,
			clientY,
		};
		flushSync(() => setScale(clampImageScale(nextScale, fitScale)));
	};

	const zoomAtCenter = (nextScale: number): void => {
		const element = viewportRef.current;
		if (!element) return;
		const rect = element.getBoundingClientRect();
		zoomTo(nextScale, rect.left + rect.width / 2, rect.top + rect.height / 2);
	};

	// Put the anchored image point back under the pointer after the zoom.
	useLayoutEffect(() => {
		const anchor = anchorRef.current;
		const element = viewportRef.current;
		const image = imageRef.current;
		anchorRef.current = null;
		if (!anchor || !element || !image || scale === null || image.naturalWidth <= 0) return;
		const rect = image.getBoundingClientRect();
		const rendered = image.clientWidth / image.naturalWidth;
		element.scrollLeft += rect.left + image.clientLeft + anchor.imageX * rendered - anchor.clientX;
		element.scrollTop += rect.top + image.clientTop + anchor.imageY * rendered - anchor.clientY;
	}, [scale]);

	// Native listeners: React's wheel and touch listeners are passive, and
	// could not stop the page from zooming or scrolling instead of the image.
	const gestureHandlersRef = useRef({ zoomTo, shownScale });
	gestureHandlersRef.current = { zoomTo, shownScale };
	useEffect(() => {
		const element = viewportRef.current;
		if (!element) return;
		let touchCount = 0;
		let touchPinch: TouchPinch | null = null;
		let gestureBase: number | null = null;

		const onWheel = (event: WheelEvent): void => {
			if (!event.ctrlKey && !event.metaKey) return;
			event.preventDefault();
			const handlers = gestureHandlersRef.current;
			handlers.zoomTo(
				handlers.shownScale * wheelZoomFactor(event.deltaY, event.deltaMode),
				event.clientX,
				event.clientY,
			);
		};
		const onTouchStart = (event: TouchEvent): void => {
			touchCount = event.touches.length;
			if (event.touches.length !== 2) return;
			touchPinch = {
				distance: touchDistance(event.touches[0], event.touches[1]),
				scale: gestureHandlersRef.current.shownScale,
			};
		};
		const onTouchMove = (event: TouchEvent): void => {
			if (!touchPinch || event.touches.length !== 2 || touchPinch.distance <= 0) return;
			event.preventDefault();
			const [first, second] = [event.touches[0], event.touches[1]];
			gestureHandlersRef.current.zoomTo(
				touchPinch.scale * (touchDistance(first, second) / touchPinch.distance),
				(first.clientX + second.clientX) / 2,
				(first.clientY + second.clientY) / 2,
			);
		};
		const onTouchEnd = (event: TouchEvent): void => {
			touchCount = event.touches.length;
			if (event.touches.length < 2) touchPinch = null;
		};
		// iOS sends gesture events alongside the touch pinch above; only a
		// trackpad pinch in Safari, with no finger on the screen, zooms here.
		const onGestureStart = (event: GestureEventLike): void => {
			event.preventDefault();
			gestureBase = touchCount > 0 ? null : gestureHandlersRef.current.shownScale;
		};
		const onGestureChange = (event: GestureEventLike): void => {
			event.preventDefault();
			if (gestureBase === null) return;
			gestureHandlersRef.current.zoomTo(gestureBase * event.scale, event.clientX, event.clientY);
		};
		const onGestureEnd = (event: GestureEventLike): void => {
			event.preventDefault();
			gestureBase = null;
		};

		element.addEventListener("wheel", onWheel, { passive: false });
		element.addEventListener("touchstart", onTouchStart, { passive: true });
		element.addEventListener("touchmove", onTouchMove, { passive: false });
		element.addEventListener("touchend", onTouchEnd, { passive: true });
		element.addEventListener("touchcancel", onTouchEnd, { passive: true });
		// The DOM lib has no "gesturestart" overload — the events are WebKit's
		// trackpad pinch, and simply never fire elsewhere.
		const gestureTarget = element as unknown as {
			addEventListener(type: string, listener: (event: GestureEventLike) => void): void;
			removeEventListener(type: string, listener: (event: GestureEventLike) => void): void;
		};
		gestureTarget.addEventListener("gesturestart", onGestureStart);
		gestureTarget.addEventListener("gesturechange", onGestureChange);
		gestureTarget.addEventListener("gestureend", onGestureEnd);
		return () => {
			element.removeEventListener("wheel", onWheel);
			element.removeEventListener("touchstart", onTouchStart);
			element.removeEventListener("touchmove", onTouchMove);
			element.removeEventListener("touchend", onTouchEnd);
			element.removeEventListener("touchcancel", onTouchEnd);
			gestureTarget.removeEventListener("gesturestart", onGestureStart);
			gestureTarget.removeEventListener("gesturechange", onGestureChange);
			gestureTarget.removeEventListener("gestureend", onGestureEnd);
		};
	}, []);

	const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
		if (!canPan || event.pointerType !== "mouse" || event.button !== 0) return;
		const element = event.currentTarget;
		// A press on the viewer's own scrollbar keeps scrolling the native way.
		const bounds = element.getBoundingClientRect();
		if (event.clientX - bounds.left >= element.clientWidth || event.clientY - bounds.top >= element.clientHeight)
			return;
		event.preventDefault();
		element.setPointerCapture(event.pointerId);
		dragRef.current = {
			pointerId: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			left: element.scrollLeft,
			top: element.scrollTop,
		};
		setDragging(true);
	};
	const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		event.currentTarget.scrollLeft = drag.left - (event.clientX - drag.x);
		event.currentTarget.scrollTop = drag.top - (event.clientY - drag.y);
	};
	const handlePointerEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
		if (dragRef.current?.pointerId !== event.pointerId) return;
		dragRef.current = null;
		setDragging(false);
	};
	const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>): void => {
		if (scale === null) {
			zoomTo(1, event.clientX, event.clientY);
			return;
		}
		setScale(null);
	};

	return (
		<div className="gui-filepane-preview-image">
			<div className="gui-filepane-preview-image-bar">
				<span className="gui-filepane-preview-image-meta">
					{natural ? `${natural.width} × ${natural.height}` : name}
				</span>
				<span className="gui-filepane-preview-image-scale">{Math.round(shownScale * 100)}%</span>
				<button
					type="button"
					className="gui-filepane-preview-image-btn"
					aria-label={t("settings.previewImageZoomOut")}
					title={t("settings.previewImageZoomOut")}
					disabled={!natural}
					onClick={() => zoomAtCenter(stepImageScale(shownScale, -1))}
				>
					−
				</button>
				<button
					type="button"
					className="gui-filepane-preview-image-btn"
					aria-label={t("settings.previewImageZoomIn")}
					title={t("settings.previewImageZoomIn")}
					disabled={!natural}
					onClick={() => zoomAtCenter(stepImageScale(shownScale, 1))}
				>
					+
				</button>
				<button
					type="button"
					className="gui-filepane-preview-image-btn"
					aria-pressed={scale === null}
					title={t("settings.previewImageFit")}
					onClick={() => setScale(null)}
				>
					{t("settings.previewImageFit")}
				</button>
				{onOpenLightbox && (
					<button
						type="button"
						className="gui-filepane-preview-image-btn"
						title={t("settings.previewImageExpand")}
						onClick={onOpenLightbox}
					>
						{t("settings.previewImageExpand")}
					</button>
				)}
			</div>
			<div
				ref={viewportRef}
				className={`gui-filepane-preview-image-viewport${canPan ? (dragging ? " is-dragging" : " is-pannable") : ""}`}
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerEnd}
				onPointerCancel={handlePointerEnd}
				onDoubleClick={handleDoubleClick}
			>
				<div className={`gui-filepane-preview-image-inner${scale === null ? " is-fit" : " is-zoomed"}`}>
					<img
						ref={imageRef}
						key={src}
						src={src}
						alt={name}
						draggable={false}
						onLoad={event => {
							const image = event.currentTarget;
							setNatural({ width: image.naturalWidth, height: image.naturalHeight });
						}}
						style={
							scale !== null && natural
								? { width: natural.width * scale, height: natural.height * scale }
								: undefined
						}
						className="gui-filepane-preview-image-img"
					/>
				</div>
			</div>
		</div>
	);
}
