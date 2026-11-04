import { type PromptOrder, resolvePromptOrder } from "./orders";

/**
 * Named prompt section registry.
 *
 * Sections are keyed by name: a later registration shadows an earlier one, and
 * disposing it restores the previous registration. Function text renders at
 * assembly time and may return `undefined`/`null` to omit a conditional
 * section. `{{name}}` placeholders interpolate registered variables strictly —
 * a missing or unresolved variable throws instead of rendering empty text.
 * At most one visible section may be marked `complete`; it replaces the whole
 * assembled prompt.
 */

export type PromptRenderContext = Record<string, unknown>;

export type PromptTextContext = PromptRenderContext & {
	/** Resolve a registered variable; throws when it is missing or unresolved. */
	variable(name: string): string;
};

export type PromptText = string | ((context: PromptTextContext) => string | null | undefined);

export type PromptVariableResolver = (context: PromptRenderContext) => string | number | boolean | null | undefined;

export interface PromptSectionRegistration {
	name: string;
	order: PromptOrder;
	text: PromptText;
	complete?: boolean;
	/** Contribution owner; composer maps its per-source unload onto this. */
	source?: string;
}

export interface PromptSectionRegistrationOptions {
	/** Replace every existing layer for the name instead of stacking above it. */
	replace?: boolean;
	/** Interpolate `{{name}}` placeholders; new registry paths default to strict. */
	interpolate?: boolean;
}

export interface AssembledPromptSection {
	name: string;
	order: number;
	text: string;
	source: string;
}

export interface PromptAssembly {
	revision: number;
	/** Visible sections in slot order; includes the complete section when set. */
	sections: AssembledPromptSection[];
	/** The single complete section, when one is visible. */
	complete: AssembledPromptSection | null;
}

export class PromptRegistryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PromptRegistryError";
	}
}

interface RegisteredSection {
	name: string;
	order: number;
	text: PromptText;
	complete: boolean;
	source: string;
	interpolate: boolean;
}

interface RegisteredVariable {
	name: string;
	resolve: PromptVariableResolver;
}

const VARIABLE_PATTERN = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

export class PromptRegistry {
	#sections = new Map<string, RegisteredSection[]>();
	#variables = new Map<string, RegisteredVariable[]>();
	#revision = 0;

	/** Monotonic counter of structural mutations; assembly never changes it. */
	get revision(): number {
		return this.#revision;
	}

	/** Number of visible section names (shadowed layers count once). */
	get size(): number {
		return this.#sections.size;
	}

	registerSection(
		input: PromptSectionRegistration,
		source?: string,
		options: PromptSectionRegistrationOptions = {},
	): () => void {
		if (typeof input.name !== "string" || input.name.length === 0) {
			throw new TypeError("registerSection: name is required");
		}
		if (typeof input.text !== "string" && typeof input.text !== "function") {
			throw new TypeError(`registerSection: text must be a string or function for "${input.name}"`);
		}
		const order = resolvePromptOrder(input.order);
		const complete = input.complete === true;
		if (complete) {
			const owner = this.#visibleCompleteName();
			if (owner !== undefined && owner !== input.name) {
				throw new PromptRegistryError(`only one prompt section may be complete (already "${owner}")`);
			}
		}
		const registration: RegisteredSection = {
			name: input.name,
			order,
			text: input.text,
			complete,
			source: input.source ?? source ?? "anonymous",
			interpolate: options.interpolate !== false,
		};
		if (options.replace === true) {
			this.#sections.set(registration.name, [registration]);
		} else {
			const layers = this.#sections.get(registration.name);
			if (layers) layers.push(registration);
			else this.#sections.set(registration.name, [registration]);
		}
		this.#revision++;

		let disposed = false;
		return () => {
			if (disposed) return;
			this.#removeSection(registration);
			disposed = true;
		};
	}

	registerVariable(name: string, resolver: PromptVariableResolver): () => void {
		if (typeof name !== "string" || name.length === 0) {
			throw new TypeError("registerVariable: name is required");
		}
		if (typeof resolver !== "function") {
			throw new TypeError(`registerVariable: resolver is required for "${name}"`);
		}
		const registration: RegisteredVariable = { name, resolve: resolver };
		const layers = this.#variables.get(name);
		if (layers) layers.push(registration);
		else this.#variables.set(name, [registration]);
		this.#revision++;

		let disposed = false;
		return () => {
			if (disposed) return;
			disposed = true;
			this.#removeVariable(registration);
		};
	}

	/** Drop every section contributed by one owner (mode switch, extension reload). */
	removeBySource(source: string): void {
		const matches = (layer: RegisteredSection): boolean => layer.source === source;
		let found = false;
		for (const layers of this.#sections.values()) {
			if (layers.some(matches)) {
				found = true;
				break;
			}
		}
		if (!found) return;
		this.#assertNoCompleteConflict(matches);

		let removed = false;
		for (const [name, layers] of this.#sections) {
			const kept = layers.filter(layer => !matches(layer));
			if (kept.length === layers.length) continue;
			removed = true;
			if (kept.length === 0) this.#sections.delete(name);
			else this.#sections.set(name, kept);
		}
		if (removed) this.#revision++;
	}

	clear(): void {
		const changed = this.#sections.size > 0 || this.#variables.size > 0;
		this.#sections.clear();
		this.#variables.clear();
		if (changed) this.#revision++;
	}

	assemble(context: PromptRenderContext = {}): PromptAssembly {
		const resolvedVariables = new Map<string, string>();
		const variable = (name: string): string => {
			const cached = resolvedVariables.get(name);
			if (cached !== undefined) return cached;
			const entry = this.#variables.get(name)?.at(-1);
			if (!entry) throw new PromptRegistryError(`unknown prompt variable: ${name}`);
			const value = entry.resolve(context);
			if (value === undefined || value === null) {
				throw new PromptRegistryError(`unresolved prompt variable: ${name}`);
			}
			const text = String(value);
			resolvedVariables.set(name, text);
			return text;
		};
		const interpolate = (text: string): string =>
			text.replace(VARIABLE_PATTERN, (_match, name: string) => variable(name));
		const textContext: PromptTextContext = { ...context, variable };

		const sections: AssembledPromptSection[] = [];
		let complete: AssembledPromptSection | null = null;
		for (const [name, layers] of this.#sections) {
			const layer = layers.at(-1);
			if (!layer) continue;
			const rendered = typeof layer.text === "function" ? layer.text(textContext) : layer.text;
			if (rendered === undefined || rendered === null) continue;
			const section: AssembledPromptSection = {
				name,
				order: layer.order,
				text: layer.interpolate ? interpolate(rendered) : rendered,
				source: layer.source,
			};
			sections.push(section);
			if (layer.complete) {
				if (complete) {
					throw new PromptRegistryError(
						`only one prompt section may be complete (both "${complete.name}" and "${name}")`,
					);
				}
				complete = section;
			}
		}
		sections.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
		return { revision: this.#revision, sections, complete };
	}

	#visibleCompleteName(): string | undefined {
		for (const [name, layers] of this.#sections) {
			if (layers.at(-1)?.complete) return name;
		}
		return undefined;
	}

	/**
	 * Rejects a mutation that would leave two visible `complete` sections.
	 * Runs before any layer is changed so a rejected disposer/source removal
	 * keeps both the registration state and the revision untouched.
	 */
	#assertNoCompleteConflict(removed: (layer: RegisteredSection) => boolean = () => false): void {
		let owner: string | undefined;
		for (const [name, layers] of this.#sections) {
			const visible = layers.filter(layer => !removed(layer)).at(-1);
			if (!visible?.complete) continue;
			if (owner !== undefined) {
				throw new PromptRegistryError(`only one prompt section may be complete (both "${owner}" and "${name}")`);
			}
			owner = name;
		}
	}

	#removeSection(registration: RegisteredSection): void {
		const layers = this.#sections.get(registration.name);
		if (!layers) return;
		const index = layers.lastIndexOf(registration);
		if (index < 0) return;
		this.#assertNoCompleteConflict(layer => layer === registration);
		layers.splice(index, 1);
		if (layers.length === 0) this.#sections.delete(registration.name);
		this.#revision++;
	}

	#removeVariable(registration: RegisteredVariable): void {
		const layers = this.#variables.get(registration.name);
		if (!layers) return;
		const index = layers.lastIndexOf(registration);
		if (index < 0) return;
		layers.splice(index, 1);
		if (layers.length === 0) this.#variables.delete(registration.name);
		this.#revision++;
	}
}
