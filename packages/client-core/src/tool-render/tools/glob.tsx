/** `glob` (legacy `find`) — glob-based file finder; results are paths sorted by mtime. */
import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { Badge, Badges, InvalidArg, Note, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, homePath, isRecord, num, scopePaths, str, truncate } from "../util";

function Summary({ args }: ToolRenderProps): ReactNode {
	const raw = args.path ?? args.paths;
	if (raw !== undefined && typeof raw !== "string" && !Array.isArray(raw)) return <InvalidArg what="path" />;
	const globs = scopePaths(args).map(homePath).join(", ");
	return <span className="tv-pattern">{truncate(globs || "*", 120)}</span>;
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const limit = num(args.limit);
	const timeout = num(args.timeout);
	const fileCount = num(details?.fileCount);
	const resultLimit = num(details?.resultLimitReached);
	const scopePath = str(details?.scopePath);
	const error = str(details?.error);
	const meta = details && isRecord(details.meta) ? details.meta : null;
	const limits = meta && isRecord(meta.limits) ? meta.limits : null;
	const truncated =
		Boolean(details?.truncated) ||
		resultLimit !== null ||
		(details !== null && isRecord(details.truncation)) ||
		(meta !== null && isRecord(meta.truncation)) ||
		Boolean(limits?.resultLimit);
	const missing = Array.isArray(details?.missingPaths)
		? details.missingPaths.filter((p): p is string => typeof p === "string")
		: [];

	return (
		<>
			<Badges
				items={[
					limit !== null && <Badge>{t("tools.limitWithCount", { count: String(limit) })}</Badge>,
					args.gitignore === false && <Badge>{t("tools.noGitignore")}</Badge>,
					args.hidden === false && <Badge>{t("tools.noHidden")}</Badge>,
					timeout !== null && <Badge>{t("tools.timeoutSWithSecs", { secs: String(timeout) })}</Badge>,
					fileCount !== null && <Badge tone="accent">{t("tools.fileWithCount", { count: String(fileCount) })}</Badge>,
					scopePath !== null && <Badge>{t("tools.inWithPath", { path: homePath(scopePath) })}</Badge>,
					truncated && (
						<Badge tone="warn">
							{resultLimit !== null ? t("tools.truncatedAtWithCount", { count: String(resultLimit) }) : t("tools.truncated")}
						</Badge>
					),
				]}
			/>
			{missing.length > 0 && (
				<Note tone="warn">{t("tools.skippedMissingWithPath", { path: missing.map(homePath).join(", ") })}</Note>
			)}
			{error !== null && !result?.isError && <Note tone="err">{error}</Note>}
			<ResultText result={result} maxLines={12} />
		</>
	);
}

export const globRenderer: ToolRenderer = { Summary, Body };
