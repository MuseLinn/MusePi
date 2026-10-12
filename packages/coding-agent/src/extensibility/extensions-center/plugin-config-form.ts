/**
 * Plugin config forms — the settings contract a configuration-heavy plugin
 * needs, layered over the existing plugin-config store.
 *
 * `settingsScope` (the proxy a slot component receives) is a bare
 * `{ get, set }`. It is enough for a switch, and not enough for a real form,
 * because it has no answer to the two questions a form always asks:
 *
 * - **Did I lose a race?** Two writes issued from one editor — or one from the
 *   panel and one from an extension reload — silently clobber each other. A
 *   revision fence makes the loser observable instead of invisible.
 * - **Is this value mine, or inherited?** Without a base/user split a form
 *   cannot tell "the user set this to the default value" from "the user never
 *   touched it", so it cannot offer a reset. The presence of the key in the user
 *   layer is what marks an override — comparing values cannot see it, and the
 *   reference documents exactly that trap.
 *
 * What is reproduced from the reference (`ConfigFormController`):
 * the snapshot shape (`status`/`value`/`base`/`user`/`revision`/`writable`/
 * `mode`), a revision that fences each write, `mutate` taking an expected
 * revision, and `unset` clearing a field back to inheritance.
 *
 * What is deliberately NOT reproduced: the reference folds Host answers back
 * into a shared describe mirror and serializes writes against it. This host has
 * no such mirror — writes go straight to the plugin-config store — so the
 * revision is a store-level fence instead, and no async tail has to be awaited
 * before a snapshot is consistent.
 *
 * @module extensibility/extensions-center/plugin-config-form
 */

import type { ConfigFieldDesc, PluginConfigValues } from "@musepi/pi-wire";
import { coerceConfigFieldValue } from "@musepi/pi-wire";
import {
	getPluginConfigPath,
	type PluginConfigStore,
	readPluginConfigStore,
	resetPluginConfigStoreCache,
} from "./plugin-config-store";

/** Why a namespace has no usable form. */
export type ConfigFormStatus =
	/** The namespace is present and writable. */
	| "ready"
	/** Present but the store is not writable (read-only home). */
	| "readonly"
	/** The namespace is not exposed to this client. */
	| "unavailable";

/** One field edit. `unset` clears the user layer so the value re-inherits. */
export type ConfigFieldOp =
	| { readonly kind: "set"; readonly field: string; readonly value: unknown }
	| { readonly kind: "unset"; readonly field: string };

/** The view a form renders from. */
export interface ConfigFormSnapshot {
	readonly status: ConfigFormStatus;
	/** Effective values: the composition base with the user layer over it. */
	readonly value: PluginConfigValues | undefined;
	/** What the plugin's own manifest declares — what a cleared field returns to. */
	readonly base: PluginConfigValues | undefined;
	/** The raw user layer. Key PRESENCE marks an override, regardless of value. */
	readonly user: PluginConfigValues | undefined;
	/** Revision fencing the next write; absent before the first read. */
	readonly revision: number | undefined;
	readonly writable: boolean;
	/** `host` persists across restarts; `memory` is process-local. */
	readonly mode: "host" | "memory";
}

/** The form API a plugin's settings surface receives. */
export interface ConfigForm {
	getSnapshot(): ConfigFormSnapshot;
	subscribe(listener: () => void): () => void;
	/** Apply one atomic batch of field edits. */
	mutate(ops: readonly ConfigFieldOp[], expectedRevision?: number): Promise<boolean>;
	/** Write one field (a single-op batch). */
	set(field: string, value: unknown): Promise<boolean>;
	/** Clear one field so it re-inherits from the manifest default. */
	unset(field: string): Promise<boolean>;
}

/** Per-namespace revision, monotonically bumped on every accepted write. */
const revisions = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();

/** Read the store revision for a namespace, initialising it on first read. */
function revisionOf(namespace: string): number {
	const current = revisions.get(namespace);
	if (current !== undefined) return current;
	revisions.set(namespace, 0);
	return 0;
}

function notify(namespace: string): void {
	for (const listener of listeners.get(namespace) ?? []) listener();
}

/** Compose the effective values: base overridden by the user layer. */
function compose(base: PluginConfigValues | undefined, user: PluginConfigValues | undefined): PluginConfigValues {
	return { ...(base ?? {}), ...(user ?? {}) };
}

/**
 * The manifest-declared defaults for one namespace.
 *
 * A plugin declares its config fields (`musepi.config` in its manifest); the
 * declared defaults are the composition base. A plugin that declares nothing
 * has an empty base, so every value it holds is by definition a user override.
 */
function baseOf(fields: readonly ConfigFieldDesc[] | undefined): PluginConfigValues {
	const base: PluginConfigValues = {};
	for (const field of fields ?? []) {
		if (field.default !== undefined) base[field.key] = field.default;
	}
	return base;
}

/**
 * Build a form over one namespace.
 *
 * @param namespace - the extension id (`kind:name`) owning the values.
 * @param fields - the namespace's declared config fields, when the caller has
 *   them; their defaults become the composition base.
 * @param storePath - overrides the store file (tests inject a temp path).
 */
export async function createPluginConfigForm(
	namespace: string,
	fields?: readonly ConfigFieldDesc[],
	storePath: string = getPluginConfigPath(),
): Promise<ConfigForm> {
	const store: PluginConfigStore = await readPluginConfigStore(storePath);
	const user: PluginConfigValues = (store[namespace] ?? {}) as PluginConfigValues;
	const base = baseOf(fields);
	const revision = revisionOf(namespace);
	let snapshot: ConfigFormSnapshot = {
		status: "ready",
		value: compose(base, user),
		base,
		user,
		revision,
		writable: true,
		mode: modeOf(storePath),
	};

	const setSnapshot = (next: ConfigFormSnapshot): void => {
		snapshot = next;
		notify(namespace);
	};

	/** Apply one atomic batch of field edits. */
	const mutate = async (ops: readonly ConfigFieldOp[], expectedRevision?: number): Promise<boolean> => {
		// The fence: a caller that read revision N must not overwrite a write
		// that already advanced the namespace past N.
		const current = revisionOf(namespace);
		if (expectedRevision !== undefined && expectedRevision !== current) return false;
		if (ops.length === 0) return true;

		const nextUser: PluginConfigValues = { ...(snapshot.user ?? {}) };
		for (const op of ops) {
			if (op.kind === "set") nextUser[op.field] = op.value;
			else delete nextUser[op.field];
		}
		const clamped = clamp(nextUser, fields);
		await writePluginConfigStore(namespace, clamped, storePath);

		const nextRevision = current + 1;
		revisions.set(namespace, nextRevision);
		setSnapshot({
			status: "ready",
			value: compose(base, clamped),
			base,
			user: clamped,
			revision: nextRevision,
			writable: true,
			mode: snapshot.mode,
		});
		return true;
	};

	return {
		getSnapshot: () => snapshot,

		subscribe(listener: () => void): () => void {
			const set = listeners.get(namespace) ?? new Set();
			set.add(listener);
			listeners.set(namespace, set);
			return () => {
				set.delete(listener);
			};
		},

		mutate,

		set: (field: string, value: unknown): Promise<boolean> => mutate([{ kind: "set", field, value }]),

		unset: (field: string): Promise<boolean> => mutate([{ kind: "unset", field }]),
	};
}

/**
 * Whether values outlive the process.
 *
 * `host` when the store resolves under the user's real config directory — the
 * ordinary daemon case. An injected path (tests, a portable install) is
 * `memory`: still persisted to that file, but not the host's own state, so a
 * form must not claim a value will survive a restart elsewhere.
 */
function modeOf(storePath: string): "host" | "memory" {
	return storePath === getPluginConfigPath() ? "host" : "memory";
}

/**
 * Clamp the values a caller actually set, without filling in the rest.
 *
 * `coerceConfigValues` returns a value for EVERY declared field (filling absent
 * ones with their default), which is right for a management form's effective
 * view and wrong for the user layer: it would put a key where the user never
 * set one, and key presence is exactly what marks an override. So clamping walks
 * the keys the caller supplied and leaves the rest absent.
 */
function clamp(values: PluginConfigValues, fields: readonly ConfigFieldDesc[] | undefined): PluginConfigValues {
	if (!fields || fields.length === 0) return values;
	const out: PluginConfigValues = {};
	const byKey = new Map(fields.map(field => [field.key, field]));
	for (const [key, value] of Object.entries(values)) {
		const desc = byKey.get(key);
		// An undeclared key is dropped: the manifest is the schema, and keeping
		// unknown keys would strand values no field can ever render or reset.
		if (!desc) continue;
		out[key] = coerceConfigFieldValue(desc, value);
	}
	return out;
}

/**
 * Replace a namespace's whole user layer.
 *
 * A whole-namespace rewrite rather than per-key, because `unset` removes a key
 * and there is no single-key write primitive for that. The store's own cache is
 * dropped and re-read so the next reader sees what was just persisted.
 */
async function writePluginConfigStore(namespace: string, values: PluginConfigValues, storePath: string): Promise<void> {
	const store: PluginConfigStore = await readPluginConfigStore(storePath);
	const next: PluginConfigStore = { ...store, [namespace]: values };
	await Bun.write(storePath, JSON.stringify(next, null, "\t"));
	resetPluginConfigStoreCache();
	await readPluginConfigStore(storePath);
}
