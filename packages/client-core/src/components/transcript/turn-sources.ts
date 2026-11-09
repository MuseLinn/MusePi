/**
 * Turn "来源" aggregation: which pages the agent browsed while answering, and
 * which of them it actually read.
 *
 * One source of truth — the `browser` tool's result details (`pageText`,
 * top-level action/url, and `operations[]`). We keep pages in first-seen
 * order so the card reads like the browsing session.
 */
import { browserOperationsOf } from "../../tool-render/tools/browser-activity.js";
import { isRecord, str } from "../../tool-render/util.js";

/** One page the turn touched. */
export interface TurnSourcePage {
	url: string;
	/** Page title from the operation, falling back to the URL at render time. */
	title: string;
	/** Times the agent navigated to this page (min 1 once it appears). */
	opens: number;
	/** The agent inspected the page content (an `observe` step). */
	read: boolean;
}

export interface TurnSources {
	pages: TurnSourcePage[];
	readCount: number;
	passedCount: number;
}

/** The turn's tool-call blocks plus a result lookup — both already available
 *  in the transcript, so the card adds no new data pipeline. */
export type TurnToolBlocks = readonly { type: string; id?: string; name?: string }[];

export function collectTurnSources(
	blocks: TurnToolBlocks,
	resultOf: (toolCallId: string) => { isError?: boolean; details?: unknown } | undefined,
): TurnSources {
	const pages = new Map<string, TurnSourcePage>();
	for (const block of blocks) {
		if (block.type !== "toolCall" || block.name !== "browser") continue;
		const id = block.id ?? "";
		if (!id) continue;
		const result = resultOf(id);
		if (result === undefined || result.isError === true) continue;
		const details = isRecord(result.details) ? result.details : undefined;
		const fallbackUrl = details ? str(details.url) : null;
		const action = details ? str(details.action) : null;
		const ensurePage = (url: string, title?: string): TurnSourcePage => {
			let page = pages.get(url);
			if (page === undefined) {
				page = { url, title: title ?? "", opens: 0, read: false };
				pages.set(url, page);
			}
			if (!page.title && title) page.title = title;
			return page;
		};
		if (action === "open" && fallbackUrl) ensurePage(fallbackUrl).opens += 1;
		if (action === "read" && details) {
			const pageText = isRecord(details.pageText) ? details.pageText : undefined;
			const url = pageText ? (str(pageText.url) ?? fallbackUrl) : fallbackUrl;
			const title = pageText ? (str(pageText.title) ?? undefined) : undefined;
			if (url) ensurePage(url, title).read = true;
		}
		// Page identity comes from the raw operation record — the typed
		// projection is the step card's field set. Keyed by operation id so the
		// parser still decides which steps count.
		const rawById = new Map<string, Record<string, unknown>>();
		const rawOperations = details !== undefined && Array.isArray(details.operations) ? details.operations : [];
		for (const raw of rawOperations) {
			if (isRecord(raw)) {
				const rawId = str(raw.id);
				if (rawId) rawById.set(rawId, raw);
			}
		}
		for (const operation of browserOperationsOf(details)) {
			if (operation.status !== "completed") continue;
			const url = operation.pageUrl ?? str(rawById.get(operation.id)?.pageUrl) ?? fallbackUrl;
			if (!url) continue;
			const existing = pages.get(url);
			if (existing && !existing.title && operation.pageTitle) existing.title = operation.pageTitle;
			if (operation.action !== "observe" && operation.action !== "goto") continue;
			const page = ensurePage(url, operation.pageTitle);
			if (operation.action === "observe") page.read = true;
			if (operation.action === "goto") page.opens += 1;
		}
	}
	const list = [...pages.values()];
	for (const page of list) if (page.opens === 0) page.opens = 1;
	return {
		pages: list,
		readCount: list.filter(page => page.read).length,
		passedCount: list.filter(page => !page.read).length,
	};
}

/** Drop the scheme for display when the hostname alone identifies the page. */
export function sourceHost(url: string): string {
	const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url);
	return match?.[1] ?? url;
}
