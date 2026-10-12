/**
 * Bundle application — read an installed bundle's patch files into ordered
 * layers and hand them to the composer.
 *
 * `dsh-bundle.ts` (the inventory reader) established that this host can parse
 * a bundle's declaration and say what it would contribute. This module is the
 * step after that: it produces the **layers** `dsh-layers.composeDshLayers`
 * folds, so a bundle's rows become a composition a caller can act on — mount,
 * report, or diff — instead of a description of rows nothing will use.
 *
 * The order is DSH's (`deepseek-harness/packages/boot/app-boot/src/profile-context.ts:63-74`):
 * bundle layers first (in the order the profile lists its bundles), then the
 * profile's own patch file, then the home patch, then launch overlays. Later
 * layers win.
 *
 * What is still NOT done here, and is reported rather than faked:
 *
 * - **`!!js` expressions are never evaluated.** A row whose enabledness came
 *   from an expression lands in `conditionalRows`; mounting it is the caller's
 *   call, and the caller must say the enabledness is unconfirmed.
 * - **No Loader is built.** A composed row names an npm package and a config;
 *   turning that into live capability is the host's extension loader, which
 *   takes a module path. The bridge is `resolvePluginName` — a row whose plugin
 *   is not installed or is switched off is reported with that reason.
 *
 * @module extensibility/plugins/dsh-apply
 */

import * as path from "node:path";
import { logger } from "@musepi/pi-utils";
import { hostExprContext } from "./dsh-expr";
import {
	type ComposedRow,
	composeDshLayers,
	type DshComposition,
	type DshLayer,
	type DshRowOverride,
} from "./dsh-layers";
import { type PluginNameResolution, resolvePluginNames } from "./dsh-name-resolution";
import { parseDshPatch } from "./dsh-patch";

/** A profile's composition inputs: which bundles, and the user's own patches. */
export interface DshProfileComposition {
	/** Profile name when the caller knows it ("" for the default). Passed to
	 *  `!!js` expressions as `profile`; absent means the name is simply not in
	 *  scope for expressions, which only affects patches that reference it. */
	readonly name?: string;
	/**
	 * Bundle package directories, in the order the profile stacks them —
	 * earlier bundles are lower layers, so a later bundle can reconfigure a row
	 * an earlier one inserted.
	 */
	readonly bundleDirs: readonly string[];
	/** The profile's own patch file (`<profile>/cordis.patch.yml`), if any. */
	readonly profilePatchPath?: string;
	/** The home-level patch file, applied above the profile's. */
	readonly homePatchPath?: string;
}

/** One layer's provenance, for a caller that wants to say where a row came from. */
export interface AppliedLayer {
	readonly name: string;
	readonly rows: number;
	readonly overrides: number;
	readonly unreadable: readonly string[];
}

/** The composition plus what applying it could not settle. */
export interface DshApplication {
	readonly composition: DshComposition;
	readonly layers: readonly AppliedLayer[];
	/**
	 * Rows whose plugin is not usable here, by row id — `not-installed` when
	 * the package is absent, `disabled` when the person switched it off. Both
	 * are states, not failures: a bundle may legitimately name a plugin this
	 * installation does not have.
	 */
	readonly unresolvedPlugins: ReadonlyArray<{ readonly id: string; readonly resolution: PluginNameResolution }>;
	/** Row id → the installed directory its plugin resolves to. Rows whose
	 *  plugin is not usable are absent here (see `unresolvedPlugins`). */
	readonly pluginPathsByRow: ReadonlyMap<string, string>;
	/** Total `!!js` expressions seen and NOT evaluated, across every layer. */
	readonly unevaluatedExpressions: number;
}

/** The patch files a bundle package declares, in composition order. */
async function declaredPatchFiles(pluginDir: string): Promise<string[] | null> {
	try {
		const manifest = (await Bun.file(path.join(pluginDir, "package.json")).json()) as {
			dsh?: { bundle?: { patch?: string | string[] } };
		};
		const declared = manifest.dsh?.bundle?.patch;
		if (typeof declared === "string") return declared.trim() === "" ? [] : [declared];
		if (Array.isArray(declared)) {
			return declared.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * The bundle's own package name, for the layer label.
 *
 * Read from the manifest rather than taken from the directory: a scoped npm
 * package installs into a nested directory (`@scope/name`), so `basename` says
 * `name` and the layer label loses which package the row came from — which is
 * the one fact a diagnostic most needs.
 */
async function declaredBundleName(dir: string): Promise<string> {
	try {
		const manifest = (await Bun.file(path.join(dir, "package.json")).json()) as { name?: string };
		if (typeof manifest.name === "string" && manifest.name !== "") return manifest.name;
	} catch {
		// A manifest we cannot read has no name to prefer; the directory is the
		// honest fallback.
	}
	return path.basename(dir);
}

/**
 * Read one patch file into its layer contribution.
 *
 * A missing or unparseable file is a **reported** condition, not a throw: a
 * bundle that ships a patch this host cannot read still has its other patches
 * applied, and the person is told which one was not taken.
 */
async function readLayerFile(
	absolute: string,
	name: string,
): Promise<{
	layers: DshLayer[];
	overrides: Array<{ layer: string; override: DshRowOverride }>;
	unreadable: string[];
	unevaluated: number;
}> {
	try {
		const source = await Bun.file(absolute).text();
		const document = parseDshPatch(source);
		const unreadable: string[] = [];
		for (const skip of document.skipped) unreadable.push(`entry ${skip.index}: ${skip.reason}`);
		// Skipped entries' tagged values are lost with them — count them so the
		// caller can say what was dropped rather than reporting a clean parse.
		const dropped = document.skipped.reduce((sum, skip) => sum + skip.droppedExpressions, 0);
		const unevaluated = dropped + countLayerExpressions(document);
		return {
			layers: [{ name, rows: document.rows }],
			overrides: document.overrides.map(override => ({ layer: name, override })),
			unreadable,
			unevaluated,
		};
	} catch (error) {
		logger.debug("dsh apply: patch file unreadable", { path: absolute, err: error });
		return { layers: [], overrides: [], unreadable: [absolute], unevaluated: 0 };
	}
}

/** Tagged expressions in the rows and overrides a file DID yield. */
function countLayerExpressions(document: ReturnType<typeof parseDshPatch>): number {
	let total = 0;
	const walk = (value: unknown): void => {
		if (value === null || value === undefined) return;
		if (typeof value === "object") {
			if ((value as { kind?: string }).kind === "js-expr") total += 1;
			if (Array.isArray(value)) value.forEach(walk);
			else Object.values(value).forEach(walk);
		}
	};
	for (const row of document.rows) {
		walk(row.disabled);
		walk(row.config);
	}
	for (const override of document.overrides) {
		walk(override.disabled);
		walk(override.config);
	}
	return total;
}

/**
 * Build the ordered layer stack for a profile's bundles plus the user's patches.
 *
 * Bundle layers come first (a later bundle may reconfigure an earlier one's
 * rows), then the profile patch, then the home patch. Every layer is labelled
 * with where it came from so a composed row can say which bundle owns it.
 */
export async function readBundleLayers(composition: DshProfileComposition): Promise<{
	layers: DshLayer[];
	overrides: Array<{ layer: string; override: DshRowOverride }>;
	applied: AppliedLayer[];
	unevaluated: number;
}> {
	const layers: DshLayer[] = [];
	const overrides: Array<{ layer: string; override: DshRowOverride }> = [];
	const applied: AppliedLayer[] = [];
	let unevaluated = 0;

	for (const dir of composition.bundleDirs) {
		const files = await declaredPatchFiles(dir);
		if (files === null) continue; // Not a bundle, or no readable manifest — not a failure.
		const bundleName = await declaredBundleName(dir);
		const unreadable: string[] = [];
		let rowCount = 0;
		let overrideCount = 0;
		for (const file of files) {
			const read = await readLayerFile(path.resolve(dir, file), bundleName);
			layers.push(...read.layers);
			overrides.push(...read.overrides);
			unreadable.push(...read.unreadable);
			unevaluated += read.unevaluated;
			rowCount += read.layers.reduce((sum, layer) => sum + layer.rows.length, 0);
			overrideCount += read.overrides.length;
		}
		applied.push({ name: bundleName, rows: rowCount, overrides: overrideCount, unreadable });
	}

	// The profile's own patch and the home patch sit above every bundle layer.
	for (const [label, patchPath] of [
		["profile", composition.profilePatchPath],
		["home", composition.homePatchPath],
	] as const) {
		if (!patchPath) continue;
		const read = await readLayerFile(patchPath, label);
		layers.push(...read.layers);
		overrides.push(...read.overrides);
		unevaluated += read.unevaluated;
		applied.push({
			name: label,
			rows: read.layers.reduce((sum, layer) => sum + layer.rows.length, 0),
			overrides: read.overrides.length,
			unreadable: read.unreadable,
		});
	}

	return { layers, overrides, applied, unevaluated };
}

/**
 * Compose a profile's full stack and resolve each row's plugin to an installed
 * path.
 *
 * This is the entry point a host uses instead of "read the bundle and look at
 * it": the answer is an ordered row list, each row carrying the plugin path
 * that would mount it (or why it cannot), plus the rows whose enabledness this
 * host refuses to guess.
 */
export async function applyDshProfile(
	composition: DshProfileComposition,
	cwd: string,
	home?: string,
): Promise<DshApplication> {
	const { layers, overrides, applied, unevaluated } = await readBundleLayers(composition);
	// Evaluate `!!js` conditions against the host context so a conditional row
	// settles into a real enablement instead of staying permanently unknown —
	// the reference loader computes a patch's tagged values the same way.
	const composed = composeDshLayers(layers, overrides, hostExprContext({ profile: composition.name }));

	// Resolve every composed row's package name once, in declared order. The
	// cwd is the PROJECT directory (it selects which plugin root applies), not
	// the bundle's own directory.
	const resolutions = await resolvePluginNames(
		composed.rows.map(row => row.name),
		cwd,
		home,
	);
	const byName = new Map(resolutions.map(entry => [entry.name, entry.resolution]));
	const unresolvedPlugins: Array<{ id: string; resolution: PluginNameResolution }> = [];
	const pathByRow = new Map<string, string>();
	for (const row of composed.rows) {
		const resolution = byName.get(row.name);
		if (!resolution) continue;
		if (resolution.status === "resolved") {
			pathByRow.set(row.id, resolution.pluginPath);
			continue;
		}
		unresolvedPlugins.push({ id: row.id, resolution });
	}

	return {
		composition: composed,
		layers: applied,
		unresolvedPlugins,
		pluginPathsByRow: pathByRow,
		unevaluatedExpressions: unevaluated,
	};
}

/**
 * The rows of a composition that would actually mount: their plugin is
 * installed, and they are not disabled.
 *
 * A row whose enablement came from a `!!js` expression is INCLUDED — this
 * host does not evaluate the expression, so refusing to mount would be a
 * guess in the other direction. `conditionalRows` names them so the caller
 * can say the enabledness is unconfirmed rather than silently treating a
 * possibly-disabled row as live.
 */
export function mountableRows(application: DshApplication): Array<ComposedRow & { pluginPath: string }> {
	const out: Array<ComposedRow & { pluginPath: string }> = [];
	for (const row of application.composition.rows) {
		if (row.disabled === true) continue;
		const pluginPath = application.pluginPathsByRow.get(row.id);
		if (!pluginPath) continue;
		out.push({ ...row, pluginPath });
	}
	return out;
}

/**
 * The extension entry files the mountable rows contribute, for the host's
 * extension loader.
 *
 * A composed row names a PACKAGE; the loader takes MODULE PATHS. This is the
 * step between them: for each row, read that package's own manifest
 * (`musepi.extensions`) and collect its entry files, exactly the way an
 * installed plugin's entries are resolved when no composition is involved.
 *
 * Two consequences worth stating plainly:
 *
 * - A package with no loadable entry contributes nothing here and is not
 *   silently counted as mounted — the row stays visible in the composition
 *   with its plugin marked present, so the person can see that its plugin ships
 *   no loadable module rather than wondering why nothing appeared.
 * - The same package mounted by two rows yields its entries once (the loader
 *   de-duplicates by resolved path anyway; doing it here keeps the count honest).
 */
export async function mountableEntryPaths(application: DshApplication, cwd: string, home?: string): Promise<string[]> {
	const rows = mountableRows(application);
	if (rows.length === 0) return [];
	const { getAllPlugins, resolvePluginExtensionPaths } = await import("./loader");
	// cwd selects which plugin root applies (project vs user), so it comes from
	// the caller rather than the process directory.
	const installed = await getAllPlugins(cwd, home ? { home } : {});
	const byName = new Map(installed.map(plugin => [plugin.name, plugin]));
	const seen = new Set<string>();
	const out: string[] = [];
	for (const row of rows) {
		const plugin = byName.get(row.name);
		if (!plugin) continue;
		for (const entry of resolvePluginExtensionPaths(plugin)) {
			const resolved = path.resolve(entry);
			if (seen.has(resolved)) continue;
			seen.add(resolved);
			out.push(entry);
		}
	}
	return out;
}
