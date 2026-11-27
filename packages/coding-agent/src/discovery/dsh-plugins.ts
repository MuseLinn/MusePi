/**
 * DSH profile plugin inventory.
 *
 * A DSH installation keeps each profile as its own pnpm project under
 * `<home>/profiles/<name>/`, with the packages it mounts listed in
 * `package.json`'s `dsh.profile.bundles` and installed under that project's
 * `node_modules`. This provider reads that inventory so a person can see what
 * their DSH install has and hand any of it to the agent to analyse.
 *
 * It deliberately does not convert, mount, or execute anything. A DSH plugin
 * names row identities its own Loader resolves and declares components against
 * `dsh.client` packages this host does not provide; treating one as a MusePi
 * extension would mount a package whose dependencies are absent. What is
 * portable is the source on disk, which the agent reads with its own tools.
 *
 * Priority 60 keeps it below the providers that own real MusePi extensions, so
 * a DSH inventory never shadows an extension this host can actually load.
 */
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { isRecord, logger } from "@musepi/pi-utils";
import { registerProvider } from "../capability";
import type { Extension } from "../capability/extension";
import { extensionCapability } from "../capability/extension";
import type { LoadContext, LoadResult } from "../capability/types";
import { createSourceMeta } from "./helpers";

const PROVIDER_ID = "dsh-plugins";
const DISPLAY_NAME = "DeepSeek Harness";
const PRIORITY = 60;

/** One bundle a DSH profile declares, with whatever its manifest answers. */
interface DshBundleEntry {
	/** Package name as `dsh.profile.bundles` writes it. */
	readonly name: string;
	/** Version from the profile's dependency range, when declared. */
	readonly version?: string;
	/** Absolute path to the installed package, when it is on disk. */
	readonly dir?: string;
	/** Whether the package ships a bundle patch this host could read. */
	readonly bundlePatch?: string;
	/** Whether the package declares a browser client half. */
	readonly hasClient?: boolean;
}

/** One profile's declared bundle inventory. */
interface DshProfileInventory {
	readonly profile: string;
	readonly dir: string;
	readonly bundles: readonly DshBundleEntry[];
}

/** The DSH home this provider reads, honouring the variable DSH itself honours. */
export function dshHome(): string {
	const configured = process.env.DSH_HOME;
	return configured ? configured.replace(/^~/, homedir()) : path.join(homedir(), ".dsh");
}

/** A profile directory's manifest, or undefined when it declares no bundles. */
async function readProfile(dir: string, profile: string): Promise<DshProfileInventory | undefined> {
	let manifest: unknown;
	try {
		manifest = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
	} catch {
		return undefined;
	}
	if (typeof manifest !== "object" || manifest === null) return undefined;
	const record = manifest as Record<string, unknown>;
	const dsh = record.dsh;
	if (typeof dsh !== "object" || dsh === null) return undefined;
	const declared = (dsh as Record<string, unknown>).profile;
	if (typeof declared !== "object" || declared === null) return undefined;
	const bundles = (declared as Record<string, unknown>).bundles;
	if (!Array.isArray(bundles)) return undefined;

	const dependencies =
		typeof record.dependencies === "object" && record.dependencies !== null
			? (record.dependencies as Record<string, unknown>)
			: {};
	const entries: DshBundleEntry[] = [];
	for (const raw of bundles) {
		if (typeof raw !== "string" || raw.length === 0) continue;
		const installed = path.join(dir, "node_modules", raw);
		const detail = await bundleDetail(raw, installed, dependencies[raw]);
		entries.push(detail);
	}
	return { profile, dir, bundles: entries };
}

/**
 * What one bundle package answers about itself.
 *
 * A bundle named by the profile but absent from `node_modules` is reported
 * without a directory: the profile asked for it and the install does not have
 * it, which is a fact worth showing rather than hiding.
 */
async function bundleDetail(name: string, installed: string, declared: unknown): Promise<DshBundleEntry> {
	const version = typeof declared === "string" ? declared : undefined;
	let manifest: Record<string, unknown> | undefined;
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(path.join(installed, "package.json"), "utf8"));
		if (typeof parsed === "object" && parsed !== null) manifest = parsed as Record<string, unknown>;
	} catch {
		// Not installed, or installed without a readable manifest.
		if (declared === undefined) return { name, dir: undefined };
		return { name, ...(version === undefined ? {} : { version }) };
	}
	const dsh = manifest === undefined ? {} : isRecord(manifest.dsh) ? manifest.dsh : {};
	const bundle = isRecord(dsh.bundle) ? dsh.bundle : {};
	const patch = typeof bundle.patch === "string" ? bundle.patch : undefined;
	const hasClient = isRecord(dsh.client);
	return {
		name,
		...(version === undefined ? {} : { version }),
		dir: installed,
		...(patch === undefined ? {} : { bundlePatch: patch }),
		...(hasClient ? { hasClient: true } : {}),
	};
}

/** Every profile under a DSH home, in directory order. */
export async function listDshProfiles(home: string = dshHome()): Promise<DshProfileInventory[]> {
	const root = path.join(home, "profiles");
	let names: string[];
	try {
		const entries = await fs.readdir(root, { withFileTypes: true });
		names = entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
	} catch {
		return [];
	}
	const profiles: DshProfileInventory[] = [];
	for (const name of names.sort()) {
		const inventory = await readProfile(path.join(root, name), name);
		if (inventory) profiles.push(inventory);
	}
	return profiles;
}

/**
 * Present one profile's bundles as a single extension entry.
 *
 * The profile, not each bundle, becomes the entry: a DSH bundle is a row set
 * for a Loader this host does not run, and fifteen separate entries would
 * suggest fifteen separately usable extensions. The manifest carries the
 * inventory as its description because that is what the discovery surfaces
 * show; the loadable parts are empty on purpose.
 */
async function load(context: LoadContext): Promise<LoadResult<Extension>> {
	const profiles = await listDshProfiles(dshHome());
	const items: Extension[] = [];
	const warnings: string[] = [];
	for (const profile of profiles) {
		if (profile.bundles.length === 0) continue;
		const lines = profile.bundles.map(bundle => {
			const flags = [bundle.bundlePatch ? "bundle" : undefined, bundle.hasClient ? "client" : undefined].filter(
				Boolean,
			);
			const state = bundle.dir === undefined ? "not installed" : "installed";
			return `${bundle.name}${bundle.version ? `@${bundle.version}` : ""} — ${state}${flags.length ? `, ${flags.join(" + ")}` : ""}`;
		});
		items.push({
			name: `dsh-profile-${profile.profile}`,
			path: profile.dir,
			manifest: {
				name: `DSH profile ${profile.profile}`,
				description: `${profile.bundles.length} declared plugin(s). Not loadable here; ask the agent to read them as migration source.\n\n${lines.join("\n")}`,
			},
			level: "user",
			_source: createSourceMeta(PROVIDER_ID, profile.dir, "user"),
		});
	}
	if (profileCount(profiles) === 0) {
		logger.debug("dsh-plugins: no profiles found", { home: dshHome() });
	}
	void context;
	return { items, warnings };
}

/** Count of profiles that declared at least one bundle. */
function profileCount(profiles: readonly DshProfileInventory[]): number {
	return profiles.filter(profile => profile.bundles.length > 0).length;
}

registerProvider<Extension>(extensionCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Reads the plugin inventory of each DSH profile under ~/.dsh/profiles (DSH_HOME).",
	priority: PRIORITY,
	load,
});
