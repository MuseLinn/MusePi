import { type ReactNode, useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import { type BlobImageItem, useResolvedImageItems } from "../../lib/blob-image";
import type { ToolRenderHost } from "../../tool-render/types";
import "./image-card-stack.css";

/**
 * Swipeable card stack for multi-image messages (craft-agents
 * ImageCardStack parity, no motion dep): all images of one message
 * collapse into a single 240px interactive stack instead of N full-width
 * rows. The top card drags horizontally past a threshold to wrap to the
 * next image; a tap (no drag) opens the full-size preview lightbox at the
 * current index. Behind cards recede via scale / vertical offset /
 * rotation (pure CSS transitions).
 */
export function ImageCardStack<T extends BlobImageItem>({
	items,
	host,
	onOpen,
}: {
	items: readonly T[];
	/** Host capability that resolves `blob:sha256:` refs to displayable bytes.
	 *  Absent in guests/exports: refs keep their alt text there. */
	host?: ToolRenderHost;
	/** Open the preview lightbox at this image (message gallery). The second
	 *  argument is the resolved list, so the lightbox never receives a ref
	 *  the host could not display. */
	onOpen(index: number, items: { src: string; alt: string }[], element?: HTMLElement | null): void;
}): ReactNode {
	// A restored session stores images as blob refs; resolve before painting so
	// the card and the lightbox share one displayable list.
	const resolved = useResolvedImageItems(items, host);
	// The lightbox takes the plain gallery shape; mimeType stays card-side.
	const gallery = resolved.map(item => ({ src: item.src, alt: item.alt }));
	const [index, setIndex] = useState(0);
	const [dx, setDx] = useState(0);
	const [dragging, setDragging] = useState(false);
	const dragRef = useRef<{ sx: number; sy: number; moved: boolean } | null>(null);
	const count = items.length;
	const next = (): void => setIndex(i => (i + 1) % count);

	const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
		dragRef.current = { sx: e.clientX, sy: e.clientY, moved: false };
		e.currentTarget.setPointerCapture(e.pointerId);
		setDragging(true);
	};
	const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
		const d = dragRef.current;
		if (!d) return;
		const x = e.clientX - d.sx;
		if (!d.moved && (Math.abs(x) > 6 || Math.abs(e.clientY - d.sy) > 6)) d.moved = true;
		setDx(x);
	};
	const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
		const d = dragRef.current;
		dragRef.current = null;
		setDragging(false);
		if (!d) return;
		if (d.moved && Math.abs(dx) > 56) {
			// Flick past the threshold → next card (wrap), then settle.
			setDx(0);
			setTimeout(next, 0);
			return;
		}
		setDx(0);
		if (!d.moved) onOpen(index, gallery, e.currentTarget.querySelector<HTMLElement>("img"));
	};

	return (
		<div className="tr-img-stack" role="group" aria-label={t("settings.previewImage")}>
			{resolved.map((item, i) => {
				const pos = (((i - index + count) % count) + count) % count;
				const depth = count > 1 ? pos / (count - 1) : 0;
				const ease = depth * depth;
				const lift = (count - 1) * 12 * 0.45;
				const style = {
					zIndex: count - pos,
					transform: `translate(-50%, -50%) translateY(${pos * 12 - lift}px) scale(${1 - 0.16 * ease}) rotate(${Math.sin(i * 2.399) * 4}deg)`,
				};
				if (pos === 0 && dragging)
					style.transform = `translate(-50%, -50%) translate(${dx}px, ${-lift}px) scale(1)`;
				return (
					<div
						key={i}
						className={`tr-img-stack-card${pos === 0 ? " tr-img-stack-card--top" : ""}${dragging && pos === 0 ? " tr-img-stack-card--drag" : ""}`}
						style={style}
						role={pos === 0 ? "button" : undefined}
						tabIndex={pos === 0 ? 0 : -1}
						title={pos === 0 ? t("settings.previewImage") : undefined}
						aria-hidden={pos !== 0}
						onPointerDown={pos === 0 ? onPointerDown : undefined}
						onPointerMove={pos === 0 ? onPointerMove : undefined}
						onPointerUp={pos === 0 ? onPointerUp : undefined}
						onPointerCancel={pos === 0 ? onPointerUp : undefined}
						onKeyDown={
							pos === 0
								? (e: React.KeyboardEvent<HTMLDivElement>) => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault();
											onOpen(index, gallery);
										} else if (e.key === "ArrowRight") {
											next();
										} else if (e.key === "ArrowLeft") {
											setIndex(i => (i - 1 + count) % count);
										}
									}
								: undefined
						}
					>
						<img src={item.src} alt={item.alt} draggable={false} loading="lazy" decoding="async" />
					</div>
				);
			})}
			<div className="tr-img-stack-count" aria-hidden="true">
				{index + 1} / {count}
			</div>
		</div>
	);
}
