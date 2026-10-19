/** `ast_edit` — structural AST rewrites: per-op pattern/replacement pairs, replacement counts, diffs. */
import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { Badge, CodeBlock, DiffBlock, InvalidArg, Note, Output, PathText, ResultText, Row } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, homePath, isRecord, languageFromPath, num, str } from "../util";

interface AstEditOp {
	pat: string;
	out: string;
}

interface AstEditDetails {
	totalReplacements: number | null;
	filesTouched: number | null;
	filesSearched: number | null;
	limitReached: boolean;
	scopePath: string | null;
	fileReplacements: Array<{ path: string; count: number | null }>;
	parseErrors: string[];
	parseErrorsTotal: number | null;
	displayContent: string | null;
}

function pathsOf(args: Record<string, unknown>): string[] {
	if (!Array.isArray(args.paths)) return [];
	const paths: string[] = [];
	for (const p of args.paths) {
		const s = str(p);
		if (s) paths.push(s);
	}
	return paths;
}

function opsOf(args: Record<string, unknown>): AstEditOp[] {
	if (!Array.isArray(args.ops)) return [];
	const ops: AstEditOp[] = [];
	for (const op of args.ops) {
		if (!isRecord(op)) continue;
		ops.push({ pat: str(op.pat) ?? "", out: str(op.out) ?? "" });
	}
	return ops;
}

function detailsOf(result: ToolRenderProps["result"]): AstEditDetails | null {
	const d = detailsRecord(result);
	if (!d) return null;
	const fileReplacements: AstEditDetails["fileReplacements"] = [];
	if (Array.isArray(d.fileReplacements)) {
		for (const fr of d.fileReplacements) {
			if (!isRecord(fr)) continue;
			const path = str(fr.path);
			if (path) fileReplacements.push({ path, count: num(fr.count) });
		}
	}
	const parseErrors: string[] = [];
	if (Array.isArray(d.parseErrors)) {
		for (const e of d.parseErrors) {
			const s = str(e);
			if (s) parseErrors.push(s);
		}
	}
	return {
		totalReplacements: num(d.totalReplacements),
		filesTouched: num(d.filesTouched),
		filesSearched: num(d.filesSearched),
		limitReached: d.limitReached === true,
		scopePath: str(d.scopePath),
		fileReplacements,
		parseErrors,
		parseErrorsTotal: num(d.parseErrorsTotal),
		displayContent: str(d.displayContent),
	};
}

function Summary({ args, result }: ToolRenderProps): ReactNode {
	const paths = pathsOf(args);
	const first = paths[0];
	const opCount = Array.isArray(args.ops) ? args.ops.length : 0;
	const details = detailsOf(result);
	const total = details?.totalReplacements;
	return (
		<>
			{first ? <PathText path={first} /> : <InvalidArg what="paths" />}
			{paths.length > 1 && (
				<span className="tv-faint">
					+{paths.length - 1} {t("tools.more")}
				</span>
			)}
			<Badge tone="accent">{t("tools.opWithCount", { count: String(opCount) })}</Badge>
			{total != null && (
				<Badge tone={total > 0 ? "ok" : "warn"}>{t("tools.replacementWithCount", { count: String(total) })}</Badge>
			)}
			{details?.limitReached && <Badge tone="warn">{t("tools.limit")}</Badge>}
		</>
	);
}

function OpCell({ op, lang }: { op: AstEditOp; lang: string | null }): ReactNode {
	return (
		<div className="tv-cell">
			{op.pat ? (
				<CodeBlock code={op.pat} lang={lang} title={t("tools.pattern")} maxLines={10} />
			) : (
				<InvalidArg what="pattern" />
			)}
			{op.out ? (
				<CodeBlock code={op.out} lang={lang} title={t("tools.replacement")} maxLines={10} />
			) : (
				<div className="tv-muted">{t("tools.deletionMatchedCodeRemoved")}</div>
			)}
		</div>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const paths = pathsOf(args);
	const first = paths[0];
	const ops = opsOf(args);
	const details = result?.isError ? null : detailsOf(result);
	const lang = first ? languageFromPath(first) : null;
	const parseErrorsTotal = details ? (details.parseErrorsTotal ?? details.parseErrors.length) : 0;
	return (
		<>
			{paths.length > 1 && (
				<div className="tv-list">
					{paths.map((p, i) => (
						<Row key={i}>
							<PathText path={p} />
						</Row>
					))}
				</div>
			)}
			{ops.length > 0 && (
				<div className="tv-cells">
					{ops.map((op, i) => (
						<OpCell key={i} op={op} lang={lang} />
					))}
				</div>
			)}
			{details && (
				<span className="tv-badges">
					{details.totalReplacements != null && (
						<Badge tone={details.totalReplacements > 0 ? "ok" : "warn"}>
							{t("tools.replacementWithCount", { count: String(details.totalReplacements) })}
						</Badge>
					)}
					{details.filesTouched != null && (
						<Badge>{t("tools.fileWithCount", { count: String(details.filesTouched) })}</Badge>
					)}
					{details.filesSearched != null && (
						<Badge>{t("tools.searchedWithCount", { count: String(details.filesSearched) })}</Badge>
					)}
					{details.scopePath && <Badge>{t("tools.inWithPath", { path: homePath(details.scopePath) })}</Badge>}
					{details.limitReached && <Badge tone="warn">{t("tools.limitReached")}</Badge>}
				</span>
			)}
			{details && details.fileReplacements.length > 0 && (
				<div className="tv-list">
					{details.fileReplacements.map((fr, i) => (
						<Row key={i} k={fr.count != null ? `×${fr.count}` : undefined}>
							<PathText path={fr.path} />
						</Row>
					))}
				</div>
			)}
			{details?.limitReached && <Note tone="warn">{t("tools.limitReachedNarrowPath")}</Note>}
			{details && details.parseErrors.length > 0 && (
				<Output
					text={details.parseErrors.join("\n")}
					maxLines={6}
					title={t("tools.parseIssuesWithCount", { count: String(parseErrorsTotal) })}
					variant="plain"
				/>
			)}
			{details?.displayContent ? (
				<DiffBlock diff={details.displayContent} maxLines={40} />
			) : (
				<ResultText result={result} maxLines={12} />
			)}
		</>
	);
}

export const astEditRenderer: ToolRenderer = { Summary, Body };
