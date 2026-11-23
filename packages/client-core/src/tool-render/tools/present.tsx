/** `present` — the compact tool row; the full delivery card lives at the turn tail. */
import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { Badge } from "../parts";
import { parsePresentedFiles } from "../presented";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord } from "../util";

function countOf(args: ToolRenderProps["args"], result: ToolRenderProps["result"]): number {
	const details = detailsRecord(result);
	const source = Array.isArray(details?.files) ? details.files : Array.isArray(args.files) ? args.files : [];
	return parsePresentedFiles(source).length;
}

function Summary({ args, result, running }: ToolRenderProps): ReactNode {
	const count = countOf(args, result);
	if (count === 0) {
		return <span>{running ? t("tools.presentPreparing") : t("tools.presentNone")}</span>;
	}
	return <Badge>{t("tools.presentedFilesWithCount", { count: String(count) })}</Badge>;
}

export const presentRenderer: ToolRenderer = { Summary };
