/**
 * Composable settings registry.
 *
 * The core schema in `settings-schema.ts` and settings contributed by a provider
 * or extension describe the same shape; this registry is the single place they
 * are composed. Hosts (TUI, GUI, daemon RPC) read descriptors here instead of
 * iterating one static table, so a plugin-owned setting is visible without a
 * host change.
 *
 * Phase contract: values still live in `Settings`; the registry owns metadata
 * and defaults only. Removing a descriptor therefore never deletes a stored
 * value, and a missing provider leaves the core fallback descriptor in place.
 */

export type SettingDescriptorType = "boolean" | "enum" | "string" | "number" | "array" | "record";

export interface SettingOptionDescriptor {
	value: string;
	label: string;
	description?: string;
}

/** A condition that can travel over the wire: evaluate against one key's value. */
export interface DeclarativeSettingCondition {
	key: string;
	equals?: unknown;
	notEquals?: unknown;
	in?: readonly unknown[];
}

export type SettingCondition = string | DeclarativeSettingCondition;

/** Evaluate a descriptor's visibility gate against a value reader. */
export function evaluateSettingCondition(
	condition: SettingCondition | undefined,
	read: (key: string) => unknown,
): boolean {
	if (condition === undefined) return true;
	if (typeof condition === "string") return true;
	const value = read(condition.key);
	if ("equals" in condition && !Object.is(value, condition.equals)) return false;
	if ("notEquals" in condition && Object.is(value, condition.notEquals)) return false;
	if (condition.in && !condition.in.some(entry => Object.is(entry, value))) return false;
	return true;
}

export interface SettingUiDescriptor {
	tab: string;
	group?: string;
	label: string;
	description?: string;
	options?: readonly SettingOptionDescriptor[] | "runtime";
	/** Declarative visibility gate; the host evaluates it against current values. */
	condition?: SettingCondition;
	hidden?: boolean;
	tuiOnly?: boolean;
	ordered?: boolean;
	item?: "record";
	secret?: boolean;
	[key: string]: unknown;
}

export interface SettingDescriptor {
	key: string;
	type: SettingDescriptorType;
	default: unknown;
	values?: readonly string[];
	ui?: SettingUiDescriptor;
	/** Never echo this value back to a UI or export it without an explicit request. */
	credential?: boolean;
	/** Host-side write guard; return a message to refuse the write. */
	validate?: (value: unknown) => string | void;
}

export type SettingDescriptorSource = "core" | "provider" | "extension" | (string & {});

export interface RegisteredSettingDescriptor {
	descriptor: SettingDescriptor;
	source: SettingDescriptorSource;
	/** Live owners of this key (several sessions may mount one extension). */
	owners: Set<string>;
}

/**
 * Ordered descriptor registry. Insertion order is preserved, so a tab renders in
 * the same order the descriptors were declared (core first, then providers).
 */
export class SettingsRegistry {
	readonly #entries = new Map<string, RegisteredSettingDescriptor>();
	readonly #listeners = new Set<() => void>();

	/**
	 * Register one descriptor. The same source may claim the key again (a reload
	 * or a second session mounting the same extension): the latest descriptor
	 * wins and each caller gets its own disposer. A different source is refused,
	 * because two owners for one key would make the rendered metadata depend on
	 * load order.
	 */
	register(
		descriptor: SettingDescriptor,
		source: SettingDescriptorSource = "provider",
		owner: string = source,
	): () => void {
		const existing = this.#entries.get(descriptor.key);
		if (existing && existing.source !== source) {
			throw new Error(
				`Setting "${descriptor.key}" is already registered by ${existing.source}; ` +
					`${source} cannot claim the same key.`,
			);
		}
		if (existing) {
			existing.descriptor = descriptor;
			existing.owners.add(owner);
		} else {
			this.#entries.set(descriptor.key, { descriptor, source, owners: new Set([owner]) });
		}
		this.#emit();
		return () => {
			const entry = this.#entries.get(descriptor.key);
			if (!entry) return;
			if (!entry.owners.delete(owner)) return;
			if (entry.owners.size === 0) this.#entries.delete(descriptor.key);
			this.#emit();
		};
	}

	registerMany(descriptors: readonly SettingDescriptor[], source: SettingDescriptorSource): () => void {
		const disposers = descriptors.map(descriptor => this.register(descriptor, source));
		return () => {
			for (const dispose of disposers) dispose();
		};
	}

	get(key: string): SettingDescriptor | undefined {
		return this.#entries.get(key)?.descriptor;
	}

	has(key: string): boolean {
		return this.#entries.has(key);
	}

	keys(): string[] {
		return [...this.#entries.keys()];
	}

	entries(): Array<[string, SettingDescriptor]> {
		return [...this.#entries.entries()].map(([key, entry]) => [key, entry.descriptor]);
	}

	/** Descriptors whose `ui.tab` matches, in registration order. */
	pathsForTab(tab: string): string[] {
		return this.keys().filter(key => this.get(key)?.ui?.tab === tab);
	}

	/** Drop every descriptor contributed by one source (plugin unload). */
	clearSource(source: SettingDescriptorSource): void {
		let changed = false;
		for (const [key, entry] of this.#entries) {
			if (entry.source !== source) continue;
			this.#entries.delete(key);
			changed = true;
		}
		if (changed) this.#emit();
	}

	onDidChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	#emit(): void {
		for (const listener of this.#listeners) listener();
	}
}

export const settingsRegistry = new SettingsRegistry();
