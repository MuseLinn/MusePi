/**
 * Contribution storage for one prompt host.
 *
 * Entries are keyed by contribution name after resolution. Resolution walks a
 * view scope's chain and picks, per name, the narrowest scope, then the highest
 * lane, then the latest registration. Disposers and owner removal are atomic:
 * a mutation that would expose two visible complete sections throws and leaves
 * every entry and the revision untouched.
 */
import { resolvePromptOrder } from "./orders";
import { PromptRegistryError, type PromptVariableResolver } from "./registry";
import { promptScopeContains } from "./scope";
import {
	PROMPT_CACHE_SCOPES,
	type PromptAssembly,
	type PromptCacheScope,
	type PromptContextContribution,
	type PromptContextMessage,
	type PromptContextOptions,
	type PromptContributionContext,
	type PromptContributionText,
	type PromptHostSection,
	type PromptLoadOptions,
	type PromptPlacement,
	type PromptScope,
	type PromptSectionContribution,
	type PromptToolContribution,
} from "./types";

const VARIABLE_PATTERN = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

interface StoredEntry {
	scope: PromptScope;
	lane: string;
	laneRank: number;
	owner: string;
	seq: number;
}

interface StoredSection extends StoredEntry {
	kind: "section" | "tool";
	name: string;
	order: number;
	text: PromptContributionText;
	complete: boolean;
	/** When false, `{{name}}` sequences in the rendered text stay literal. */
	interpolate: boolean;
	cacheScope: PromptCacheScope;
	tool?: { tool: string; wireNames: readonly string[] };
}

interface StoredContext extends StoredEntry {
	name: string;
	text: PromptContributionText;
	/** When false, `{{name}}` sequences in the rendered text stay literal. */
	interpolate: boolean;
	cacheScope: PromptCacheScope;
	required: boolean;
}

interface StoredVariable extends StoredEntry {
	name: string;
	resolve: PromptVariableResolver;
}

interface PromptStoreOptions {
	root: PromptScope;
	lanes: readonly string[];
	defaultOwner: string;
}

interface SectionSelection {
	activeTools?: readonly string[];
	extra?: StoredSection;
	skip?: (entry: StoredSection) => boolean;
}

export class PromptStore {
	#root: PromptScope;
	#lanes: readonly string[];
	#defaultOwner: string;
	#sections: StoredSection[] = [];
	#contexts: StoredContext[] = [];
	#variables: StoredVariable[] = [];
	#scopes = new Set<PromptScope>();
	#delivered = new Map<string, string>();
	#revision = 0;
	#seq = 0;
	#closed = false;

	constructor(options: PromptStoreOptions) {
		if (options.lanes.length === 0) throw new TypeError("prompt host: at least one lane is required");
		if (new Set(options.lanes).size !== options.lanes.length) {
			throw new TypeError("prompt host: lanes must be unique");
		}
		this.#root = options.root;
		this.#lanes = [...options.lanes];
		this.#defaultOwner = options.defaultOwner;
		this.#scopes.add(options.root);
	}

	get revision(): number {
		return this.#revision;
	}

	get closed(): boolean {
		return this.#closed;
	}

	trackScope(scope: PromptScope): void {
		this.#scopes.add(scope);
	}

	addSection(input: PromptSectionContribution, placement?: PromptPlacement): () => void {
		this.#assertOpen();
		if (typeof input.name !== "string" || input.name.length === 0) {
			throw new TypeError("registerSection: name is required");
		}
		if (typeof input.text !== "string" && typeof input.text !== "function") {
			throw new TypeError(`registerSection: text must be a string or function for "${input.name}"`);
		}
		const entry: StoredSection = {
			kind: "section",
			name: input.name,
			order: resolvePromptOrder(input.order),
			text: input.text,
			complete: input.complete === true,
			interpolate: input.interpolate !== false,
			cacheScope: this.#resolveCacheScope(input.cacheScope, "prefix"),
			...this.#placement(placement, input.owner),
			seq: ++this.#seq,
		};
		if (entry.complete) this.#assertCompleteValid(entry);
		this.#sections.push(entry);
		this.#revision++;
		return this.#disposer(entry);
	}

	addContext(input: PromptContextContribution, placement?: PromptPlacement): () => void {
		this.#assertOpen();
		if (typeof input.name !== "string" || input.name.length === 0) {
			throw new TypeError("registerContext: name is required");
		}
		if (typeof input.text !== "string" && typeof input.text !== "function") {
			throw new TypeError(`registerContext: text must be a string or function for "${input.name}"`);
		}
		const entry: StoredContext = {
			name: input.name,
			text: input.text,
			interpolate: input.interpolate !== false,
			cacheScope: this.#resolveCacheScope(input.cacheScope, "turn"),
			required: input.required === true,
			...this.#placement(placement, input.owner),
			seq: ++this.#seq,
		};
		this.#contexts.push(entry);
		this.#revision++;
		return this.#contextDisposer(entry);
	}

	addTool(input: PromptToolContribution, placement?: PromptPlacement): () => void {
		this.#assertOpen();
		if (typeof input.tool !== "string" || input.tool.length === 0) {
			throw new TypeError("registerTool: tool is required");
		}
		if (typeof input.text !== "string" && typeof input.text !== "function") {
			throw new TypeError(`registerTool: text must be a string or function for "${input.tool}"`);
		}
		const name = input.name ?? `tool:${input.tool}`;
		const wireNames = input.wireNames ? [...input.wireNames] : [input.tool];
		if (wireNames.some(value => typeof value !== "string" || value.length === 0)) {
			throw new TypeError(`registerTool: wireNames must be non-empty strings for "${input.tool}"`);
		}
		const entry: StoredSection = {
			kind: "tool",
			name,
			order: resolvePromptOrder(input.order ?? "tool"),
			text: input.text,
			complete: false,
			interpolate: true,
			cacheScope: this.#resolveCacheScope(input.cacheScope, "prefix"),
			tool: { tool: input.tool, wireNames },
			...this.#placement(placement, input.owner),
			seq: ++this.#seq,
		};
		this.#sections.push(entry);
		this.#revision++;
		return this.#disposer(entry);
	}

	addVariable(name: string, resolve: PromptVariableResolver, placement?: PromptPlacement): () => void {
		this.#assertOpen();
		if (typeof name !== "string" || name.length === 0) {
			throw new TypeError("registerVariable: name is required");
		}
		if (typeof resolve !== "function") {
			throw new TypeError(`registerVariable: resolver is required for "${name}"`);
		}
		const entry: StoredVariable = {
			name,
			resolve,
			...this.#placement(placement),
			seq: ++this.#seq,
		};
		this.#variables.push(entry);
		this.#revision++;
		let disposed = false;
		return () => {
			if (disposed) return;
			const index = this.#variables.lastIndexOf(entry);
			if (index < 0) return;
			disposed = true;
			this.#variables.splice(index, 1);
			this.#revision++;
		};
	}

	removeByOwner(owner: string): void {
		const sections = this.#sections.filter(entry => entry.owner === owner);
		const contexts = this.#contexts.filter(entry => entry.owner === owner);
		const variables = this.#variables.filter(entry => entry.owner === owner);
		if (sections.length === 0 && contexts.length === 0 && variables.length === 0) return;

		if (sections.length > 0) {
			const removed = new Set(sections);
			this.#assertCompleteValid(undefined, entry => removed.has(entry));
		}
		this.#sections = this.#sections.filter(entry => entry.owner !== owner);
		this.#contexts = this.#contexts.filter(entry => entry.owner !== owner);
		this.#variables = this.#variables.filter(entry => entry.owner !== owner);
		this.#revision++;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		const changed = this.#sections.length > 0 || this.#contexts.length > 0 || this.#variables.length > 0;
		this.#sections = [];
		this.#contexts = [];
		this.#variables = [];
		this.#delivered.clear();
		if (changed) this.#revision++;
	}

	assemble(options: PromptLoadOptions = {}): PromptAssembly {
		const scope = options.scope ?? this.#root;
		const activeTools = options.activeTools ?? [];
		const context = options.context ?? {};
		const variable = this.#variableResolver(scope, context);
		const effective = this.#effectiveSections(scope, { activeTools });
		if (this.#visibleComplete(effective) > 1) {
			throw new PromptRegistryError(this.#completeConflictMessage(effective));
		}

		const rendered: Array<{ entry: StoredSection; section: PromptHostSection }> = [];
		for (const [name, entry] of effective) {
			const text = this.#render(entry.text, context, variable, {
				activeTools,
				cacheScope: entry.cacheScope,
				interpolate: entry.interpolate,
				tool: entry.tool?.tool,
				wireName: entry.tool ? this.#activeWireName(entry, activeTools) : undefined,
			});
			if (text === null) continue;
			if (options.cacheScope && options.cacheScope !== "all" && entry.cacheScope !== options.cacheScope) continue;
			rendered.push({
				entry,
				section: {
					name,
					order: entry.order,
					text,
					source: entry.owner,
					owner: entry.owner,
					lane: entry.lane,
					cacheScope: entry.cacheScope,
				},
			});
		}
		rendered.sort((a, b) => a.section.order - b.section.order || a.section.name.localeCompare(b.section.name));
		const sections = rendered.map(item => item.section);
		const complete = rendered.find(item => item.entry.complete)?.section ?? null;
		return { revision: this.#revision, sections, complete };
	}

	collectContext(options: PromptContextOptions = {}): PromptContextMessage[] {
		const scope = options.scope ?? this.#root;
		const context = options.context ?? {};
		const activeTools = options.activeTools ?? [];
		const variable = this.#variableResolver(scope, context);
		const effective = this.#effectiveContexts(scope);
		const ordered = [...effective.values()].sort(
			(a, b) =>
				PROMPT_CACHE_SCOPES.indexOf(a.cacheScope) - PROMPT_CACHE_SCOPES.indexOf(b.cacheScope) ||
				a.name.localeCompare(b.name),
		);

		const seen = new Set<string>();
		const messages: PromptContextMessage[] = [];
		for (const entry of ordered) {
			if (options.cacheScope && options.cacheScope !== "all" && entry.cacheScope !== options.cacheScope) continue;
			const text = this.#render(entry.text, context, variable, {
				activeTools,
				cacheScope: entry.cacheScope,
				interpolate: entry.interpolate,
			});
			if (text === null || text.length === 0) continue;
			if (seen.has(text)) continue;
			seen.add(text);

			if (options.recordDelivery !== false) {
				const key = `${entry.cacheScope}:${entry.name}`;
				if (!entry.required && this.#delivered.get(key) === text) continue;
				this.#delivered.set(key, text);
			}
			messages.push({
				name: entry.name,
				text,
				cacheScope: entry.cacheScope,
				required: entry.required,
				lane: entry.lane,
				owner: entry.owner,
			});
		}
		return messages;
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("prompt host is closed");
	}

	#placement(
		placement: PromptPlacement | undefined,
		owner?: string,
	): Pick<StoredEntry, "scope" | "lane" | "laneRank" | "owner"> {
		const scope = placement?.scope ?? this.#root;
		const lane = placement?.lane ?? this.#lanes[0] ?? "core";
		const laneRank = this.#lanes.indexOf(lane);
		if (laneRank < 0) throw new TypeError(`unknown prompt lane: ${lane}`);
		this.#scopes.add(scope);
		return { scope, lane, laneRank, owner: owner ?? placement?.owner ?? this.#defaultOwner };
	}

	#resolveCacheScope(value: PromptCacheScope | undefined, fallback: PromptCacheScope): PromptCacheScope {
		const scope = value ?? fallback;
		if (!PROMPT_CACHE_SCOPES.includes(scope)) {
			throw new TypeError(`unknown prompt cacheScope: ${String(scope)}`);
		}
		return scope;
	}

	#disposer(entry: StoredSection): () => void {
		let disposed = false;
		return () => {
			if (disposed) return;
			const index = this.#sections.lastIndexOf(entry);
			if (index < 0) return;
			this.#assertCompleteValid(undefined, candidate => candidate === entry);
			disposed = true;
			this.#sections.splice(index, 1);
			this.#revision++;
		};
	}

	#contextDisposer(entry: StoredContext): () => void {
		let disposed = false;
		return () => {
			if (disposed) return;
			const index = this.#contexts.lastIndexOf(entry);
			if (index < 0) return;
			disposed = true;
			this.#contexts.splice(index, 1);
			this.#revision++;
		};
	}

	#isBetter(candidate: StoredEntry, current: StoredEntry): boolean {
		if (candidate.scope.depth !== current.scope.depth) return candidate.scope.depth > current.scope.depth;
		if (candidate.laneRank !== current.laneRank) return candidate.laneRank > current.laneRank;
		return candidate.seq > current.seq;
	}

	#effectiveSections(view: PromptScope, selection: SectionSelection): Map<string, StoredSection> {
		const effective = new Map<string, StoredSection>();
		const consider = (entry: StoredSection): void => {
			if (selection.skip?.(entry)) return;
			if (entry.kind === "tool") {
				if (selection.activeTools === undefined) return;
				if (!this.#activeWireName(entry, selection.activeTools)) return;
			}
			if (!promptScopeContains(view, entry.scope)) return;
			const current = effective.get(entry.name);
			if (!current || this.#isBetter(entry, current)) effective.set(entry.name, entry);
		};
		for (const entry of this.#sections) consider(entry);
		if (selection.extra) consider(selection.extra);
		return effective;
	}

	#effectiveContexts(view: PromptScope): Map<string, StoredContext> {
		const effective = new Map<string, StoredContext>();
		for (const entry of this.#contexts) {
			if (!promptScopeContains(view, entry.scope)) continue;
			const current = effective.get(entry.name);
			if (!current || this.#isBetter(entry, current)) effective.set(entry.name, entry);
		}
		return effective;
	}

	#effectiveVariables(view: PromptScope): Map<string, StoredVariable> {
		const effective = new Map<string, StoredVariable>();
		for (const entry of this.#variables) {
			if (!promptScopeContains(view, entry.scope)) continue;
			const current = effective.get(entry.name);
			if (!current || this.#isBetter(entry, current)) effective.set(entry.name, entry);
		}
		return effective;
	}

	#variableResolver(view: PromptScope, context: Record<string, unknown>): (name: string) => string {
		const effective = this.#effectiveVariables(view);
		const cache = new Map<string, string>();
		return (name: string): string => {
			const cached = cache.get(name);
			if (cached !== undefined) return cached;
			const entry = effective.get(name);
			if (!entry) throw new PromptRegistryError(`unknown prompt variable: ${name}`);
			const value = entry.resolve(context);
			if (value === undefined || value === null) {
				throw new PromptRegistryError(`unresolved prompt variable: ${name}`);
			}
			const text = String(value);
			cache.set(name, text);
			return text;
		};
	}

	#render(
		text: PromptContributionText,
		context: Record<string, unknown>,
		variable: (name: string) => string,
		extra: Pick<PromptContributionContext, "activeTools" | "cacheScope" | "tool" | "wireName"> & {
			interpolate: boolean;
		},
	): string | null {
		const textContext: PromptContributionContext = { ...context, ...extra, variable };
		const rendered = typeof text === "function" ? text(textContext) : text;
		if (rendered === undefined || rendered === null) return null;
		if (!extra.interpolate) return rendered;
		return rendered.replace(VARIABLE_PATTERN, (_match, name: string) => variable(name));
	}

	#activeWireName(entry: StoredSection, activeTools: readonly string[]): string | undefined {
		if (!entry.tool) return undefined;
		for (const name of entry.tool.wireNames) {
			if (activeTools.includes(name)) return name;
		}
		return activeTools.includes(entry.tool.tool) ? entry.tool.tool : undefined;
	}

	#visibleComplete(effective: Map<string, StoredSection>): number {
		let count = 0;
		for (const entry of effective.values()) if (entry.complete) count++;
		return count;
	}

	#completeConflictMessage(effective: Map<string, StoredSection>): string {
		const names = [...effective.values()].filter(entry => entry.complete).map(entry => entry.name);
		return `only one prompt section may be complete (both "${names[0]}" and "${names[1]}")`;
	}

	/**
	 * Rejects a mutation that would leave two visible complete sections in any
	 * known scope. Runs before the mutation so a rejected disposer or owner
	 * removal keeps every entry and the revision untouched.
	 */
	#assertCompleteValid(extra?: StoredSection, skip?: (entry: StoredSection) => boolean): void {
		for (const scope of this.#scopes) {
			const effective = this.#effectiveSections(scope, { activeTools: undefined, extra, skip });
			const complete = [...effective.values()].filter(entry => entry.complete);
			if (complete.length > 1) {
				throw new PromptRegistryError(
					`only one prompt section may be complete (both "${complete[0]?.name}" and "${complete[1]?.name}")`,
				);
			}
		}
	}
}
