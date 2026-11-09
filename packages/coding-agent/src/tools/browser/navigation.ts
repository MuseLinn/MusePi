import { ToolError } from "../tool-errors";

export type NavigationAction = "navigate" | "search" | "back" | "forward" | "reload" | "stop" | "wait_load";

export interface NavigationParams {
	action: NavigationAction;
	url?: string;
	query?: string;
	wait_until?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
	state?: "committed" | "dom_ready" | "complete";
	timeoutMs?: number;
}

export interface BrowserNavigationResult {
	action: NavigationAction;
	url: string;
	title: string;
}

const SEARCH_ENGINES: Record<string, string> = {
	google: "https://www.google.com/search?q=",
	bing: "https://www.bing.com/search?q=",
	duckduckgo: "https://duckduckgo.com/?q=",
	baidu: "https://www.baidu.com/s?wd=",
};

export function searchUrl(engine: string | undefined, query: string): string {
	const key = String(engine ?? "")
		.trim()
		.toLowerCase();
	const template = SEARCH_ENGINES[key] ?? SEARCH_ENGINES.google;
	return `${template}${encodeURIComponent(query.trim())}`;
}

export function navigationActionCode(params: NavigationParams, engine: string | undefined): string {
	const waitUntil = params.wait_until ?? "load";
	const timeoutMs = params.timeoutMs ?? 10_000;
	let operation: string;
	switch (params.action) {
		case "navigate": {
			if (!params.url) throw new ToolError("navigate requires url");
			let parsed: URL;
			try {
				parsed = new URL(params.url);
			} catch {
				throw new ToolError("navigate requires an HTTP(S) URL");
			}
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				throw new ToolError("navigate requires an HTTP(S) URL");
			}
			operation = `await tab.goto(${JSON.stringify(params.url)}, { waitUntil: ${JSON.stringify(waitUntil)} });`;
			break;
		}
		case "search": {
			if (!params.query?.trim()) throw new ToolError("search requires query");
			const url = searchUrl(engine, params.query);
			operation = `await tab.goto(${JSON.stringify(url)}, { waitUntil: ${JSON.stringify(waitUntil)} });`;
			break;
		}
		case "back":
			operation = `const session = await page.createCDPSession();
try {
	const { entries, currentIndex } = await session.send("Page.getNavigationHistory");
	if (currentIndex <= 0) throw new Error("No back history");
	const navigation = page.waitForNavigation({ waitUntil: ${JSON.stringify(waitUntil)} });
	await session.send("Page.navigateToHistoryEntry", { entryId: entries[currentIndex - 1].id });
	await navigation;
} finally {
	await session.detach().catch(() => undefined);
}`;
			break;
		case "forward":
			operation = `const session = await page.createCDPSession();
try {
	const { entries, currentIndex } = await session.send("Page.getNavigationHistory");
	if (currentIndex >= entries.length - 1) throw new Error("No forward history");
	const navigation = page.waitForNavigation({ waitUntil: ${JSON.stringify(waitUntil)} });
	await session.send("Page.navigateToHistoryEntry", { entryId: entries[currentIndex + 1].id });
	await navigation;
} finally {
	await session.detach().catch(() => undefined);
}`;
			break;
		case "reload":
			operation = `await page.reload({ waitUntil: ${JSON.stringify(waitUntil)} });`;
			break;
		case "stop":
			operation = `const session = await page.createCDPSession();
try {
	await session.send("Page.stopLoading");
} finally {
	await session.detach().catch(() => undefined);
}`;
			break;
		case "wait_load": {
			if (!params.state) throw new ToolError("wait_load requires state");
			const expected = params.state === "complete" ? "complete" : "interactive";
			operation = `await page.waitForFunction(() => document.readyState === ${JSON.stringify(expected)}, { timeout: ${timeoutMs} });`;
			break;
		}
	}
	return `${operation}\nreturn { action: ${JSON.stringify(params.action)}, url: page.url(), title: ${params.action === "stop" ? '""' : "await page.title()"} };`;
}
