/** `web_search` — provider-backed web search with synthesized answer and sources. */
import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { Badge, Badges, InvalidArg, Kv, KvGrid, Note, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, normalizeWs, num, resultTextOf, str, truncate } from "../util";

function getDomain(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}

function formatAge(seconds: unknown): string {
	const s = num(seconds);
	if (s === null || s < 0) return "";
	const m = Math.floor(s / 60);
	if (m < 60) return t("{count}m ago", { count: String(m) });
	const h = Math.floor(m / 60);
	if (h < 24) return t("{count}h ago", { count: String(h) });
	const d = Math.floor(h / 24);
	if (d < 365) return t("{count}d ago", { count: String(d) });
	return t("{count}y ago", { count: String(Math.floor(d / 365)) });
}

function Summary({ args }: ToolRenderProps): ReactNode {
	const query = str(args.query);
	const recency = str(args.recency);
	return (
		<>
			{query === null ? (
				<InvalidArg what="query" />
			) : (
				<span className="tv-pattern">{truncate(normalizeWs(query), 80)}</span>
			)}
			{recency && <Badge>{recency}</Badge>}
		</>
	);
}

function SourceRow({ source }: { source: Record<string, unknown> }): ReactNode {
	const url = str(source.url) ?? "";
	const title = str(source.title)?.trim() || url || t("Untitled");
	const domain = url ? getDomain(url) : url;
	const age = formatAge(source.ageSeconds) || (str(source.publishedDate) ?? "");
	// aicss web-search compact list: title-ish first line highlighted,
	// URL/domain-ish second line dimmed.
	return (
		<li className="tr-tool-search-row">
			{url ? (
				<a className="tr-tool-search-title" href={url} rel="noreferrer" target="_blank">
					{title}
				</a>
			) : (
				<span className="tr-tool-search-title">{title}</span>
			)}
			<span className="tr-tool-search-url">
				{domain}
				{age && ` · ${age}`}
			</span>
		</li>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const query = str(args.query);
	const recency = str(args.recency);
	const limit = num(args.limit);
	const numResults = num(args.num_search_results);

	const details = detailsRecord(result);
	const response = details && isRecord(details.response) ? details.response : null;
	const errorMsg = details ? str(details.error) : null;
	const provider = response ? str(response.provider) : null;
	const model = response ? str(response.model) : null;
	const authMode = response ? str(response.authMode) : null;
	const sources: Record<string, unknown>[] =
		response && Array.isArray(response.sources) ? response.sources.filter(isRecord) : [];

	let providerInfo = model && provider ? `${model} @ ${provider}` : (model ?? provider ?? "");
	if (providerInfo && authMode) {
		providerInfo += ` (${authMode === "oauth" ? t("OAuth") : authMode === "api_key" ? t("API") : authMode})`;
	}

	const usage = response && isRecord(response.usage) ? response.usage : null;
	const usageParts: string[] = [];
	if (usage) {
		const inTok = num(usage.inputTokens);
		const outTok = num(usage.outputTokens);
		const totalTok = num(usage.totalTokens);
		const searchReqs = num(usage.searchRequests);
		if (inTok !== null) usageParts.push(t("input {count}", { count: String(inTok) }));
		if (outTok !== null) usageParts.push(t("output {count}", { count: String(outTok) }));
		if (totalTok !== null) usageParts.push(t("total {count}", { count: String(totalTok) }));
		if (searchReqs !== null) usageParts.push(t("search {count}", { count: String(searchReqs) }));
	}

	return (
		<>
			<Badges
				items={[
					recency && t("recency={value}", { value: recency }),
					limit !== null && t("limit={count}", { count: String(limit) }),
					numResults !== null && t("results={count}", { count: String(numResults) }),
					response && t("{count} source(s)", { count: String(sources.length) }),
				]}
			/>
			{(query !== null || providerInfo || usageParts.length > 0) && (
				<KvGrid>
					{query !== null && <Kv k={t("query")}>{query}</Kv>}
					{providerInfo && <Kv k={t("provider")}>{providerInfo}</Kv>}
					{usageParts.length > 0 && <Kv k={t("usage")}>{usageParts.join(" · ")}</Kv>}
				</KvGrid>
			)}
			{errorMsg && !resultTextOf(result) && <Note tone="err">{errorMsg}</Note>}
			<ResultText result={result} maxLines={14} lang="markdown" />
			{sources.length > 0 && (
				<ul className="tr-tool-search">
					{sources.map((source, i) => (
						<SourceRow key={str(source.url) ?? i} source={source} />
					))}
				</ul>
			)}
		</>
	);
}

export const webSearchRenderer: ToolRenderer = { Summary, Body };
