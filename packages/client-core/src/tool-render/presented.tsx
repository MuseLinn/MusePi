/** Delivery card shared by the `present` tool row and the turn tail. */
import { type ReactNode, useState } from "react";
import { t } from "../i18n/index.js";
import type { ToolRenderHost } from "./types";
import { homePath, isRecord, normalizeWs, str, truncate } from "./util";

export interface PresentedFile {
	path: string;
	description?: string;
}

/** Custom-entry type of the durable declaration written by the `present` tool. */
export const PRESENTED_DELIVERABLES_TYPE = "deliverables/presented";

/** Files recorded in one `deliverables/presented` custom entry. */
export function presentedFilesFromEntry(data: unknown): PresentedFile[] {
	if (!isRecord(data) || !Array.isArray(data.files)) return [];
	return parsePresentedFiles(data.files);
}

const COLLAPSED_FILES = 4;

function basename(path: string): string {
	const parts = path.replaceAll("\\", "/").split("/");
	return parts[parts.length - 1] ?? path;
}

function fileType(path: string): string {
	const name = basename(path);
	const dot = name.lastIndexOf(".");
	const extension = dot > 0 ? name.slice(dot + 1) : "";
	return extension ? extension.toUpperCase().slice(0, 6) : t("tools.presentFileBadge");
}

/** Parse `{ path, description? }[]`; a later duplicate keeps its last description. */
export function parsePresentedFiles(value: unknown): PresentedFile[] {
	if (!Array.isArray(value)) return [];
	const files: PresentedFile[] = [];
	const index = new Map<string, number>();
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const path = str(entry.path);
		if (path === null || path === "") continue;
		const description = str(entry.description);
		const file: PresentedFile = { path, ...(description ? { description } : {}) };
		const seen = index.get(path);
		if (seen !== undefined) {
			files[seen] = file;
			continue;
		}
		index.set(path, files.length);
		files.push(file);
	}
	return files;
}

/**
 * Delivery cards: a two-column grid (one file spans the row), collapsed after
 * four. Actions appear only when the host can open files; a pending action
 * disables every action on the card, and a failure stays visible until retry.
 */
export function PresentFilesCard({
	files,
	host,
	note = true,
}: {
	files: readonly PresentedFile[];
	host?: ToolRenderHost;
	note?: boolean;
}): ReactNode {
	const [expanded, setExpanded] = useState(false);
	const [pending, setPending] = useState<{ key: string; action: "open" | "reveal" } | null>(null);
	const [errors, setErrors] = useState<Record<string, string>>({});
	if (files.length === 0) return null;
	const shown = expanded ? files : files.slice(0, COLLAPSED_FILES);
	const openFile = host?.openFile;
	const revealFile = host?.revealFile;
	const run = async (action: "open" | "reveal", file: PresentedFile): Promise<void> => {
		const open = action === "open" ? openFile : revealFile;
		if (!open) return;
		const key = `${action}:${file.path}`;
		setPending({ key, action });
		setErrors(previous => {
			const next = { ...previous };
			delete next[file.path];
			return next;
		});
		try {
			const result = await open(file.path);
			if (!result.ok) throw new Error(result.error ?? "failed");
		} catch (error) {
			setErrors(previous => ({
				...previous,
				[file.path]: error instanceof Error ? error.message : String(error),
			}));
		} finally {
			setPending(null);
		}
	};
	return (
		<div className="tv-present">
			<div className="tv-present-grid">
				{shown.map(file => {
					const openKey = `open:${file.path}`;
					const revealKey = `reveal:${file.path}`;
					const error = errors[file.path];
					return (
						<div className="tv-present-card" key={file.path} title={file.path}>
							<span className="tv-present-icon" aria-hidden="true">
								{fileType(file.path)}
							</span>
							<span className="tv-present-body">
								<span className="tv-present-name">{basename(file.path)}</span>
								<span className="tv-present-desc">
									{file.description
										? truncate(normalizeWs(file.description), 160)
										: t("tools.presentDelivered")}
								</span>
								<span className="tv-present-path">{homePath(file.path)}</span>
								{(openFile || revealFile) && (
									<span className="tv-present-actions">
										{openFile && (
											<button
												type="button"
												className="tv-present-action"
												disabled={pending !== null}
												aria-busy={pending?.key === openKey}
												onClick={() => void run("open", file)}
											>
												{pending?.key === openKey ? t("tools.presentOpening") : t("tools.presentOpen")}
											</button>
										)}
										{revealFile && (
											<button
												type="button"
												className="tv-present-action"
												disabled={pending !== null}
												aria-busy={pending?.key === revealKey}
												onClick={() => void run("reveal", file)}
											>
												{pending?.key === revealKey ? t("tools.presentOpening") : t("tools.presentReveal")}
											</button>
										)}
									</span>
								)}
								{error && <span className="tv-present-error">{error}</span>}
							</span>
						</div>
					);
				})}
			</div>
			{files.length > COLLAPSED_FILES && (
				<button type="button" className="tv-present-toggle" onClick={() => setExpanded(value => !value)}>
					{expanded
						? t("tools.presentShowLess")
						: t("tools.presentShowAllWithCount", { count: String(files.length) })}
				</button>
			)}
			{note && <span className="tv-present-note">{t("tools.presentAfterTurn")}</span>}
		</div>
	);
}
