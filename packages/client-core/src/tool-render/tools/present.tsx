/** `present` — files declared as final deliverables. */
import { type ReactNode, useState } from "react";
import { t } from "../../i18n/index.js";
import { Badge, Note } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, homePath, isRecord, normalizeWs, str, truncate } from "../util";

interface PresentedFile {
	path: string;
	description?: string;
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
	return extension ? extension.toUpperCase().slice(0, 6) : "FILE";
}

/** Details win once the call finished; args keep the card useful while streaming. */
function filesOf(args: ToolRenderProps["args"], result: ToolRenderProps["result"]): PresentedFile[] {
	const details = detailsRecord(result);
	const source = Array.isArray(details?.files) ? details.files : Array.isArray(args.files) ? args.files : [];
	const files: PresentedFile[] = [];
	const seen = new Set<string>();
	for (const entry of source) {
		if (!isRecord(entry)) continue;
		const path = str(entry.path);
		if (path === null || path === "" || seen.has(path)) continue;
		seen.add(path);
		const description = str(entry.description);
		files.push({ path, ...(description ? { description } : {}) });
	}
	return files;
}

function Summary({ args, result, running }: ToolRenderProps): ReactNode {
	const files = filesOf(args, result);
	if (files.length === 0) {
		return <span>{running ? t("tools.presentPreparing") : t("tools.presentNone")}</span>;
	}
	const first = files[0]!;
	return (
		<>
			<Badge>{t("tools.presentedFilesWithCount", { count: String(files.length) })}</Badge>{" "}
			<span>{truncate(first.description ?? basename(first.path), 64)}</span>
		</>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const files = filesOf(args, result);
	const [expanded, setExpanded] = useState(false);
	if (files.length === 0) return <Note>{t("tools.presentNone")}</Note>;
	const shown = expanded ? files : files.slice(0, COLLAPSED_FILES);
	return (
		<div className="tv-present">
			<div className="tv-present-grid">
				{shown.map(file => (
					<div className="tv-present-card" key={file.path} title={file.path}>
						<span className="tv-present-icon" aria-hidden="true">
							{fileType(file.path)}
						</span>
						<span className="tv-present-body">
							<span className="tv-present-name">{basename(file.path)}</span>
							<span className="tv-present-desc">
								{file.description ? truncate(normalizeWs(file.description), 160) : t("tools.presentDelivered")}
							</span>
							<span className="tv-present-path">{homePath(file.path)}</span>
						</span>
					</div>
				))}
			</div>
			{files.length > COLLAPSED_FILES && (
				<button type="button" className="tv-present-toggle" onClick={() => setExpanded(value => !value)}>
					{expanded
						? t("tools.presentShowLess")
						: t("tools.presentShowAllWithCount", { count: String(files.length) })}
				</button>
			)}
			<span className="tv-present-note">{t("tools.presentAfterTurn")}</span>
		</div>
	);
}

export const presentRenderer: ToolRenderer = { Summary, Body };
