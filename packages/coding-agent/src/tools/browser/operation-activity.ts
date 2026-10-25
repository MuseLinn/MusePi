import type { BrowserOperation, BrowserOperationAction } from "./tab-protocol";

interface OperationStartDetails {
	target?: string;
}

interface OperationResultDetails {
	elementCount?: number;
	truncated?: boolean;
}

export function operationResultDetails(value: unknown): OperationResultDetails {
	if (typeof value !== "object" || value === null || !("elements" in value)) return {};
	const elements = value.elements;
	return Array.isArray(elements) ? { elementCount: elements.length } : {};
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
