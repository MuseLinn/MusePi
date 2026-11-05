/** `select_tools` — progressive tool disclosure: the model loads deferred tool
 *  schemas by name before calling them. The summary names the requested tools;
 *  the result text (loaded / already available / unknown) stays in the body. */
import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { Badge, Badges, InvalidArg, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { normalizeWs, str, truncate } from "../util";

/** Requested names: the `names` array, or a single string while the call streams. */
function namesOf(args: Record<string, unknown>): string[] {
	const raw = args.names;
	if (Array.isArray(raw)) {
		return raw.filter((name): name is string => typeof name === "string" && name.length > 0);
	}
	const single = str(raw) ?? str(args.name);
	return single === null || single === "" ? [] : [single];
}

/** Names shown inline before the count badge takes over. */
const SUMMARY_NAMES = 3;

function Summary({ args }: ToolRenderProps): ReactNode {
	const names = namesOf(args);
	if (names.length === 0) return <InvalidArg what="names" />;
	return (
		<>
			<span className="tv-pattern">{truncate(normalizeWs(names.slice(0, SUMMARY_NAMES).join(", ")), 80)}</span>
			{names.length > SUMMARY_NAMES && (
				<Badge tone="accent">{t("tools.toolsWithCount", { count: String(names.length) })}</Badge>
			)}
		</>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const names = namesOf(args);
	return (
		<>
			{names.length > 0 && <Badges items={names} />}
			<ResultText result={result} maxLines={12} />
		</>
	);
}

export const selectToolsRenderer: ToolRenderer = { Summary, Body };
