/**
 * `computer` — desktop control (TUI computer-renderer parity): the executed
 * action code + permission/read-only status. Screenshots arrive as data
 * URLs (or file paths) in `details.screenshots`; the transcript's ToolCard
 * hoists them inline below the card (craft-agents media parity), blanking
 * them out of the card result with a `screenshotCount` fallback so this
 * summary stays truthful. Standalone views (HTML exports) keep the grid.
 */
import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { Badge, Badges, KvGrid, Kv, Note, Output, Row } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, str } from "../util";

interface ComputerShot {
	path?: string;
	width?: number;
	height?: number;
	target?: string;
}

function shotsOf(args: Record<string, unknown>, result: ToolRenderProps["result"]): ComputerShot[] {
	const details = detailsRecord(result);
	const raw = details?.screenshots;
	return Array.isArray(raw) ? (raw.filter((s): s is ComputerShot => !!s && typeof s === "object") as ComputerShot[]) : [];
}

function srcOf(shot: ComputerShot): string | null {
	const tgt = typeof shot.target === "string" ? shot.target : "";
	if (tgt.startsWith("data:")) return tgt;
	if (typeof shot.path === "string" && shot.path.length > 0) return `file://${shot.path}`;
	return tgt || null;
}

function Summary({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const shots = shotsOf(args, result);
	const parts: string[] = [];
	if (details?.readOnly === true || args?.read_only === true) parts.push(t("computer read-only"));
	if (typeof details?.backend === "string" && details.backend) parts.push(details.backend);
	const shotCount =
		shots.length > 0
			? shots.length
			: typeof details?.screenshotCount === "number" && details.screenshotCount > 0
				? details.screenshotCount
				: 0;
	parts.push(
		shotCount > 0 ? t("computer screenshots {count}", { count: String(shotCount) }) : t("computer no screenshots"),
	);
	const code = typeof args?.code === "string" ? args.code : typeof details?.code === "string" ? details.code : "";
	return (
		<>
			<Badges items={parts} />
			{code && <div className="tv-kv-line">{code}</div>}
		</>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const shots = shotsOf(args, result);
	const code = typeof args?.code === "string" ? args.code : typeof details?.code === "string" ? details.code : "";
	const error = result?.isError === true;
	const perms: Array<[string, string]> = [];
	for (const key of ["capturePermission", "inputPermission", "axPermission"] as const) {
		const v = str(details?.[key]);
		if (v) perms.push([key, v]);
	}
	return (
		<>
			{shots.length > 0 && (
				<div className="tv-imgs">
					{shots.map((shot, i) => {
						const src = srcOf(shot);
						if (!src) return null;
						return (
							<img
								key={i}
								className="tv-img"
								src={src}
								alt={t("computer screenshot {count}", { count: String(i + 1) })}
								loading="lazy"
								decoding="async"
							/>
						);
					})}
				</div>
			)}
			{code && (
				<Output
					text={code}
					maxLines={8}
					lang="js"
					title={t("computer action")}
					error={error}
					variant="code"
				/>
			)}
			{details?.returnValue !== undefined && str(details.returnValue) !== "" && (
				<Row k={t("return value")}>{str(details.returnValue)}</Row>
			)}
			{perms.length > 0 && (
				<KvGrid>
					{perms.map(([k, v]) => (
						<Kv key={k} k={k}>
							{v}
						</Kv>
					))}
				</KvGrid>
			)}
			{error && <Note tone="err">{t("computer failed")}</Note>}
		</>
	);
}

export const computerRenderer: ToolRenderer = {
	Summary,
	Body,
};
