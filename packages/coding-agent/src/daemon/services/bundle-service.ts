/**
 * BundleService — the profile/bundle composition control surface.
 *
 * `ExtensionService` answers "what is installed and running". This answers the
 * other question DSH's launcher answers at boot: **what does this profile
 * stack, and what would that composition actually mount here?** A person who
 * installed a bundle otherwise sees it install cleanly and contribute nothing,
 * which reads as the host being broken.
 *
 * Composition is derived state recomputed from the profile manifest and the
 * bundles' patch files. Selecting a bundle writes the profile's ordered bundle
 * list (`bundles.setEnabled`); overriding a composed row writes the profile's
 * own patch (`bundles.rows.setEnabled`). Reading never creates profile files.
 *
 * Capability seam (M2-2.4):
 * - Input: RPC `bundles.composition` (the active profile's layer stack),
 *   `bundles.profile` (what the profile declares, including "it declares
 *   nothing"), both reading disk through the plugin layer-stack composer.
 * - Output: the composed row list with each row's plugin resolution, the
 *   layers that contributed to it, the rows whose plugin is not usable here,
 *   and the count of `!!js` expressions this host refused to evaluate.
 * - Lifecycle: no start/stop — a 10s TTL cache, busted by the host's extension
 *   watcher (the same invalidation that busts the plugin inventory) so an
 *   edited patch file shows up without a restart.
 * - Conflict: none with ExtensionService — this reads composition, that reads
 *   live state, and neither writes. Both answer from the plugin layer.
 */

import * as path from "node:path";
import { getActiveProfile } from "@musepi/pi-utils";
import {
	applyDshProfile,
	type DshApplication,
	mountableEntryPaths,
	mountableRows,
} from "../../extensibility/plugins/dsh/dsh-apply";
import {
	type BundlePackageView,
	listInstalledBundles,
	type ProfileCompositionNote,
	profileDirFor,
	readProfileComposition,
	resolveBundleDirs,
	writeProfileBundles,
} from "../../extensibility/plugins/profile/profile-composition";
import { writeRowEnabled } from "../../extensibility/plugins/profile/profile-patch-edit";
import type { DaemonService } from "./types";

/** TTL window for the composition read — matches the plugin inventory's. */
const COMPOSITION_TTL_MS = 10_000;

/** Where a profile's own patch lives, whether or not it has one yet. */
function defaultPatchPath(profileDir: string): string {
	return path.join(profileDir, "cordis.patch.yml");
}

/** One composed row, in the wire shape the GUI renders. */
export interface BundleRowView {
	readonly id: string;
	/** The npm package the row names. */
	readonly name: string;
	/**
	 * The row's enablement as composition settled it:
	 * `enabled` / `disabled` / `conditional` (a `!!js` expression this host
	 * does not evaluate — enabledness genuinely unknown, never guessed).
	 */
	readonly state: "enabled" | "disabled" | "conditional";
	readonly group: boolean;
	readonly inject: readonly string[];
	/** Which layers contributed to this row, in application order. */
	readonly layers: readonly string[];
	/** Where the row's plugin lives, when it is installed. */
	readonly pluginPath: string | null;
	/** Why the plugin cannot be used, when it cannot. */
	readonly pluginIssue: "not-installed" | "disabled" | null;
	/** Whether this row would mount right now (plugin present, not disabled). */
	readonly mountable: boolean;
}

export interface BundleLayerView {
	readonly name: string;
	readonly rows: number;
	readonly overrides: number;
	readonly unreadable: readonly string[];
}

export interface BundleCompositionView {
	/** The profile the composition was read for ("" = default profile). */
	readonly profile: string;
	/** What the profile declared, or why it declared nothing. */
	readonly declared: "ok" | "no-manifest" | "unreadable";
	/** Present only when the manifest could not be read. */
	readonly detail?: string;
	/** Bundle package names the profile stacks, in order. */
	readonly bundles: readonly string[];
	readonly availableBundles: readonly BundlePackageView[];
	readonly layers: readonly BundleLayerView[];
	readonly rows: readonly BundleRowView[];
	/** Rows whose enabledness came from an expression this host will not run. */
	readonly conditionalRows: readonly string[];
	/** Total `!!js` expressions read and NOT evaluated, across every layer. */
	readonly unevaluatedExpressions: number;
	readonly mountedAt: number;
}

export interface BundleServiceDeps {
	/** Project directory whose plugin roots apply. */
	cwd(): string;
	/** User home for the profile/config roots. */
	home(): string;
	/** Cache invalidation hook (host watcher). */
	invalidate(): void;
	/**
	 * The profile to compose ("" = default). Omitted → the process's active
	 * profile, which is what the host passes. Tests pass a name so the answer
	 * does not depend on a process-global the test cannot set.
	 */
	profileName?(): string;
	/**
	 * Re-scan extensions after a composition change, so a row that was just
	 * enabled actually mounts (and one just disabled stops). Optional: a host
	 * that omits it still gets the composition answer, just without live
	 * re-scan — the GUI says so rather than claiming a row is live.
	 */
	refreshExtensions?(): Promise<void>;
}

export class BundleService implements DaemonService {
	readonly key = "bundles";
	readonly routes = {
		"bundles.composition": "composition",
		"bundles.profile": "profile",
		"bundles.setEnabled": "setBundleEnabled",
		"bundles.rows.setEnabled": "setRowEnabled",
		"bundles.entries": "entries",
	} as const;

	readonly #deps: BundleServiceDeps;
	#bundleMutation: Promise<void> = Promise.resolve();
	#cache: { at: number; view: BundleCompositionView } | null = null;
	/**
	 * The application the cached view was built from, kept so `entries` can
	 * resolve module paths without re-reading every patch file. Same TTL, same
	 * invalidation — one fact, two answers.
	 */
	#application: DshApplication | null = null;

	constructor(deps: BundleServiceDeps) {
		this.#deps = deps;
	}

	/**
	 * Host watcher entry: drop the composition cache so an edited patch file or
	 * a newly installed bundle shows up without waiting out the TTL.
	 *
	 * Delegates to the plugin inventory's invalidation because the composition
	 * reads the same plugin surface — one watcher tick, both caches gone.
	 */
	invalidate(): void {
		this.#cache = null;
		this.#application = null;
		this.#deps.invalidate();
	}

	/** RPC bundles.setEnabled — select or remove a bundle in the active profile. */
	async setBundleEnabled(params: unknown): Promise<{
		ok: boolean;
		enabled?: boolean;
		bundles?: readonly string[];
		error?: string;
	}> {
		const run = this.#bundleMutation.then(
			() => this.#writeBundleSelection(params),
			() => this.#writeBundleSelection(params),
		);
		this.#bundleMutation = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async #writeBundleSelection(params: unknown): Promise<{
		ok: boolean;
		enabled?: boolean;
		bundles?: readonly string[];
		error?: string;
	}> {
		const p = (params ?? {}) as { name?: unknown; enabled?: unknown };
		if (typeof p.name !== "string" || p.name === "" || typeof p.enabled !== "boolean") {
			return { ok: false, error: "name and enabled are required" };
		}
		const name = this.#activeProfileName();
		const note = await readProfileComposition(name, this.#deps.home());
		if (note.kind === "unreadable") return { ok: false, error: note.reason };
		const selected = note.kind === "ok" ? [...note.composition.bundles] : [];
		if (selected.includes(p.name) === p.enabled) {
			return { ok: true, enabled: p.enabled, bundles: selected };
		}
		if (p.enabled) {
			const catalog = await listInstalledBundles(profileDirFor(name, this.#deps.home()), this.#deps.home());
			const candidate = catalog.find(bundle => bundle.name === p.name);
			if (!candidate?.path || !candidate.readable) {
				return { ok: false, error: `"${p.name}" 不是可读取的已安装 bundle` };
			}
		}
		const bundles = p.enabled
			? [...selected.filter(bundle => bundle !== p.name), p.name]
			: selected.filter(bundle => bundle !== p.name);
		try {
			await writeProfileBundles(name, bundles, this.#deps.home());
			this.invalidate();
			const composition = await this.composition();
			await this.#deps.refreshExtensions?.();
			return { ok: true, enabled: p.enabled, bundles: composition.bundles };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	/**
	 * RPC bundles.rows.setEnabled — toggle one composed row.
	 *
	 * The write is an INPUT to the composition, not a second copy of it: the
	 * toggle lands as an id-targeted override in the profile's own patch file
	 * (the write DSH performs), and this then re-composes and reports what the
	 * composition actually says. Reporting the composed state rather than the
	 * requested one is the same discipline `plugins.setEnabled` follows — a
	 * toggle that says "on" while the composition still reads otherwise is the
	 * kind of lie that makes a management panel untrustworthy.
	 *
	 * A row whose enablement came from a `!!js` expression cannot be toggled
	 * meaningfully (this host does not evaluate it), so that case is refused
	 * rather than silently overwriting somebody's condition.
	 */
	async setRowEnabled(params: unknown): Promise<{
		ok: boolean;
		id?: string;
		changed?: boolean;
		state?: BundleRowView["state"];
		error?: string;
	}> {
		const p = (params ?? {}) as { id?: unknown; enabled?: unknown };
		if (typeof p.id !== "string" || p.id === "") return { ok: false, error: "id required" };

		const before = await this.composition();
		const row = before.rows.find(entry => entry.id === p.id);
		if (!row) return { ok: false, error: `unknown row "${p.id}"` };
		// `conditional` now means only one thing: the row's expression could not
		// be evaluated, so its enablement is genuinely unknown. A row whose
		// condition DID resolve is just enabled or disabled, and a profile may
		// override either — that precedence is the whole point of layers.
		if (row.state === "conditional") {
			return {
				ok: false,
				error: `"${p.id}" 的启停表达式无法求值，启停状态未知，在此无法切换`,
			};
		}

		const profile = await readProfileComposition(before.profile, this.#deps.home());
		if (profile.kind !== "ok") {
			return { ok: false, error: "该 profile 没有组合清单（缺少 musepi.profile.bundles），无处写入" };
		}
		// The profile's own patch file is where the override belongs; a profile
		// that ships none gets one created beside its manifest.
		const patchPath = profile.composition.profilePatchPath ?? defaultPatchPath(profile.composition.dir);

		const written = await writeRowEnabled(
			patchPath,
			row.id,
			row.name,
			p.enabled === true,
			before.rows.map(entry => entry.id),
		);
		if (written.kind === "unknown-row") {
			return { ok: false, error: `该 profile 未组合出行 "${p.id}"` };
		}
		this.invalidate();

		// Re-read and report the composed truth.
		const after = await this.composition();
		const nowRow = after.rows.find(entry => entry.id === p.id);
		// Re-scan extensions so a row that just enabled actually mounts. This
		// is what makes the toggle a control rather than an annotation: without
		// it the profile patch says "on" while the runtime never heard about it.
		await this.#deps.refreshExtensions?.();
		return {
			ok: nowRow?.state === (p.enabled === true ? "enabled" : "disabled"),
			id: p.id,
			changed: written.kind !== "created" ? (written as { changed?: boolean }).changed !== false : true,
			...(nowRow ? { state: nowRow.state } : {}),
		};
	}

	/**
	 * RPC bundles.entries — the extension entry files the composition mounts.
	 *
	 * The composition says what the profile stacks; this says which module
	 * files that resolves to, which is the form a host feeds its extension
	 * loader. Kept separate from `composition` because the two answer
	 * different questions: composition is the whole picture (including rows
	 * whose plugin is missing), entries is only what can actually load.
	 */
	async entries(): Promise<{ paths: string[]; resolvedAt: number }> {
		const view = await this.composition();
		if (view.declared !== "ok" || !this.#application) return { paths: [], resolvedAt: Date.now() };
		const paths = await mountableEntryPaths(this.#application, this.#deps.cwd(), this.#deps.home());
		return { paths, resolvedAt: Date.now() };
	}

	/** What the active profile declares about its composition. */
	async profile(): Promise<{
		profile: string;
		declared: "ok" | "no-manifest" | "unreadable";
		detail?: string;
		dir?: string;
		bundles?: readonly string[];
		manifestSource?: string;
	}> {
		const name = this.#activeProfileName();
		const note: ProfileCompositionNote = await readProfileComposition(name, this.#deps.home());
		switch (note.kind) {
			case "ok":
				return {
					profile: name,
					declared: "ok",
					dir: note.composition.dir,
					bundles: note.composition.bundles,
					manifestSource: note.composition.manifestSource,
				};
			case "unreadable":
				return { profile: name, declared: "unreadable", detail: note.reason };
			default:
				return { profile: name, declared: "no-manifest" };
		}
	}

	/** RPC bundles.composition: the active profile's composed row list. */
	async composition(): Promise<BundleCompositionView> {
		const cached = this.#cache;
		if (cached && Date.now() - cached.at <= COMPOSITION_TTL_MS) return cached.view;
		const view = await this.#compute(this.#activeProfileName());
		this.#cache = { at: Date.now(), view };
		return view;
	}
	async #compute(name: string): Promise<BundleCompositionView> {
		const note = await readProfileComposition(name, this.#deps.home());
		const availableBundles = await listInstalledBundles(profileDirFor(name, this.#deps.home()), this.#deps.home());

		if (note.kind !== "ok") {
			return {
				profile: name,
				declared: note.kind,
				...(note.kind === "unreadable" ? { detail: note.reason } : {}),
				bundles: [],
				availableBundles,
				layers: [],
				rows: [],
				conditionalRows: [],
				unevaluatedExpressions: 0,
				mountedAt: Date.now(),
			};
		}

		const resolved = await resolveBundleDirs(note.composition.bundles, note.composition.dir, this.#deps.home());
		const application: DshApplication = await applyDshProfile(
			{
				bundleDirs: resolved.map(entry => entry.dir),
				...(note.composition.profilePatchPath ? { profilePatchPath: note.composition.profilePatchPath } : {}),
			},
			this.#deps.cwd(),
			this.#deps.home(),
		);
		this.#application = application;

		const mountable = new Set(mountableRows(application).map(row => row.id));
		const issueByRow = new Map(application.unresolvedPlugins.map(entry => [entry.id, entry.resolution.status]));
		// A bundle the profile names but that resolves to no directory is a
		// state worth showing: the profile asked for it and it is not here.
		const missingBundles = note.composition.bundles.filter(
			bundle => !resolved.some(entry => entry.bundle === bundle),
		);

		return {
			profile: name,
			declared: "ok",
			bundles: note.composition.bundles,
			availableBundles,
			layers: application.layers,
			rows: application.composition.rows.map(row => {
				const issue = issueByRow.get(row.id);
				const state: BundleRowView["state"] = row.conditional
					? "conditional"
					: row.disabled === true
						? "disabled"
						: "enabled";
				return {
					id: row.id,
					name: row.name,
					state,
					group: row.group,
					inject: row.inject,
					layers: row.layers,
					pluginPath: application.pluginPathsByRow.get(row.id) ?? null,
					pluginIssue: issue === "not-installed" || issue === "disabled" ? issue : null,
					mountable: mountable.has(row.id),
				};
			}),
			conditionalRows: application.composition.conditionalRows,
			unevaluatedExpressions: application.unevaluatedExpressions + missingBundles.length,
			mountedAt: Date.now(),
		};
	}

	/** The profile to compose. Falls back to the process's active profile so the
	 *  host's `--profile` decision stays the single source; a caller that knows
	 *  better (tests, a future per-request profile) can pin it. */
	#activeProfileName(): string {
		const injected = this.#deps.profileName?.();
		if (injected !== undefined) return injected;
		try {
			return getActiveProfile() ?? "";
		} catch {
			// A profile module that cannot answer means "no named profile"; the
			// default profile's directory is the right place to look.
			return "";
		}
	}
}
