import { t } from "../../i18n/index.js";

export type BrowserOperationAction =
	| "goto"
	| "observe"
	| "click"
	| "fill"
	| "type"
	| "press"
	| "select"
	| "scroll"
	| "drag"
	| "hover"
	| "screenshot"
	| "evaluate"
	| "upload"
	| "wait";

/** Page identity sampled on one side of an action. */
export interface BrowserPageState {
	url: string;
	title?: string;
	scrollY?: number;
	loading?: boolean;
}

export interface BrowserOperation {
	id: string;
	action: BrowserOperationAction;
	status: "running" | "completed" | "failed" | "canceled";
	startedAt: number;
	endedAt?: number;
	target?: string;
	elementCount?: number;
	truncated?: boolean;
	error?: string;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	pageTitle?: string;
	pageUrl?: string;
	thumbnail?: string;
	stateBefore?: BrowserPageState;
	stateAfter?: BrowserPageState;
}

export interface BrowserActivityCall {
	agentId: string;
	tab: string;
	url?: string;
	args: unknown;
	isError: boolean;
	operations: BrowserOperation[];
}

export interface BrowserActionSummary {
	count: number;
	failed: number;
}

export interface BrowserActivitySummary {
	calls: number;
	pages: number;
	actions: Partial<Record<BrowserOperationAction, BrowserActionSummary>>;
	recoveredFailures: number;
	residualFailures: number;
}

const ACTIONS = new Set<BrowserOperationAction>([
	"goto",
	"observe",
	"click",
	"fill",
	"type",
	"press",
	"select",
	"scroll",
	"drag",
	"hover",
	"screenshot",
	"evaluate",
	"upload",
	"wait",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pageStateOf(value: unknown): BrowserPageState | undefined {
	if (!isRecord(value)) return undefined;
	const url = stringOrUndefined(value.url);
	if (url === undefined) return undefined;
	const title = stringOrUndefined(value.title);
	const scrollY = numberOrUndefined(value.scrollY);
	return {
		url,
		...(title !== undefined ? { title } : {}),
		...(scrollY !== undefined ? { scrollY } : {}),
		...(typeof value.loading === "boolean" ? { loading: value.loading } : {}),
	};
}

export function browserOperationsOf(details: unknown): BrowserOperation[] {
	if (!isRecord(details) || !Array.isArray(details.operations)) return [];
	return details.operations.flatMap(value => {
		if (!isRecord(value)) return [];
		const action = stringOrUndefined(value.action) as BrowserOperationAction | undefined;
		const status = stringOrUndefined(value.status);
		const id = stringOrUndefined(value.id);
		const startedAt = numberOrUndefined(value.startedAt);
		if (!action || !ACTIONS.has(action) || !id || startedAt === undefined) return [];
		if (status !== "running" && status !== "completed" && status !== "failed" && status !== "canceled") return [];
		return [
			{
				id,
				action,
				status,
				startedAt,
				...(numberOrUndefined(value.endedAt) !== undefined ? { endedAt: numberOrUndefined(value.endedAt) } : {}),
				...(stringOrUndefined(value.target) !== undefined ? { target: stringOrUndefined(value.target) } : {}),
				...(numberOrUndefined(value.elementCount) !== undefined
					? { elementCount: numberOrUndefined(value.elementCount) }
					: {}),
				...(typeof value.truncated === "boolean" ? { truncated: value.truncated } : {}),
				...(stringOrUndefined(value.error) !== undefined ? { error: stringOrUndefined(value.error) } : {}),
				...(numberOrUndefined(value.x) !== undefined ? { x: numberOrUndefined(value.x) } : {}),
				...(numberOrUndefined(value.y) !== undefined ? { y: numberOrUndefined(value.y) } : {}),
				...(numberOrUndefined(value.width) !== undefined ? { width: numberOrUndefined(value.width) } : {}),
				...(numberOrUndefined(value.height) !== undefined ? { height: numberOrUndefined(value.height) } : {}),
				...(stringOrUndefined(value.pageTitle) !== undefined
					? { pageTitle: stringOrUndefined(value.pageTitle) }
					: {}),
				...(stringOrUndefined(value.pageUrl) !== undefined ? { pageUrl: stringOrUndefined(value.pageUrl) } : {}),
				...(typeof value.thumbnail === "string" && value.thumbnail.startsWith("data:image/")
					? { thumbnail: value.thumbnail }
					: {}),
				...(pageStateOf(value.stateBefore) !== undefined ? { stateBefore: pageStateOf(value.stateBefore) } : {}),
				...(pageStateOf(value.stateAfter) !== undefined ? { stateAfter: pageStateOf(value.stateAfter) } : {}),
			},
		];
	});
}

/** One field a step changed, in display order. */
export interface BrowserStepChange {
	key: "pageTitle" | "url" | "scrollY" | "loading";
	before: string | number | boolean;
	after: string | number | boolean;
}

/** A step's lifecycle in the reader's words: the action verb carries the
 *  status, so "点击" reads as 正在点击 / 已点击 / 点击失败 instead of a generic
 *  "completed". */
export function browserOperationStatus(operation: Pick<BrowserOperation, "action" | "status">): string {
	const action = browserActionLabel(operation.action);
	switch (operation.status) {
		case "running":
			return t("tools.browserOperationRunning", { action });
		case "failed":
			return t("tools.browserOperationFailed", { action });
		case "canceled":
			return t("tools.canceled");
		default:
			return t("tools.browserOperationDone", { action });
	}
}

/** Fields this step changed; an empty list means the page stood still.
 *  `null` when the step has no comparable pair (still running, or a sampling
 *  miss), so the card can stay silent instead of claiming "no change". */
export function browserStepChanges(operation: BrowserOperation): BrowserStepChange[] | null {
	const before = operation.stateBefore;
	const after = operation.stateAfter;
	if (!before || !after) return null;
	const changes: BrowserStepChange[] = [];
	if (before.title && after.title && before.title !== after.title) {
		changes.push({ key: "pageTitle", before: before.title, after: after.title });
	}
	if (before.url !== after.url) changes.push({ key: "url", before: before.url, after: after.url });
	if (before.scrollY !== undefined && after.scrollY !== undefined && before.scrollY !== after.scrollY) {
		changes.push({ key: "scrollY", before: before.scrollY, after: after.scrollY });
	}
	if (before.loading !== undefined && after.loading !== undefined && before.loading !== after.loading) {
		changes.push({ key: "loading", before: before.loading, after: after.loading });
	}
	return changes;
}

/** One browser call's headline numbers (card summary + tests). */
export interface BrowserCallStats {
	pages: number;
	clicks: number;
	screenshots: number;
	failures: number;
	durationMs: number;
}

export function browserCallStats(operations: readonly BrowserOperation[], now = Date.now()): BrowserCallStats {
	const pages = new Set<string>();
	let clicks = 0;
	let screenshots = 0;
	let failures = 0;
	let started = Number.POSITIVE_INFINITY;
	let ended = 0;
	for (const operation of operations) {
		if (operation.pageUrl) pages.add(operation.pageUrl);
		if (operation.status === "completed" && operation.action === "click") clicks += 1;
		if (operation.action === "screenshot") screenshots += 1;
		if (operation.status === "failed") failures += 1;
		if (Number.isFinite(operation.startedAt)) started = Math.min(started, operation.startedAt);
		const end = operation.endedAt ?? (operation.status === "running" ? now : operation.startedAt);
		if (typeof end === "number") ended = Math.max(ended, end);
	}
	const durationMs = Number.isFinite(started) && ended > started ? ended - started : 0;
	return { pages: pages.size, clicks, screenshots, failures, durationMs };
}

export interface BrowserOperationGroup {
	url: string;
	title: string;
	operations: BrowserOperation[];
	durationMs: number;
	thumbnail?: string;
}

/** Group a call's steps by the page they ran on, preserving run order. */
export function browserOperationGroups(
	operations: readonly BrowserOperation[],
	fallbackUrl?: string | null,
): BrowserOperationGroup[] {
	const groups = new Map<string, BrowserOperationGroup>();
	for (const operation of operations) {
		const url = operation.pageUrl ?? fallbackUrl ?? "";
		let group = groups.get(url);
		if (!group) {
			group = { url, title: "", operations: [], durationMs: 0 };
			groups.set(url, group);
		}
		group.operations.push(operation);
		if (!group.title && operation.pageTitle) group.title = operation.pageTitle;
		if (!group.thumbnail && operation.thumbnail) group.thumbnail = operation.thumbnail;
	}
	for (const group of groups.values()) {
		const starts = group.operations.map(operation => operation.startedAt).filter(Number.isFinite);
		const ends = group.operations.map(operation => operation.endedAt ?? operation.startedAt).filter(Number.isFinite);
		const start = starts.length > 0 ? Math.min(...starts) : 0;
		const end = ends.length > 0 ? Math.max(...ends) : 0;
		group.durationMs = end > start ? end - start : 0;
	}
	return [...groups.values()];
}

export function browserActionLabel(action: BrowserOperationAction): string {
	switch (action) {
		case "goto":
			return t("tools.browserActionGoto");
		case "observe":
			return t("tools.browserActionObserve");
		case "click":
			return t("tools.browserActionClick");
		case "fill":
			return t("tools.browserActionFill");
		case "type":
			return t("tools.browserActionType");
		case "press":
			return t("tools.browserActionPress");
		case "select":
			return t("tools.browserActionSelect");
		case "scroll":
			return t("tools.browserActionScroll");
		case "drag":
			return t("tools.browserActionDrag");
		case "hover":
			return t("tools.browserActionHover");
		case "screenshot":
			return t("tools.browserActionScreenshot");
		case "evaluate":
			return t("tools.browserActionEvaluate");
		case "upload":
			return t("tools.browserActionUpload");
		case "wait":
			return t("tools.browserActionWait");
	}
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => key !== "timeout")
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => [key, stableValue(item)]),
	);
}

function sameCall(left: BrowserActivityCall, right: BrowserActivityCall): boolean {
	return (
		left.agentId === right.agentId &&
		left.tab === right.tab &&
		JSON.stringify(stableValue(left.args)) === JSON.stringify(stableValue(right.args))
	);
}

function sameOperation(left: BrowserOperation, right: BrowserOperation): boolean {
	return left.action === right.action && (left.target ?? "") === (right.target ?? "");
}

export function summarizeBrowserOperations(calls: readonly BrowserActivityCall[]): BrowserActivitySummary {
	const summary: BrowserActivitySummary = {
		calls: calls.length,
		pages: 0,
		actions: {},
		recoveredFailures: 0,
		residualFailures: 0,
	};
	const pages = new Set<string>();
	const recovered = new Set<string>();
	for (let index = 0; index < calls.length; index++) {
		const call = calls[index]!;
		const failed = call.operations.filter(operation => operation.status === "failed");
		for (const operation of failed) {
			const later = calls
				.slice(index + 1)
				.find(
					candidate =>
						!candidate.isError &&
						sameCall(call, candidate) &&
						candidate.operations.some(next => next.status === "completed" && sameOperation(operation, next)),
				);
			if (later) recovered.add(`${index}:${operation.id}`);
		}
		if (call.isError && failed.length === 0) {
			const later = calls.slice(index + 1).find(candidate => !candidate.isError && sameCall(call, candidate));
			if (later) recovered.add(`${index}:call`);
		}
	}
	for (const [index, call] of calls.entries()) {
		for (const operation of call.operations) {
			if (operation.action === "observe" && operation.status === "completed") {
				pages.add(`${call.agentId}:${call.tab}:${call.url ?? ""}`);
				continue;
			}
			if (operation.status === "failed" && recovered.has(`${index}:${operation.id}`)) {
				summary.recoveredFailures++;
				continue;
			}
			if (operation.status !== "completed" && operation.status !== "failed") continue;
			const action = summary.actions[operation.action] ?? { count: 0, failed: 0 };
			action.count++;
			if (operation.status === "failed") {
				action.failed++;
				summary.residualFailures++;
			}
			summary.actions[operation.action] = action;
		}
		if (call.isError && !call.operations.some(operation => operation.status === "failed")) {
			if (recovered.has(`${index}:call`)) summary.recoveredFailures++;
			else summary.residualFailures++;
		}
	}
	summary.pages = pages.size;
	return summary;
}
