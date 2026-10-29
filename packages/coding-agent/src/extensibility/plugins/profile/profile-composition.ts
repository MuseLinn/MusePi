/**
 * Profile composition — a named profile that lists the bundles it stacks.
 *
 * DSH's profile is the unit of assembly (`docs/architecture.md`):
 * "A profile is a named composition stored in the Harness home. It lists the
 * bundles it stacks, holds any out-of-tree plugins it installs, and keeps the
 * user's own cordis.patch.yml." Its `package.json` carries `dsh.profile.bundles`
 * (`packages/util/package-manifest/src/types.ts:75-78`), and the launcher
 * composes bundle layers, then the profile patch, then the home patch, then
 * `--patch` overlays (`packages/boot/app-boot/src/profile-context.ts:63-74`).
 *
 * This host already has a `--profile` flag, but it means something else: a
 * profile selects where state LIVES (`~/.musepi/profiles/<name>/agent` for
 * sessions, settings, credentials), not what is COMPOSED. Those are different
 * axes, so this adds the second one rather than redefining the first — a
 * profile may name its bundles in the config it already has, and the two
 * readings coexist.
 *
 * Resolution order for a profile's manifest, mirroring the state-side lookup:
 * profile directory first (the person owns it), then the plugins root (an
 * installation-provided default). A profile with no manifest composes nothing
 * and says so, rather than being treated as an error.
 *
 * @module extensibility/plugins/profile-composition
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfigDirName, getPluginsDir, logger } from "@musepi/pi-utils";
import { describeDshBundle } from "../dsh/dsh-bundle";

/** One profile's composition inputs, as declared. */
export interface ProfileComposition {
	/** Profile name (the directory name), or "" for the default profile. */
	readonly name: string;
	/** Absolute path of the profile's own directory. */
	readonly dir: string;
	/**
	 * Bundle package names the profile stacks, in order — earlier is lower, so a
	 * later bundle may reconfigure a row an earlier one inserted.
	 */
	readonly bundles: readonly string[];
	/** The profile's own patch file, if it ships one. */
	readonly profilePatchPath: string | undefined;
	/** Where the manifest was read from, for diagnostics. */
	readonly manifestSource: string | undefined;
}

/** Why a profile declared no composition, when it declared none. */
export type ProfileCompositionNote =
	| { readonly kind: "ok"; readonly composition: ProfileComposition }
	| { readonly kind: "no-manifest"; readonly dir: string }
	| { readonly kind: "unreadable"; readonly dir: string; readonly reason: string };

/** DSH's profile patch filename, reused so a DSH profile directory works as-is. */
const PROFILE_PATCH_FILENAME = "cordis.patch.yml";

/** Where profiles live under the config root. */
function profilesRoot(home: string): string {
	return path.join(home, getConfigDirName(), "profiles");
}

/**
 * A profile's directory: a named one lives under `profiles/`, the default one
 * IS the config root. Shared so every reader and writer of a profile's files
 * resolves the same path — a reader looking in one place while a writer creates
 * files in another would make a profile look permanently absent.
 */
export function profileDirFor(name: string, home: string): string {
	return name ? path.join(profilesRoot(home), name) : path.join(home, getConfigDirName());
}

/**
 * Read a profile's composition inputs from its directory.
 *
 * The only supported manifest field is `musepi.profile.bundles`.
 */
export async function readProfileComposition(name: string, home: string): Promise<ProfileCompositionNote> {
	const dir = profileDirFor(name, home);
	const manifestPath = path.join(dir, "package.json");
	let manifest: { musepi?: { profile?: { bundles?: unknown } } };
	try {
		manifest = (await Bun.file(manifestPath).json()) as typeof manifest;
	} catch (error) {
		// ENOENT is the ordinary case (a profile that declares no composition);
		// a parse failure is a real problem worth reporting.
		const code = (error as { code?: string }).code;
		if (code === "ENOENT") return { kind: "no-manifest", dir };
		logger.debug("profile composition: manifest unreadable", { path: manifestPath, err: error });
		return { kind: "unreadable", dir, reason: error instanceof Error ? error.message : String(error) };
	}

	const declared = manifest.musepi?.profile?.bundles;
	if (declared === undefined) return { kind: "no-manifest", dir };
	if (!Array.isArray(declared) || declared.some(entry => typeof entry !== "string")) {
		return { kind: "unreadable", dir, reason: "profile.bundles must be an array of package names" };
	}

	const patchPath = path.join(dir, PROFILE_PATCH_FILENAME);
	const hasPatch = await Bun.file(patchPath).exists();

	return {
		kind: "ok",
		composition: {
			name,
			dir,
			bundles: declared as string[],
			profilePatchPath: hasPatch ? patchPath : undefined,
			manifestSource: manifestPath,
		},
	};
}

/**
 * Where a bundle package name resolves to a directory on disk.
 *
 * Two anchors, in the order DSH's resolver uses
 * (`packages/boot/app-boot/src/profile.ts:630-641`): the installation's own
 * node_modules first (a bundle the installation ships), then the profile's
 * (one the person installed). A profile naming a bundle that is in neither is
 * reported by the caller as not-installed — it is a state, not a failure.
 */
export async function resolveBundleDirs(
	bundles: readonly string[],
	profileDir: string,
	home: string,
): Promise<{ dir: string; bundle: string }[]> {
	const anchors = [path.join(getPluginsDir(home), "node_modules"), path.join(profileDir, "node_modules")];
	const out: { dir: string; bundle: string }[] = [];
	for (const bundle of bundles) {
		for (const anchor of anchors) {
			const dir = path.join(anchor, bundle);
			if (await Bun.file(path.join(dir, "package.json")).exists()) {
				out.push({ dir, bundle });
				break;
			}
		}
	}
	return out;
}

export interface BundlePackageView {
	readonly name: string;
	readonly version: string;
	readonly path: string | null;
	readonly selected: boolean;
	readonly readable: boolean;
	readonly description?: string;
}

type ProfileManifestBlock = Record<string, unknown> & { profile?: Record<string, unknown> };
type ProfileManifest = Record<string, unknown> & { dsh?: ProfileManifestBlock; musepi?: ProfileManifestBlock };

/** Write the ordered bundle selection without replacing the rest of the profile manifest. */
export async function writeProfileBundles(
	name: string,
	bundles: readonly string[],
	home: string,
): Promise<ProfileComposition> {
	const dir = profileDirFor(name, home);
	const manifestPath = path.join(dir, "package.json");
	let manifest: ProfileManifest = { name: path.basename(dir), private: true };
	try {
		manifest = (await Bun.file(manifestPath).json()) as ProfileManifest;
	} catch (error) {
		if ((error as { code?: string }).code !== "ENOENT") throw error;
	}
	const block: ProfileManifestBlock = { ...(manifest.musepi ?? {}) };
	block.profile = { ...(block.profile ?? {}), bundles: [...bundles] };
	manifest.musepi = block;

	const temporaryPath = path.join(dir, `.package.json.${process.pid}.${randomUUID()}.tmp`);
	try {
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
		await fs.rename(temporaryPath, manifestPath);
	} finally {
		await fs.rm(temporaryPath, { force: true });
	}
	const note = await readProfileComposition(name, home);
	if (note.kind !== "ok")
		throw new Error(note.kind === "unreadable" ? note.reason : "profile bundle write did not persist");
	return note.composition;
}

/** List bundle packages beside the profile, including selected packages whose files are missing. */
export async function listInstalledBundles(profileDir: string, home: string): Promise<BundlePackageView[]> {
	let selectedNames: string[] = [];
	try {
		const manifest = (await Bun.file(path.join(profileDir, "package.json")).json()) as ProfileManifest;
		const declared = manifest.musepi?.profile?.bundles;
		if (Array.isArray(declared))
			selectedNames = declared.filter((entry): entry is string => typeof entry === "string");
	} catch {
		selectedNames = [];
	}
	const selected = new Set(selectedNames);
	const bundles = new Map<string, BundlePackageView>();
	const anchors = [path.join(getPluginsDir(home), "node_modules"), path.join(profileDir, "node_modules")];
	for (const anchor of anchors) {
		for (const pattern of ["*/package.json", "@*/*/package.json"]) {
			let files: string[] = [];
			try {
				files = [...new Bun.Glob(pattern).scanSync({ cwd: anchor, onlyFiles: true })].sort();
			} catch (error) {
				if ((error as { code?: string }).code !== "ENOENT") throw error;
			}
			for (const relative of files) {
				const manifestPath = path.join(anchor, relative);
				try {
					const pkg = (await Bun.file(manifestPath).json()) as {
						name?: string;
						version?: string;
						description?: string;
						dsh?: { bundle?: { patch?: unknown } };
					};
					if (!pkg.name || pkg.dsh?.bundle?.patch === undefined || bundles.has(pkg.name)) continue;
					const dir = path.dirname(manifestPath);
					const inventory = await describeDshBundle(dir);
					bundles.set(pkg.name, {
						name: pkg.name,
						version: typeof pkg.version === "string" ? pkg.version : "",
						path: dir,
						selected: selected.has(pkg.name),
						readable: inventory.isBundle && inventory.unreadable.length === 0,
						...(typeof pkg.description === "string" ? { description: pkg.description } : {}),
					});
				} catch (error) {
					logger.debug("profile bundle inventory: package unreadable", { path: manifestPath, err: error });
				}
			}
		}
	}
	for (const name of selectedNames) {
		if (!bundles.has(name)) bundles.set(name, { name, version: "", path: null, selected: true, readable: false });
	}
	return [...bundles.values()];
}

/**
 * Write a worked example into a profile that declares no composition, so the
 * combination surface is discoverable after an upgrade instead of looking like
 * a dead tab.
 *
 * Two rules keep this safe:
 *
 * - **Only a file that does not exist is written.** A profile with a manifest,
 *  a patch, or either of those in an unreadable state is left exactly as it is;
 *  nothing here can overwrite a declaration a person made.
 * - **The example names no bundle.** It is a skeleton showing the
 *  `musepi.profile.bundles` field and the patch form, so it composes to an empty
 *  stack rather than pulling packages this installation may not have.
 *
 * Without this the feature is invisible after an upgrade: an existing profile
 * has no manifest, the composition reads as empty, and the tab asks someone to
 * declare a field they have no reason to know exists.
 */
export async function ensureProfileCompositionExample(profileDir: string): Promise<"written" | "skipped"> {
	const manifestPath = path.join(profileDir, "package.json");
	if (await Bun.file(manifestPath).exists()) return "skipped";
	const patchPath = path.join(profileDir, PROFILE_PATCH_FILENAME);
	if (await Bun.file(patchPath).exists()) return "skipped";

	await Bun.write(
		manifestPath,
		`${JSON.stringify(
			{
				name: path.basename(profileDir),
				private: true,
				musepi: {
					profile: {
						// The bundle packages this profile stacks, in order — a
						// later bundle may reconfigure a row an earlier one
						// inserts. The capability center's Composition tab shows
						// what they compose to, with a per-row toggle.
						bundles: [],
					},
				},
			},
			null,
			2,
		)}\n`,
	);
	await Bun.write(
		patchPath,
		[
			"# This profile's own patch: rows a profile can enable or disable",
			"# without editing the bundles that ship them. Every entry here wins",
			"# over the same id in a bundle's patch.",
			"#",
			"#- id: some-row",
			"#  disabled: true",
			"",
		].join("\n"),
	);
	return "written";
}
