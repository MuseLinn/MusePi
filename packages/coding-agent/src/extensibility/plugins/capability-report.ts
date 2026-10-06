/**
 * What an installed plugin needs from this host, and whether that is available.
 *
 * Installation and loading answer different questions. A package installs as soon
 * as a package manager has written it into the plugins directory; it loads only
 * when every service it declares as an injection is present, every component it
 * registers targets a slot this host hosts, and every module it imports resolves
 * in the module graph it was built against. A plugin written for another harness
 * installs cleanly and then fails to load, so the install result reports both
 * facts rather than reporting success and leaving the person to find out.
 *
 * The probe is deliberately static: it reads the installed package's manifest and
 * its own resolution of entry points, and never loads the plugin's code. Loading
 * a plugin to see whether it loads is the thing being avoided — an unloadable
 * plugin must not be able to run at all before the verdict is known.
 *
 * Three verdicts, because the three call for different reactions:
 *
 * - `runnable` — every declared dependency is available.
 * - `partial` — the plugin will load, but some part of it (a component, a tool
 *   view, a design system) targets something this host does not host.
 * - `incompatible` — a required dependency is missing, so the plugin cannot
 *   load. Named dependencies are listed so the person knows what is absent
 *   rather than seeing a load error later.
 *
 * @module extensibility/plugins/capability-report
 */

import * as path from "node:path";
import { EXTENSION_SLOT_DECLARATION } from "@musepi/collab-proto/extension-slots";
import { logger } from "@musepi/pi-utils";
import type { InstalledPlugin } from "./types";

/** How a plugin fared against this host's runtime. */
export type PluginCapabilityVerdict = "runnable" | "partial" | "incompatible";

/**
 * The report attached to a completed install.
 *
 * `missing` names required dependencies this host does not provide, in the form
 * the person would search for. `unhostedSlots` names components whose slot this
 * host declares no mount site for — the plugin loads, but that part of it will
 * not appear.
 */
export interface PluginCapabilityReport {
	readonly verdict: PluginCapabilityVerdict;
	readonly missing: readonly string[];
	readonly unhostedSlots: readonly string[];
	/** One sentence in the person’s language, ready to render. */
	readonly summary: string;
}

/**
 * Package namespaces this host can satisfy.
 *
 * A dependency outside these is another harness's runtime, or a library the
 * plugin expects to be hoisted. A plugin declaring `@deepseek-ai/…` was built
 * against a different host and will not resolve here.
 */
const HOST_PACKAGE_SCOPE: ReadonlySet<string> = new Set(["@musepi/", "musepi-", "pi-", "@earendil-works/"]);

/** Package namespaces that are plugins for a different harness. */
const FOREIGN_SCOPE_HINT = /^@(?:deepseek-ai|anthropic-ai|huanlin|michengai|omdsh)\//;

/** Entry suffixes a manifest `extensions` entry can name. */
const ENTRY_SUFFIXES: readonly string[] = [".ts", ".tsx", ".js", ".jsx", ".mjs"];

/**
 * Whether this host mounts a slot.
 *
 * The slot vocabulary is read from `@musepi/collab-proto/extension-slots`,
 * the same declaration the loader validates registrations against and the
 * daemon serves to the GUI. This module used to carry its own copy of the
 * prefix families and exact names; the copy matched, and would have kept
 * matching right up until someone added a slot in the one place and every
 * plugin registering into it started being reported as partial here while
 * rendering correctly. Referring to the declaration means a new slot is
 * reported as hosted the moment it is declared.
 *
 * A slot outside the declaration loads — registration is not a mount — but
 * never renders, which is why that case is `partial` rather than
 * `incompatible`.
 */
function isHostedSlot(slot: string): boolean {
	if ((EXTENSION_SLOT_DECLARATION.exact as readonly string[]).includes(slot)) return true;
	return EXTENSION_SLOT_DECLARATION.prefixes.some(prefix => slot.startsWith(prefix));
}

/**
 * The extension entries an installed package declares.
 *
 * Read from the package's own `package.json` rather than from
 * `InstalledPlugin.manifest`: that field is the `omp`/`pi` block as the installer
 * parsed it, and it is absent whenever a package declares its entries under the
 * authoritative `musepi` block. Reading only the parsed block would therefore
 * report a plugin that ships a broken entry as runnable, because the check
 * would see no entries to check.
 *
 * A package that declares no entries contributes no runtime and is reported as
 * runnable with nothing to check.
 */
function readExtensionEntries(manifest: PackageJsonDeps | undefined): { entry: string; suffix: string }[] {
	for (const block of [manifest?.musepi, manifest?.omp, manifest?.pi]) {
		const declared = block?.extensions;
		if (!Array.isArray(declared)) continue;
		const entries = declared
			.filter((value): value is string => typeof value === "string")
			.flatMap(entry => {
				const suffix = ENTRY_SUFFIXES.find(candidate => entry.endsWith(candidate));
				return suffix === undefined ? [] : [{ entry, suffix }];
			});
		if (entries.length > 0) return entries;
	}
	return [];
}

/**
 * Scan an installed plugin's entry source for slot names it registers into.
 *
 * A textual scan, not an import: the point is to learn what a plugin *asks* for
 * before it runs, so a slot this host does not mount can be reported as absent
 * rather than showing up as a component that never appears. A plugin that
 * computes its slot name at runtime cannot be read this way, which is why a
 * missing hit is never treated as proof of compatibility.
 */
async function readRegisteredSlots(entryPath: string): Promise<string[]> {
	try {
		const source = await Bun.file(entryPath).text();
		// Both spellings appear in the wild: `slots.register({ name: 'panel.tab.x' })`
		// and `slots.inject('settings.tab.y', …)`.
		const pattern = /["'`]([a-z]+(?:\.[a-z]+)+)["'`]/g;
		const found = new Set<string>();
		for (const match of source.matchAll(pattern)) {
			const candidate = match[1];
			if (candidate !== undefined) found.add(candidate);
		}
		return [...found];
	} catch (err) {
		// A missing or unreadable entry is reported through the entry check below,
		// not here: this scan is a best-effort addition to it.
		logger.debug("plugin capability: could not read entry for slot scan", { entryPath, err });
		return [];
	}
}

/**
 * Judge an installed plugin against this host.
 *
 * The dependency side reads the installed package's own `package.json`, because
 * that is where a plugin built for another harness declares what it expects:
 * `@deepseek-ai/dsh-client-ui-sidebar-right` and its siblings appear as peer
 * dependencies, and every one of them is absent here.
 *
 * @param plugin - the resolved plugin, with its on-disk `path`.
 * @returns the verdict, the absent required packages, and the unhosted slots.
 */
export async function describePluginCapability(plugin: InstalledPlugin): Promise<PluginCapabilityReport> {
	const missing: string[] = [];
	const unhostedSlots: string[] = [];

	// Dependency check. `peerDependencies` is what a plugin declares it needs;
	// `dependencies` is checked too because a plugin may bundle another harness's
	// package rather than requiring the host to provide it.
	const manifestJson = await readPackageJson(plugin);
	for (const dependency of [
		...Object.keys(manifestJson?.peerDependencies ?? {}),
		...Object.keys(manifestJson?.dependencies ?? {}),
	]) {
		if (dependency === "") continue;
		if (isHostProvided(dependency)) continue;
		// A third-party library the plugin bundles itself is not a host concern;
		// only a foreign harness's runtime package blocks a load.
		if (!FOREIGN_SCOPE_HINT.test(dependency) && !looksLikeForeignRuntime(dependency)) continue;
		missing.push(dependency);
	}

	// Entry check. A declared entry that is not on disk means the package
	// published something it cannot load: that is load-blocking, not partial.
	for (const { entry } of readExtensionEntries(manifestJson)) {
		const entryPath = path.isAbsolute(entry) ? entry : path.join(plugin.path, entry);
		if (!(await Bun.file(entryPath).exists())) {
			missing.push(`entry ${entry}`);
			continue;
		}
		for (const slot of await readRegisteredSlots(entryPath)) {
			if (!isHostedSlot(slot)) unhostedSlots.push(slot);
		}
	}

	const verdict: PluginCapabilityVerdict =
		missing.length > 0 ? "incompatible" : unhostedSlots.length > 0 ? "partial" : "runnable";

	return {
		verdict,
		missing,
		unhostedSlots: [...new Set(unhostedSlots)],
		summary: summarize(verdict, missing, unhostedSlots),
	};
}

/** The installed package's own manifest, or undefined when it cannot be read. */
async function readPackageJson(plugin: InstalledPlugin): Promise<PackageJsonDeps | undefined> {
	if (plugin.path === "") return undefined;
	try {
		return (await Bun.file(path.join(plugin.path, "package.json")).json()) as PackageJsonDeps;
	} catch (err) {
		// A plugin with no readable manifest has no declared dependencies, which
		// is not evidence of compatibility but is not evidence against it either;
		// the entry check is what can still fail.
		logger.debug("plugin capability: could not read plugin package.json", { path: plugin.path, err });
		return undefined;
	}
}

interface PackageJsonDeps {
	readonly dependencies?: Record<string, string>;
	readonly peerDependencies?: Record<string, string>;
	readonly musepi?: ManifestBlock;
	readonly omp?: ManifestBlock;
	readonly pi?: ManifestBlock;
}

interface ManifestBlock {
	readonly extensions?: readonly unknown[];
}

/** Whether this host can satisfy a declared package dependency. */
function isHostProvided(dependency: string): boolean {
	if (dependency === "react" || dependency === "react-dom") return true;
	return [...HOST_PACKAGE_SCOPE].some(prefix => dependency.startsWith(prefix));
}

/**
 * Whether a dependency names a runtime this host is not. A bare package name is
 * only treated as foreign when it carries a harness marker, so an ordinary
 * library a plugin forgot to bundle is not reported as a missing host runtime.
 */
function looksLikeForeignRuntime(dependency: string): boolean {
	return /-(?:harness|host|runtime|cordis|dsh)$/.test(dependency);
}

function summarize(
	verdict: PluginCapabilityVerdict,
	missing: readonly string[],
	unhostedSlots: readonly string[],
): string {
	switch (verdict) {
		case "runnable":
			return "安装完成，此插件可在当前底座运行。";
		case "partial":
			return `安装完成，但 ${unhostedSlots.join("、")} 这些位置当前底座没有挂载点，对应界面不会出现。`;
		case "incompatible":
			return `安装完成，但缺少 ${missing.join("、")}，此插件无法在此底座加载。`;
	}
}
