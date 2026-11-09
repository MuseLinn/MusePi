export type PageTextScope = "viewport" | "document" | "element";

export interface PageTextOptions {
	scope?: PageTextScope;
	maxChars?: number;
	cursor?: string;
	snapshotId?: string;
	ref?: string;
}

export interface PageTextPage {
	id: string;
	text: string;
	part?: number;
	continued?: boolean;
}

export interface PageTextPagination {
	text: string;
	blocks: PageTextPage[];
	blockCount: number;
	totalBlocks: number;
	truncated: boolean;
	nextCursor?: string;
}

export interface PageTextSnapshot extends PageTextPagination {
	scope: PageTextScope;
	snapshotId?: string;
	ref?: string;
	url: string;
	title: string;
	scanTruncated: boolean;
	capturedAt: string;
}

interface PageTextNode {
	parentElement: Element | null;
	textContent: string | null;
}

interface PageTextWalker {
	nextNode(): boolean;
	currentNode: PageTextNode;
}

interface PageTextRange {
	selectNodeContents(node: PageTextNode): void;
	getBoundingClientRect(): {
		bottom: number;
		right: number;
		top: number;
		left: number;
		width: number;
		height: number;
	};
}

const MAX_SCANNED_TEXT_NODES = 50_000;

/** Split rendered blocks into bounded pages. Cursors are zero-based block:character offsets. */
export function paginateTextBlocks(blocks: readonly string[], options: PageTextOptions = {}): PageTextPagination {
	const maxChars = options.maxChars ?? 12000;
	if (!Number.isInteger(maxChars) || maxChars < 2048 || maxChars > 24000) {
		throw new Error("maxChars must be an integer between 2048 and 24000");
	}
	let index = 0;
	let offset = 0;
	if (options.cursor !== undefined) {
		const match = /^(\d+):(\d+)$/.exec(options.cursor);
		if (!match) throw new Error(`Invalid page-text cursor ${JSON.stringify(options.cursor)}`);
		index = Number(match[1]);
		offset = Number(match[2]);
		if (index >= blocks.length || offset >= blocks[index]!.length) {
			throw new Error(`Page-text cursor is outside the collected blocks: ${options.cursor}`);
		}
	}
	const pages: PageTextPage[] = [];
	let remaining = maxChars;
	let nextCursor: string | undefined;
	while (index < blocks.length) {
		const source = blocks[index]!;
		const separatorLength = pages.length > 0 ? 2 : 0;
		const available = source.length - offset;
		if (pages.length > 0 && separatorLength + available > remaining) {
			nextCursor = `${index}:${offset}`;
			break;
		}
		const capacity = remaining - separatorLength;
		if (capacity <= 0) {
			nextCursor = `${index}:${offset}`;
			break;
		}
		const initialOffset = offset;
		const text = source.slice(offset, offset + capacity);
		offset += text.length;
		pages.push({
			id: `b${index + 1}`,
			text,
			...(initialOffset > 0 ? { part: 2 } : {}),
			...(offset < source.length ? { continued: true } : {}),
		});
		remaining -= separatorLength + text.length;
		if (offset < source.length) {
			nextCursor = `${index}:${offset}`;
			break;
		}
		index += 1;
		offset = 0;
	}
	return {
		text: pages.map(page => page.text).join("\n\n"),
		blocks: pages,
		blockCount: pages.length,
		totalBlocks: blocks.length,
		truncated: nextCursor !== undefined,
		...(nextCursor !== undefined ? { nextCursor } : {}),
	};
}

/** Runs in the page. `pageTextCode` embeds the pure paginator beside this evaluator. */
export function evaluatePageText(options: PageTextOptions, rootElement?: Element): PageTextSnapshot {
	const scope = options.scope ?? "viewport";
	if (scope !== "viewport" && scope !== "document" && scope !== "element") {
		throw new Error(`Unsupported page-text scope: ${scope}`);
	}
	if (scope === "element" && !rootElement) throw new Error("Element page text requires a resolved element handle");
	const pageDocument = document as unknown as {
		body: Element | null;
		documentElement: Element;
		createTreeWalker(root: Element, whatToShow: number): PageTextWalker;
		createRange(): PageTextRange;
		title: string;
	};
	const pageWindow = globalThis as unknown as {
		innerHeight: number;
		innerWidth: number;
		location: { href: string };
		getComputedStyle(element: Element): { display: string; visibility: string };
	};
	const root = scope === "element" ? rootElement! : (pageDocument.body ?? pageDocument.documentElement);
	const walker = pageDocument.createTreeWalker(root, 4);
	const blocks: string[] = [];
	let scanned = 0;
	let scanTruncated = false;
	while (walker.nextNode()) {
		scanned += 1;
		if (scanned > MAX_SCANNED_TEXT_NODES) {
			scanTruncated = true;
			break;
		}
		const node = walker.currentNode;
		const parent = node.parentElement;
		if (!parent || parent.closest("script,style,noscript,template,svg")) continue;
		const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
		if (!text) continue;
		const style = pageWindow.getComputedStyle(parent);
		if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") continue;
		const range = pageDocument.createRange();
		range.selectNodeContents(node);
		const rect = range.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) continue;
		if (
			scope === "viewport" &&
			(rect.bottom <= 0 ||
				rect.right <= 0 ||
				rect.top >= pageWindow.innerHeight ||
				rect.left >= pageWindow.innerWidth)
		) {
			continue;
		}
		blocks.push(text);
	}
	const page = paginateTextBlocks(blocks, options);
	return {
		scope,
		...(scope === "element" ? { snapshotId: options.snapshotId, ref: options.ref } : {}),
		url: pageWindow.location.href,
		title: pageDocument.title,
		scanTruncated,
		capturedAt: new Date().toISOString(),
		...page,
	};
}

/** Build a self-contained evaluation for both Puppeteer and cmux tab facades. */
export function pageTextCode(options: PageTextOptions): string {
	const scope = options.scope ?? "viewport";
	if (scope !== "viewport" && scope !== "document" && scope !== "element") {
		throw new Error(`Unsupported page-text scope: ${scope}`);
	}
	if (scope === "element" && !options.snapshotId) throw new Error("Element page text requires snapshotId");
	if (scope === "element" && !options.ref) throw new Error("Element page text requires ref");
	const observationRef = scope === "element" ? /^e([1-9]\d*)$/.exec(options.ref!) : null;
	if (scope === "element" && !observationRef) throw new Error("Element page text ref must be an eN observation ref");
	const maxChars = options.maxChars ?? 12000;
	if (!Number.isInteger(maxChars) || maxChars < 2048 || maxChars > 24000) {
		throw new Error("maxChars must be an integer between 2048 and 24000");
	}
	const normalized = { ...options, scope, maxChars };
	const shared = `const MAX_SCANNED_TEXT_NODES=${MAX_SCANNED_TEXT_NODES};const paginateTextBlocks=${paginateTextBlocks.toString()};`;
	if (scope === "element") {
		const evaluator = `function(root,options){${shared}return (${evaluatePageText.toString()})(options,root);}`;
		return `const handle = await tab.id(${Number(observationRef![1])}); return await handle.evaluate(${evaluator}, ${JSON.stringify(normalized)});`;
	}
	const evaluator = `function(options){${shared}return (${evaluatePageText.toString()})(options);}`;
	return `return await tab.evaluate(${evaluator}, ${JSON.stringify(normalized)});`;
}
