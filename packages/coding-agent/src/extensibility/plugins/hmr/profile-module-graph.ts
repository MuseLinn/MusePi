import { PluginGraphIdentities } from "./plugin-graph-identities";

/** A mountable profile row. `id` is the runtime record identity; `rowId` keeps
 * duplicate composition rows distinguishable even when they share an entry. */
export interface ProfileGraphTarget {
	readonly id: string;
	readonly entry: string;
	readonly rowId?: string;
}

/** The HMR view of the loader's single module walk. Dependencies contain only
 * reloadable source edges; host modules and bare packages live in `externals`. */
export interface ProfileSourceGraph {
	readonly entry: string;
	readonly dependencies: ReadonlyMap<string, ReadonlySet<string>>;
	readonly externals: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface ProfileHmrPlan {
	readonly accepted: ReadonlySet<string>;
	readonly declined: ReadonlySet<string>;
	readonly pending: ReadonlyArray<{ file: string; reason: "external" }>;
	readonly targets: readonly ProfileGraphTarget[];
	readonly changes: ReadonlyMap<string, { reason: "changed" | "missing" | "unrecorded" }>;
}

function managedFiles(graph: ProfileSourceGraph): Set<string> {
	const files = new Set<string>([graph.entry]);
	const queue = [graph.entry];
	for (let index = 0; index < queue.length; index++) {
		const file = queue[index]!;
		for (const dependency of graph.dependencies.get(file) ?? []) {
			if (files.has(dependency)) continue;
			files.add(dependency);
			queue.push(dependency);
		}
	}
	return files;
}

/** Profile-wide accepted/declined propagation over the last successfully
 * mounted source graphs. Failed replacement imports never mutate these records. */
export class ProfileModuleGraph {
	readonly #identities = new PluginGraphIdentities();
	readonly #sources = new Map<string, ProfileSourceGraph>();

	observe(target: ProfileGraphTarget, graph: ProfileSourceGraph): void {
		this.#sources.set(target.entry, graph);
		this.#identities.observe(target.entry, managedFiles(graph), undefined, () => true);
	}

	refresh(target: ProfileGraphTarget, graph: ProfileSourceGraph): void {
		this.#sources.set(target.entry, graph);
		this.#identities.refresh(target.entry, managedFiles(graph), undefined, () => true);
	}

	plan(targets: readonly ProfileGraphTarget[], changedFiles?: Iterable<string>): ProfileHmrPlan {
		const changes = changedFiles
			? new Map([...changedFiles].map(file => [file, { reason: "changed" as const }]))
			: this.#identities.changedFiles(targets.map(target => target.entry));
		const externals = new Set<string>();
		const modules = new Set<string>();
		const importers = new Map<string, Set<string>>();
		for (const target of targets) {
			const graph = this.#sources.get(target.entry);
			if (!graph) continue;
			const files = managedFiles(graph);
			for (const file of files) modules.add(file);
			for (const boundaries of graph.externals.values()) {
				for (const boundary of boundaries) {
					externals.add(boundary);
					modules.add(boundary);
				}
			}
			for (const [importer, dependencies] of graph.dependencies) {
				for (const dependency of dependencies) {
					if (!files.has(dependency)) continue;
					let parents = importers.get(dependency);
					if (!parents) {
						parents = new Set();
						importers.set(dependency, parents);
					}
					parents.add(importer);
				}
			}
		}

		const accepted = new Set<string>();
		const pending: Array<{ file: string; reason: "external" }> = [];
		const queue: string[] = [];
		for (const file of changes.keys()) {
			if (externals.has(file)) pending.push({ file, reason: "external" });
			else if (!accepted.has(file)) {
				accepted.add(file);
				queue.push(file);
			}
		}
		for (let index = 0; index < queue.length; index++) {
			const file = queue[index]!;
			for (const importer of importers.get(file) ?? []) {
				if (accepted.has(importer)) continue;
				accepted.add(importer);
				queue.push(importer);
			}
		}

		const affected = targets.filter(target => {
			const graph = this.#sources.get(target.entry);
			if (!graph) return changes.has(target.entry);
			for (const file of managedFiles(graph)) {
				if (accepted.has(file)) return true;
			}
			return false;
		});
		return {
			accepted,
			declined: new Set([...modules].filter(file => !accepted.has(file))),
			pending,
			targets: affected,
			changes,
		};
	}

	clear(): void {
		this.#sources.clear();
		this.#identities.clear();
	}
}
