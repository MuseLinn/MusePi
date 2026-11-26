import { ImageOff } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
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
 *
 * A card whose bytes are gone (an expired `blob:sha256:` ref, a rejected
 * data URL) keeps its place but paints the unavailable face instead of the
 * browser's broken-image glyph, and stops being a target: it never opens
 * the lightbox, and the stack rests on the next image that can still be
 * shown so a dead card cannot trap the swipe.
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
	const count = items.length;
	// srcs that failed to decode. Keyed by src, not by slot, so resolving a ref
	// later (a new src) starts clean and a stale entry can never match.
	const [missing, setMissing] = useState<ReadonlySet<string>>(() => new Set());
	const [index, setIndex] = useState(0);
	const [dx, setDx] = useState(0);
	const [dragging, setDragging] = useState(false);
	const dragRef = useRef<{ sx: number; sy: number; moved: boolean } | null>(null);

	const isMissing = (item: BlobImageItem): boolean => missing.has(item.src);
	// Slots that can still be shown — the only ones the gallery offers. Built on
	// every render (the lists are per-message and tiny) so `missing` cannot be
	// read through a stale memo.
	const shown = resolved.map((item, i) => ({ item, i })).filter(({ item }) => !missing.has(item.src));
	const shownIndices = shown.map(entry => entry.i);
	// The gallery the lightbox receives: resolved, and never a dead ref.
	const gallery = shown.map(({ item }) => ({ src: item.src, alt: item.alt }));
	const top = count === 0 ? 0 : index % count;
	// Position of the top card in the showable list; -1 while the effect below
	// is still moving it off a dead slot.
	const topAt = shownIndices.indexOf(top);

	// Rest on a showable card: a failure discovered after mount (or a stale
	// index from a replaced message) must not leave the dead card on top, where
	// it would swallow the tap and hide the images that still work.
	useEffect(() => {
		if (shownIndices.length === 0) return;
		if (!shownIndices.includes(top)) {
			const firstAfter = shownIndices.find(i => i > top);
			setIndex(firstAfter ?? shownIndices[0]);
		}
	}, [shownIndices, top]);

	const step = (delta: 1 | -1): void => {
		if (shownIndices.length === 0) return;
		const from = topAt === -1 ? 0 : topAt;
		setIndex(shownIndices[(from + delta + shownIndices.length) % shownIndices.length]);
	};

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
			setTimeout(() => step(1), 0);
			return;
		}
		setDx(0);
		// Open on the current card's slot in the gallery, which skips the dead
		// ones, so the lightbox starts on the picture the tap showed.
		if (!d.moved) {
			if (topAt !== -1) onOpen(topAt, gallery, e.currentTarget.querySelector<HTMLElement>("img"));
		}
	};

	return (
		<div className="tr-img-stack" role="group" aria-label={t("settings.previewImage")}>
			{resolved.map((item, i) => {
				const pos = (((i - top + count) % count) + count) % count;
				const depth = count > 1 ? pos / (count - 1) : 0;
				const ease = depth * depth;
				const lift = (count - 1) * 12 * 0.45;
				const dead = isMissing(item);
				// A dead card is inert at every depth: it has nothing to drag or
				// open, so it never claims the cursor or the keyboard.
				const interactive = pos === 0 && !dead;
				const style = {
					zIndex: count - pos,
					transform: `translate(-50%, -50%) translateY(${pos * 12 - lift}px) scale(${1 - 0.16 * ease}) rotate(${Math.sin(i * 2.399) * 4}deg)`,
				};
				if (pos === 0 && dragging)
					style.transform = `translate(-50%, -50%) translate(${dx}px, ${-lift}px) scale(1)`;
				return (
					<div
						key={i}
						className={`tr-img-stack-card${pos === 0 ? " tr-img-stack-card--top" : ""}${
							dragging && pos === 0 ? " tr-img-stack-card--drag" : ""
						}${dead ? " tr-img-stack-card--missing" : ""}`}
						style={style}
						role={interactive ? "button" : undefined}
						tabIndex={interactive ? 0 : -1}
						title={interactive ? t("settings.previewImage") : undefined}
						aria-hidden={pos !== 0}
						onPointerDown={interactive ? onPointerDown : undefined}
						onPointerMove={interactive ? onPointerMove : undefined}
						onPointerUp={interactive ? onPointerUp : undefined}
						onPointerCancel={interactive ? onPointerUp : undefined}
						onKeyDown={
							interactive
								? (e: React.KeyboardEvent<HTMLDivElement>) => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault();
											if (topAt !== -1) onOpen(topAt, gallery);
										} else if (e.key === "ArrowRight") {
											step(1);
										} else if (e.key === "ArrowLeft") {
											step(-1);
										}
									}
								: undefined
						}
					>
						{dead ? (
							<span className="tr-img-stack-missing">
								<ImageOff size={18} aria-hidden="true" />
								<span>{t("tools.imageUnavailable")}</span>
							</span>
						) : (
							<img
								src={item.src}
								alt={item.alt}
								draggable={false}
								loading="lazy"
								decoding="async"
								onError={() => setMissing(prev => new Set(prev).add(item.src))}
							/>
						)}
					</div>
				);
			})}
			{topAt !== -1 && (
				<div className="tr-img-stack-count" aria-hidden="true">
					{topAt + 1} / {shown.length}
				</div>
			)}
		</div>
	);
}
