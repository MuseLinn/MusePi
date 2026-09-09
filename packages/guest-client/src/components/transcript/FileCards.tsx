/**
 * ZCode-style artifact cards: the final files a turn produced, rendered as
 * compact chips under the assistant message — preview in the right panel,
 * copy the path, or open in the system default app.
 *
 * The desktop GUI listens for the `omp-open-file` window event (ChatView);
 * guests / exports render the buttons inert.
 */
import type { ReactNode } from "react";
import { memo } from "react";
import { t } from "../../i18n/index.js";
import { electronBridge } from "../../lib/electron-bridge";

export interface FileCardItem {
	id: string;
	path: string;
}

/** Preview a file in the GUI right panel (desktop); no-op elsewhere. */
export function openFileInPanel(path: string): void {
	window.dispatchEvent(new CustomEvent("omp-open-file", { detail: { path } }));
}

export function openFileExternally(path: string): void {
	const bridge = electronBridge();
	void bridge?.openWith?.("", path);
}

async function copyPath(path: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(path);
	} catch {
		// clipboard unavailable (non-secure context) — nothing sensible to do
	}
}

function baseName(path: string): string {
	const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return idx >= 0 ? path.slice(idx + 1) : path;
}

/** `src/foo.tsx` → `TSX`, `notes.md` → `MD`, no ext → `` */
function extBadge(path: string): string {
	const name = baseName(path);
	const dot = name.lastIndexOf(".");
	if (dot <= 0 || dot === name.length - 1) return "";
	return name
		.slice(dot + 1)
		.toUpperCase()
		.slice(0, 6);
}

export const FileCards = memo(function FileCards({ items }: { items: FileCardItem[] }): ReactNode | null {
	if (items.length === 0) return null;
	return (
		<div className="tr-file-cards" role="list" aria-label={t("files created")}>
			{items.map(item => {
				const badge = extBadge(item.path);
				return (
					<div key={item.path} className="tr-file-card" role="listitem">
						<span className="tr-file-card-top">
							<span className="tr-file-card-badge" aria-hidden="true">
								{badge || "•"}
							</span>
							<span className="tr-file-card-name" title={item.path}>
								{baseName(item.path)}
							</span>
						</span>
						<span className="tr-file-card-path" title={item.path}>
							{item.path}
						</span>
						<span className="tr-file-card-actions">
							<button
								type="button"
								className="tr-file-card-btn"
								title={t("preview in right panel")}
								onClick={() => openFileInPanel(item.path)}
							>
								{t("open preview")}
							</button>
							<button
								type="button"
								className="tr-file-card-btn"
								title={t("copy path")}
								onClick={() => void copyPath(item.path)}
							>
								{t("copy path")}
							</button>
							<button
								type="button"
								className="tr-file-card-btn"
								title={t("open with app")}
								onClick={() => openFileExternally(item.path)}
							>
								{t("open")}
							</button>
						</span>
					</div>
				);
			})}
		</div>
	);
});
