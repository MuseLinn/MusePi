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
	| "wait";

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
			},
		];
	});
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
