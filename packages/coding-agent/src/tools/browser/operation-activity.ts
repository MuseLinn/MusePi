import type { BrowserOperation, BrowserOperationAction, BrowserPageState } from "./tab-protocol";

interface OperationStartDetails {
	target?: string;
}

interface OperationResultDetails {
	elementCount?: number;
	truncated?: boolean;
	/** Richer target discovered while the op ran (e.g. the upload host + accept). */
	target?: string;
}

/** Viewport geometry of the element an action targeted (CSS px). */
export interface OperationRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** One thumbnail per operation is enough for the feed; the cap bounds a run's
 *  IPC payload when a script drives a long form. */
const MAX_OPERATION_THUMBNAILS = 24;

export function operationResultDetails(value: unknown): OperationResultDetails {
	if (typeof value !== "object" || value === null) return {};
	const result: OperationResultDetails = {};
	const operationTarget =
		"operationTarget" in value && typeof (value as { operationTarget?: unknown }).operationTarget === "string"
			? (value as { operationTarget: string }).operationTarget
			: undefined;
	if (operationTarget) result.target = operationTarget.slice(0, 240);
	if (!("elements" in value)) return result;
	const elements = (value as { elements?: unknown }).elements;
	if (Array.isArray(elements)) result.elementCount = elements.length;
	return result;
}

export function redactBrowserUrl(url: string): string {
	if (!url || (!url.includes("@") && !url.includes("//"))) return url;
	try {
		const parsed = new URL(url);
		if (!parsed.username && !parsed.password) return url;
		parsed.username = "";
		parsed.password = "";
		return parsed.toString();
	} catch {
		return url;
	}
}

export class BrowserOperationTracker {
	#operations: BrowserOperation[] = [];
	#sequence = 0;
	readonly #runId: string;
	readonly #onChange?: (operations: BrowserOperation[]) => void;

	constructor(runId: string, onChange?: (operations: BrowserOperation[]) => void) {
		this.#runId = runId;
		this.#onChange = onChange;
	}

	start(action: BrowserOperationAction, details: OperationStartDetails = {}): string {
		const id = `${this.#runId}:${++this.#sequence}`;
		this.#operations.push({
			id,
			action,
			status: "running",
			startedAt: Date.now(),
			...(details.target ? { target: details.target.slice(0, 240) } : {}),
		});
		this.#emit();
		return id;
	}

	complete(id: string, details: OperationResultDetails = {}): void {
		this.#settle(id, "completed", details);
	}

	/** Attach the element box and page title observed while the action ran. */
	position(id: string, rect: OperationRect | null, pageTitle?: string, pageUrl?: string): void {
		const operation = this.#operations.find(item => item.id === id);
		if (!operation) return;
		if (rect) {
			operation.x = Math.round(rect.x);
			operation.y = Math.round(rect.y);
			operation.width = Math.round(rect.width);
			operation.height = Math.round(rect.height);
		}
		if (pageTitle) operation.pageTitle = pageTitle.slice(0, 120);
		if (pageUrl) operation.pageUrl = pageUrl;
		this.#emit();
	}

	/** Post-action page identity (navigation may have changed it). */
	page(id: string, pageUrl: string, pageTitle?: string): void {
		const operation = this.#operations.find(item => item.id === id);
		if (!operation) return;
		operation.pageUrl = pageUrl;
		if (pageTitle) operation.pageTitle = pageTitle.slice(0, 120);
		this.#emit();
	}

	/** Attach the page identity sampled on one side of the action; the pair is
	 *  what the step's change section diffs. */
	state(id: string, phase: "before" | "after", state: BrowserPageState): void {
		const operation = this.#operations.find(item => item.id === id);
		if (!operation) return;
		if (phase === "before") operation.stateBefore = state;
		else operation.stateAfter = state;
		this.#emit();
	}

	/** True while this run may still attach action screenshots. */
	canAttachThumbnail(): boolean {
		let count = 0;
		for (const operation of this.#operations) if (operation.thumbnail) count += 1;
		return count < MAX_OPERATION_THUMBNAILS;
	}

	setThumbnail(id: string, dataUrl: string): void {
		const operation = this.#operations.find(item => item.id === id);
		if (!operation) return;
		operation.thumbnail = dataUrl;
		this.#emit();
	}

	fail(id: string, error: unknown): void {
		const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
		this.#settle(id, "failed", { error: message });
	}

	cancel(id: string): void {
		this.#settle(id, "canceled");
	}

	cancelPending(): void {
		for (const operation of this.#operations) {
			if (operation.status === "running") this.cancel(operation.id);
		}
	}

	snapshot(): BrowserOperation[] {
		return this.#operations.map(operation => ({ ...operation }));
	}

	#settle(id: string, status: BrowserOperation["status"], details: Partial<BrowserOperation> = {}): void {
		const operation = this.#operations.find(item => item.id === id);
		if (operation?.status !== "running") return;
		Object.assign(operation, details, { status, endedAt: Date.now() });
		this.#emit();
	}

	#emit(): void {
		this.#onChange?.(this.snapshot());
	}
}
