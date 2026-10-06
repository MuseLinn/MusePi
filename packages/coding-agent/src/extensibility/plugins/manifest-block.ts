/**
 * The one place that decides which `package.json` field declares a plugin.
 *
 * A plugin declares itself under `musepi`. `omp` and `pi` are the upstream
 * names that predate it and stay readable so an older package keeps working.
 * Every reader of a plugin's declaration goes through {@link readPluginBlock}
 * so that adding a fourth spelling is one edit rather than one per reader — and
 * so that a reader written before `musepi` existed cannot silently start
 * treating a `musepi`-only package as an ordinary npm dependency.
 *
 * The failure that motivated this: `PluginManager` read only `omp` and `pi`,
 * while the loader, the installer, and the capability report all preferred
 * `musepi`. A package declaring only `musepi` therefore installed and loaded
 * correctly but arrived from `list()` as `{ version }`, which disabled the
 * install-time extension check and made `doctor` report "no manifest" for a
 * plugin that had one.
 *
 * @module extensibility/plugins/manifest-block
 */

/** The three fields a plugin may declare itself under, most authoritative first. */
const BLOCK_FIELDS = ["musepi", "omp", "pi"] as const;

/** The package.json fields this module reads. */
export interface PluginPackageJson {
	readonly version?: string;
	readonly description?: string;
	readonly musepi?: unknown;
	readonly omp?: unknown;
	readonly pi?: unknown;
}

/**
 * The plugin declaration block in a package.json, or `undefined` when the
 * package declares none.
 *
 * Precedence is `musepi`, then `omp`, then `pi`. A field present but not an
 * object is skipped rather than returned: a `"musepi": true` typo should fall
 * through to a readable legacy field, not surface as a manifest that validates
 * nothing.
 *
 * @param pkg - the parsed `package.json`.
 * @returns the declaration block, or `undefined` if none of the three fields
 * holds an object.
 */
export function readPluginBlock<T>(pkg: PluginPackageJson | null | undefined): T | undefined {
	if (!pkg) return undefined;
	for (const field of BLOCK_FIELDS) {
		const block = pkg[field];
		if (block !== null && typeof block === "object") return block as T;
	}
	return undefined;
}

/**
 * Whether a package declares a plugin block under any of the three fields.
 *
 * @param pkg - the parsed `package.json`.
 * @returns `true` when a plugin declaration is present.
 */
export function hasPluginBlock(pkg: PluginPackageJson | null | undefined): boolean {
	return readPluginBlock(pkg) !== undefined;
}
