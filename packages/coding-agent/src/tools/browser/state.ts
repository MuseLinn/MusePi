import { ToolError } from "../tool-errors";

export interface BrowserTabStatus {
	id: string;
	title?: string;
	url: string;
	controlled: boolean;
	visible?: boolean;
	loading?: boolean;
	canGoBack?: boolean;
	canGoForward?: boolean;
}

export interface BrowserStatus {
	available: boolean;
	panelVisible?: boolean;
	activeTabId?: string;
	visibleTabId?: string;
	url?: string;
	title?: string;
	tabs: BrowserTabStatus[];
}

export interface SupervisedTabState {
	name: string;
	targetId: string;
	state: "alive" | "dead";
	info: { url: string; title?: string };
}

/** Project only facts known to the daemon when no desktop panel is attached. */
export function browserStatusFromTabs(tabs: readonly SupervisedTabState[]): BrowserStatus {
	const live = tabs.filter(tab => tab.state === "alive");
	return {
		available: true,
		tabs: live.map(tab => ({
			id: tab.targetId,
			...(tab.info.title ? { title: tab.info.title } : {}),
			url: tab.info.url,
			controlled: true,
		})),
	};
}

/** Read the desktop host's panel and tab authority, never the renderer's cached projection. */
export async function readManagedBrowserStatus(baseUrl: string, signal?: AbortSignal): Promise<BrowserStatus> {
	const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/musepi/state`, { signal });
	if (!response.ok) throw new ToolError(`Managed browser state failed with HTTP ${response.status}`);
	const value: unknown = await response.json();
	if (
		typeof value !== "object" ||
		value === null ||
		typeof (value as { available?: unknown }).available !== "boolean" ||
		!Array.isArray((value as { tabs?: unknown }).tabs)
	) {
		throw new ToolError("Managed browser state returned an invalid result");
	}
	return value as BrowserStatus;
}

export interface BrowserHistoryRecord {
	id: string;
	url: string;
	title: string;
	visitedAt: number;
}

export interface BrowserDownloadRecord {
	id: string;
	url: string;
	fileName: string;
	savePath?: string;
	status: string;
	receivedBytes: number;
	totalBytes: number;
	startedAt: number;
	endedAt?: number;
}

export async function readManagedBrowserRecords(
	baseUrl: string,
	kind: "history" | "downloads",
	signal?: AbortSignal,
): Promise<BrowserHistoryRecord[] | BrowserDownloadRecord[]> {
	const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/musepi/${kind}`, { signal });
	if (!response.ok) throw new ToolError(`Managed browser ${kind} failed with HTTP ${response.status}`);
	const value: unknown = await response.json();
	if (!Array.isArray(value) || value.some(record => typeof record !== "object" || record === null)) {
		throw new ToolError(`Managed browser ${kind} returned an invalid result`);
	}
	return value as BrowserHistoryRecord[] | BrowserDownloadRecord[];
}
