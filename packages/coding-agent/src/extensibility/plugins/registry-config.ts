/**
 * Turn the install-source settings into the registries an install may ask.
 *
 * The settings describe intent; this resolves it against what is actually
 * configured, so the fallback chain's decision layer never has to know that a
 * setting exists. Three resolutions are deliberately silent rather than loud:
 *
 * - Settings that cannot be read at all resolve to "let the package manager
 *   decide", which is what every install did before these settings existed.
 * - A "custom" mode with no URL resolves the same way, because a custom source
 *   with no address has nothing to ask.
 * - A URL that is not an http(s) address resolves the same way, so a typo in a
 *   setting does not make installs impossible.
 *
 * The auto mode does not measure the registries before choosing. It asks the
 * official one first and falls back when a failure is one another registry could
 * answer — which is the failure that actually reaches a person as a stalled
 * install. Latency is deliberately not the signal: a registry that answers a
 * trivial request quickly can still be slow to serve a tarball, so a probe would
 * promise a speed it cannot establish.
 *
 * @module extensibility/plugins/registry-config
 */

import { Settings } from "../../config/settings";
import { normalizeRegistry, OFFICIAL_NPM_REGISTRY, type RegistryPlanConfig } from "./registry-fallback";

/**
 * The public registries the auto mode walks: the official registry first, the
 * mirror after it.
 */
const AUTO_CHAIN: readonly string[] = [OFFICIAL_NPM_REGISTRY, "https://registry.npmmirror.com/"];

/** The chain an install asks when nothing is configured: only its own. */
const PACKAGE_MANAGER_CHAIN: RegistryPlanConfig = { registry: null, fallbackRegistries: [], resolved: null };

/**
 * Read the install-source settings.
 *
 * @returns the registries one install may ask, in order; never empty.
 */
export function resolveRegistryConfig(): RegistryPlanConfig {
	// Settings are not always up when an install runs: reaching the singleton at
	// all throws when nothing has initialized it, and a CLI invocation can
	// install before the first read does.
	let mode: string;
	let fallbacks: string[];
	let customUrl: string | undefined;
	try {
		const settings = Settings.instance;
		mode = settings.get("pluginRegistryMode");
		fallbacks = settings.get("pluginRegistryFallbacks").filter(entry => entry.trim() !== "");
		customUrl = settings.get("pluginRegistryUrl");
	} catch {
		return PACKAGE_MANAGER_CHAIN;
	}

	if (mode === "custom") {
		const url = customUrl?.trim() ?? "";
		if (url === "") return PACKAGE_MANAGER_CHAIN;
		try {
			const normalized = normalizeRegistry(url);
			// The configured fallbacks still apply after a custom registry: an
			// internal index may not carry a package the public one does.
			return { registry: normalized, fallbackRegistries: fallbacks, resolved: normalized };
		} catch {
			return PACKAGE_MANAGER_CHAIN;
		}
	}

	if (mode === "bun") return PACKAGE_MANAGER_CHAIN;

	// The package manager's own registry stays out of this chain: it is unknown
	// until read, and an unknown registry must not sit in a chain holding public
	// ones.
	return {
		registry: AUTO_CHAIN[0] as string,
		fallbackRegistries: [...AUTO_CHAIN.slice(1), ...fallbacks],
		resolved: AUTO_CHAIN[0] as string,
	};
}
