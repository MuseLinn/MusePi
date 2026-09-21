import type { ReactNode } from "react";
import { useState } from "react";
import { t } from "../i18n/index.js";

/**
 * Accordion gallery (reactbits accordion-gallery parity + kimi 画览):
 * horizontal items; the active one expands with a smooth flex-grow —
 * clicking swaps the expanded slot. Items carry a title and optional
 * image URL; missing images render gradient placeholders so the card
 * works fully offline.
 */
export interface GalleryItem {
	title: string;
	url?: string;
}

export function GalleryCard({
	data,
	update,
}: {
	data: Record<string, unknown>;
	update(patch: Record<string, unknown>): void;
}): ReactNode {
	const raw = Array.isArray(data.items) ? (data.items as unknown[]) : [];
	const items = raw.filter(
		(it): it is GalleryItem => typeof it === "object" && it !== null && typeof (it as GalleryItem).title === "string",
	);
	const [active, setActive] = useState(0);
	if (items.length === 0) {
		return <div className="gui-widget-gallery-empty">{t("widget gallery empty")}</div>;
	}
	return (
		<div className="gui-widget-gallery">
			{items.map((it, i) => (
				<button
					type="button"
					key={`${it.title}-${i}`}
					className={`gui-widget-gallery-item${active === i ? " gui-widget-gallery-item--active" : ""}`}
					style={it.url ? { backgroundImage: `url(${it.url})` } : undefined}
					onClick={() => setActive(i)}
					aria-expanded={active === i}
				>
					<span className="gui-widget-gallery-title">{it.title}</span>
				</button>
			))}
		</div>
	);
}
