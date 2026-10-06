/**
 * Turn the install-source settings into the registries an install may ask.
 *
 * The settings describe intent; this resolves it against what is actually
 * configured, so the fallback chain's decision layer never has to know that a
 * setting exists. Two resolutions are deliberately silent rather than loud:
 *
 * - A probe that fails does not block an install. A registry that cannot be
 *   pinged is not proof that a package cannot be fetched from it, and refusing
 *   the install on that basis would turn a cosmetic failure into a dead end.
 * - A "custom" mode with no URL is treated as "let the package manager decide",
 *   because a custom source with no address has nothing to ask.
 *
 * @module extensibility/plugins/registry-config
 */

import { Settings } from "../../config/settings";
import { normalizeRegistry, OFFICIAL_NPM_REGISTRY, type Registry, type RegistryPlanConfig } from "./registry-fallback";

/** The two public registries the auto mode chooses between. */
const AUTO_CANDIDATES: readonly string[] = [OFFICIAL_NPM_REGISTRY, "https://registry.npmmirror.com/"];

/**
 * What the settings resolve to: the mode as configured, and the plan the mode
 * implies before any probing.
 *
 * `probed` carries the first candidate the auto mode would try. It is a guess
 * until a probe confirms it, which is why the install path treats a probed
 * registry the same as a configured one — the difference is only that one was
 * measured and the other was assumed.
 */
export interface ResolvedRegistryConfig {
	readonly mode: "auto" | "custom" | "bun";
	readonly config: RegistryPlanConfig;
	readonly probed: Registry;
}

/**
 * Read the install-source settings.
 *
 * @returns the mode, the plan it implies, and the registry the mode would ask
 * first without having probed anything.
 */
export function resolveRegistryConfig(): ResolvedRegistryConfig {
	// Settings are not always up when an install runs: reaching the singleton at
	// all throws when nothing has initialized it, and a CLI invocation can
	// install before the first read does. Unreadable settings resolve to "leave
	// it alone", which is the behaviour that was in force before these settings
	// existed — an install must not start failing because a configuration layer
	// is not ready.
	let mode: ResolvedRegistryConfig["mode"];
	let fallbacks: string[];
	let customUrl: string | undefined;
	try {
		const settings = Settings.instance;
		mode = settings.get("pluginRegistryMode");
		fallbacks = settings.get("pluginRegistryFallbacks").filter(entry => entry.trim() !== "");
		customUrl = settings.get("pluginRegistryUrl");
	} catch {
		return { mode: "bun", config: { registry: null, fallbackRegistries: [], resolved: null }, probed: null };
	}

	if (mode === "bun") {
		return {
			mode,
			// Nothing is configured, so the package manager's own registry is both
			// the first choice and the whole chain. `resolved: null` says what it
			// names has not been read, which keeps it from joining a public chain.
			config: { registry: null, fallbackRegistries: [], resolved: null },
			probed: null,
		};
	}

	if (mode === "custom") {
		const url = customUrl?.trim() ?? "";
		if (url === "") {
			// No address to ask. Degrading to the package manager's own registry
			// installs from somewhere real, where refusing would install from
			// nowhere.
			return {
				mode,
				config: { registry: null, fallbackRegistries: [], resolved: null },
				probed: null,
			};
		}
		let normalized: string;
		try {
			normalized = normalizeRegistry(url);
		} catch {
			// A malformed URL is a settings mistake, not a reason to fail an
			// install. Fall back to the package manager's own registry so the
			// person sees a working install and can fix the setting.
			return {
				mode,
				config: { registry: null, fallbackRegistries: [], resolved: null },
				probed: null,
			};
		}
		// The configured fallbacks still apply after a custom registry: a custom
		// index may not carry a package the public one does.
		return {
			mode,
			config: { registry: normalized, fallbackRegistries: fallbacks, resolved: normalized },
			probed: normalized,
		};
	}

	// Auto: the official registry first, the public mirror as the fallback. The
	// package manager's own registry stays out of the chain here — it is unknown
	// until read, and an unknown registry must not sit in a chain holding public
	// ones.
	return {
		mode,
		config: {
			registry: AUTO_CANDIDATES[0] as string,
			fallbackRegistries: [...AUTO_CANDIDATES.slice(1), ...fallbacks],
			resolved: AUTO_CANDIDATES[0] as string,
		},
		probed: AUTO_CANDIDATES[0] as string,
	};
}
