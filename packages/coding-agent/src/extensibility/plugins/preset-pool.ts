/**
 * Preset generations shared by sessions (dsh's agent-preset registry).
 *
 * dsh mounts a preset once and lets every session of that preset join its
 * scope; a generation is retired when its definition changes and disposed when
 * the last user leaves. This is the same model, keyed by the event-bus owner
 * (one session runtime set) plus the preset id, because a preset's plugin
 * instances bind the runtime they were mounted on.
 */
import type { PresetPluginRow } from "../../presets/resolve";
import type { EventBus } from "../../utils/event-bus";
import type { PresetEntryResolver } from "./preset-registry";
import { CordisPresetRuntime, type MountedPresetPlugin } from "./preset-runtime";
import type { MountContext } from "./runtime/mount";

interface PooledGeneration {
	/** Definition fingerprint; a changed preset replaces the generation. */
	hash: string;
	runtime: CordisPresetRuntime;
	records: MountedPresetPlugin[];
	errors: Array<{ path: string; error: string }>;
	users: number;
	retired: boolean;
}

const pools = new WeakMap<object, Map<string, PooledGeneration>>();

export interface PresetLeaseOptions {
	cwd: string;
	eventBus: EventBus;
	runtime: MountContext["runtime"];
	readConfig: MountContext["readConfig"];
	entryResolver: PresetEntryResolver;
}

export interface PresetLease {
	readonly runtime: CordisPresetRuntime;
	readonly records: MountedPresetPlugin[];
	readonly errors: Array<{ path: string; error: string }>;
	/** Scope key its plugins' instance listeners carry. */
	readonly key: object;
	/** Leave this generation; the last user of a retired one disposes it. */
	release(): void;
}

/** Acquire (or join) the generation for one preset on one runtime. */
export async function acquirePreset(
	host: object,
	id: string,
	rows: readonly PresetPluginRow[],
	options: PresetLeaseOptions,
): Promise<PresetLease> {
	let pool = pools.get(host);
	if (!pool) {
		pool = new Map();
		pools.set(host, pool);
	}
	const hash = JSON.stringify(rows);
	let generation = pool.get(id);
	if (!generation || generation.hash !== hash) {
		if (generation) {
			generation.retired = true;
			if (generation.users === 0) void generation.runtime.dispose();
		}
		const runtime = new CordisPresetRuntime({ ...options });
		const result = await runtime.mount(rows);
		generation = {
			hash,
			runtime,
			records: result.records,
			errors: result.errors,
			users: 0,
			retired: false,
		};
		pool.set(id, generation);
	}
	const joined = generation;
	joined.users += 1;
	let released = false;
	return {
		runtime: joined.runtime,
		records: joined.records,
		errors: joined.errors,
		key: joined.runtime.key,
		release(): void {
			if (released) return;
			released = true;
			joined.users = Math.max(0, joined.users - 1);
			if (joined.users === 0 && joined.retired) void joined.runtime.dispose();
		},
	};
}
