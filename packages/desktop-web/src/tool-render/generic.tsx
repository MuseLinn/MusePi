/** Fallback renderer for tools without a dedicated view. */
import type { ReactNode } from "react";
import { t } from "../i18n/index.js";
import { DiffBlock, Output, ResultImages, ResultText } from "./parts";
import type { ToolRenderer, ToolRenderProps } from "./types";
import { argsDigest, resultImagesOf, resultTextOf } from "./util";

function Summary({ args }: ToolRenderProps): ReactNode {
	return <span>{argsDigest(args)}</span>;
}

/** A line that reads as a URL or bare domain (dimmed second line in search lists). */
function isUrlish(line: string): boolean {
	if (/^https?:\/\//i.test(line)) return true;
	return /^[\w.-]+\.[a-z]{2,}(?:\/\S*)?$/i.test(line);
}

/** Compact result list (aicss web-search): title-ish lines highlighted,
 * URL-ish lines dimmed underneath. */
function SearchList({ text }: { text: string }): ReactNode {
	const lines = text
		.split("\n")
		.map(l => l.trim())
		.filter(l => l.length > 0);
	if (lines.length === 0) return null;
	return (
		<ul className="tr-tool-search">
			{lines.map((line, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: derived display list
				<li key={i} className={isUrlish(line) ? "tr-tool-search-url" : "tr-tool-search-title"}>
					{line}
				</li>
			))}
		</ul>
	);
}

/** First plausible prompt-ish arg for image tools (used as the caption). */
function imagePrompt(args: Record<string, unknown>): string | null {
	for (const key of ["prompt", "subject", "description", "caption"]) {
		const v = args[key];
		if (typeof v === "string" && v.trim().length > 0) return v.trim();
	}
	return null;
}

function Body({ args, result, kind }: ToolRenderProps): ReactNode {
	// aicss treatments for kind-detected tools (set by the transcript ToolCard).
	if (kind === "diff") {
		const text = resultTextOf(result);
		if (text) return <DiffBlock diff={text} maxLines={30} />;
	}
	if (kind === "search") {
		const list = SearchList({ text: resultTextOf(result) });
		if (list !== null) {
			return (
				<>
					{list}
					<ResultImages result={result} />
				</>
			);
		}
	}
	if (kind === "image") {
		const prompt = imagePrompt(args);
		const images = resultImagesOf(result);
		return (
			<>
				<figure className="tr-tool-image">
					<ResultImages result={result} />
					{prompt && <figcaption className="tr-tool-image-caption">{prompt}</figcaption>}
				</figure>
				{images.length === 0 && <ResultText result={result} maxLines={10} />}
			</>
		);
	}

	let argText = "";
	try {
		argText = JSON.stringify(args, null, 2) ?? "";
	} catch {
		argText = String(args);
	}
	return (
		<>
			{argText && argText !== "{}" && (
				<Output text={argText} lang="json" variant="code" maxLines={12} title={t("args")} />
			)}
			<ResultImages result={result} />
			<ResultText result={result} maxLines={10} />
		</>
	);
}

export const genericRenderer: ToolRenderer = { Summary, Body };
