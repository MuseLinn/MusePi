/**
 * PromptHost: one session-level owner for prompt contributions.
 *
 * Sections, volatile contexts, variables and tool sections register on the same
 * host. Scope controls inheritance, lane controls source priority inside one
 * scope, and owner controls bulk release. The host is pure TypeScript; the SDK
 * and session decide when a host exists and when contexts are delivered.
 */

import type { PromptVariableResolver } from "./registry";
import { createPromptScope } from "./scope";
import { PromptStore } from "./store";
import {
	DEFAULT_PROMPT_LANES,
	type PromptAssembly,
	type PromptContextContribution,
	type PromptContextMessage,
	type PromptContextOptions,
	type PromptHostOptions,
	type PromptLoadOptions,
	type PromptPlacement,
	type PromptScope,
	type PromptSectionContribution,
	type PromptToolContribution,
} from "./types";

/**
 * One recorded registration on a scoped host view.
 *
 * A view records what its factory registered — under the owner the store
 * actually resolved (the contribution's own owner wins over the view's) — so a
 * session can remove the contributions on disable and replay them on
 * re-enable without re-running the factory, the same parity `Extension`
 * objects already have for tools.
 */
export interface ScopedPromptHostRegistration {
	kind: "section" | "context" | "variable" | "tool";
	input: unknown;
	/** The owner the registration resolved under (contribution owner first). */
	owner: string;
	placement?: PromptPlacement;
}

/** Replay store for one owner's registrations. */
export interface ScopedPromptHostLedger {
	entries: ScopedPromptHostRegistration[];
}

/**
 * Structural view of {@link PromptHost}'s public surface.
 *
 * Declared as an interface because the class holds true-private `#` state,
 * which nominalizes its type: scoped views (plain delegating objects) could
 * never satisfy the class type itself.
 */
export interface PromptHostSurface {
	readonly root: PromptScope;
	/** Monotonic structural counter; assembly and context delivery never bump it. */
	readonly revision: number;
	readonly closed: boolean;
	/** Create a child scope. Contributions inherit from `parent`. */
	createScope(name: string, parent?: PromptScope): PromptScope;
	registerSection(input: PromptSectionContribution, placement?: PromptPlacement): () => void;
	registerContext(input: PromptContextContribution, placement?: PromptPlacement): () => void;
	registerVariable(name: string, resolve: PromptVariableResolver, placement?: PromptPlacement): () => void;
	/** Register a prompt section gated by the active tool set. */
	registerTool(input: PromptToolContribution, placement?: PromptPlacement): () => void;
	/** Release every contribution registered under `owner`. */
	removeByOwner(owner: string): void;
	/** Release everything. Idempotent; later registrations throw. */
	close(): void;
	assemble(options?: PromptLoadOptions): PromptAssembly;
	/** Deliver volatile contexts that are new, changed or marked required. */
	collectContext(options?: PromptContextOptions): PromptContextMessage[];
}

export interface ScopedPromptHost extends PromptHostSurface {
	/** The owner every registration without an explicit owner records under. */
	readonly owner: string;
	/** The ledger registrations are recorded into. */
	readonly ledger: ScopedPromptHostLedger;
}

/** Distinct resolved owners across one ledger (the view owner first). */
export function scopedLedgerOwners(viewOwner: string, ledger: ScopedPromptHostLedger): string[] {
	const owners = new Set<string>([viewOwner]);
	for (const entry of ledger.entries) owners.add(entry.owner);
	return [...owners];
}

/**
 * Release every live registration recorded in `ledger` (the view owner plus
 * any explicit owners its contributions resolved under).
 */
export function removeScopedPromptHostLedger(
	host: PromptHostSurface,
	viewOwner: string,
	ledger: ScopedPromptHostLedger,
): void {
	for (const owner of scopedLedgerOwners(viewOwner, ledger)) host.removeByOwner(owner);
}

/**
 * View of `host` whose registrations default to `owner` (when neither the
 * contribution nor the placement names one) and are recorded in `ledger`.
 * Assembly and removal delegate to the underlying host unchanged. A view
 * method records only after the underlying registration succeeds, so a
 * rejected input (a complete-section conflict, say) never leaves a ghost
 * entry that a later replay would resurrect.
 */
export function scopePromptHostToOwner(
	host: PromptHostSurface,
	owner: string,
	ledger: ScopedPromptHostLedger,
): ScopedPromptHost {
	const withOwner = (placement: PromptPlacement | undefined): PromptPlacement =>
		placement?.owner ? placement : { ...placement, owner };
	const record = (kind: ScopedPromptHostRegistration["kind"], input: unknown, placement?: PromptPlacement): void => {
		const inputOwner = (input as { owner?: unknown } | null)?.owner;
		const resolved =
			typeof inputOwner === "string" && inputOwner.length > 0 ? inputOwner : (placement?.owner ?? owner);
		ledger.entries.push({ kind, input, owner: resolved, placement: withOwner(placement) });
	};
	return {
		owner,
		ledger,
		get root() {
			return host.root;
		},
		get revision() {
			return host.revision;
		},
		get closed() {
			return host.closed;
		},
		createScope: (name, parent) => host.createScope(name, parent),
		registerSection: (input, placement) => {
			const dispose = host.registerSection(input, withOwner(placement));
			record("section", input, placement);
			return dispose;
		},
		registerContext: (input, placement) => {
			const dispose = host.registerContext(input, withOwner(placement));
			record("context", input, placement);
			return dispose;
		},
		registerVariable: (name, resolve, placement) => {
			const dispose = host.registerVariable(name, resolve, withOwner(placement));
			record("variable", { name, resolve }, placement);
			return dispose;
		},
		registerTool: (input, placement) => {
			const dispose = host.registerTool(input, withOwner(placement));
			record("tool", input, placement);
			return dispose;
		},
		removeByOwner: removed => host.removeByOwner(removed),
		close: () => host.close(),
		assemble: options => host.assemble(options),
		collectContext: options => host.collectContext(options),
	};
}

/**
 * Restore one owner's recorded registrations: remove everything the ledger
 * resolved under (view owner plus explicit owners), then re-register.
 * Idempotent — a fresh factory run that already registered the same
 * contributions is replaced by the replay.
 */
export function replayPromptHostLedger(host: PromptHostSurface, owner: string, ledger: ScopedPromptHostLedger): void {
	removeScopedPromptHostLedger(host, owner, ledger);
	for (const entry of ledger.entries) {
		const placement = entry.placement;
		switch (entry.kind) {
			case "section":
				host.registerSection(entry.input as PromptSectionContribution, placement);
				break;
			case "context":
				host.registerContext(entry.input as PromptContextContribution, placement);
				break;
			case "variable":
				host.registerVariable(
					(entry.input as { name: string; resolve: PromptVariableResolver }).name,
					(entry.input as { name: string; resolve: PromptVariableResolver }).resolve,
					placement,
				);
				break;
			case "tool":
				host.registerTool(entry.input as PromptToolContribution, placement);
				break;
		}
	}
}

export class PromptHost implements PromptHostSurface {
	#root: PromptScope;
	#store: PromptStore;

	constructor(options: PromptHostOptions = {}) {
		this.#root = createPromptScope(options.rootName ?? "session");
		this.#store = new PromptStore({
			root: this.#root,
			lanes: options.lanes ?? DEFAULT_PROMPT_LANES,
			defaultOwner: options.owner ?? "host",
		});
	}

	get root(): PromptScope {
		return this.#root;
	}

	/** Monotonic structural counter; assembly and context delivery never bump it. */
	get revision(): number {
		return this.#store.revision;
	}

	get closed(): boolean {
		return this.#store.closed;
	}

	/** Create a child scope. Contributions inherit from `parent`. */
	createScope(name: string, parent: PromptScope = this.#root): PromptScope {
		if (this.#store.closed) throw new Error("prompt host is closed");
		const scope = createPromptScope(name, parent);
		this.#store.trackScope(scope);
		return scope;
	}

	registerSection(input: PromptSectionContribution, placement?: PromptPlacement): () => void {
		return this.#store.addSection(input, placement);
	}

	registerContext(input: PromptContextContribution, placement?: PromptPlacement): () => void {
		return this.#store.addContext(input, placement);
	}

	registerVariable(name: string, resolve: PromptVariableResolver, placement?: PromptPlacement): () => void {
		return this.#store.addVariable(name, resolve, placement);
	}

	/** Register a prompt section gated by the active tool set. */
	registerTool(input: PromptToolContribution, placement?: PromptPlacement): () => void {
		return this.#store.addTool(input, placement);
	}

	/** Release every contribution registered under `owner`. */
	removeByOwner(owner: string): void {
		this.#store.removeByOwner(owner);
	}

	/** Release everything. Idempotent; later registrations throw. */
	close(): void {
		this.#store.close();
	}

	assemble(options: PromptLoadOptions = {}): PromptAssembly {
		return this.#store.assemble(options);
	}

	/** Deliver volatile contexts that are new, changed or marked required. */
	collectContext(options: PromptContextOptions = {}): PromptContextMessage[] {
		return this.#store.collectContext(options);
	}
}

export type { PromptVariableResolver } from "./registry";
export type {
	PromptAssembly,
	PromptCacheScope,
	PromptContextContribution,
	PromptContextMessage,
	PromptContextOptions,
	PromptContributionContext,
	PromptContributionText,
	PromptHostOptions,
	PromptHostSection,
	PromptLane,
	PromptLoadOptions,
	PromptPlacement,
	PromptScope,
	PromptSectionContribution,
	PromptToolContribution,
} from "./types";
export { DEFAULT_PROMPT_LANES, PROMPT_CACHE_SCOPES } from "./types";
