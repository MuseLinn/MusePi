/**
 * Which package registries one install asks, in order, and what a failed attempt
 * could not reach.
 *
 * Asking a second registry is only worth doing when the failure was the
 * registry's to fix. A package whose tarball came back 502 from its own CDN, or
 * a git host that could not be resolved, will fail identically everywhere — and
 * retrying it against another registry costs the person time and buys nothing.
 * That distinction is what {@link attributeFailure} decides, and it is the whole
 * reason a fallback chain is more than "try again elsewhere".
 *
 * Two invariants hold across the module:
 *
 * - A private registry is never skipped and never replaced. It is asked first
 *   when it is configured first, and a package that exists only on an internal
 *   index is therefore never asked for by name on a public registry that does
 *   not own it. A public mirror may still follow it as a fallback, for the
 *   packages it does not carry.
 * - The package manager's own registry (`null`) never becomes the fallback of a
 *   public one while it names something private or unknown.
 * - The chain is never empty. An install always asks something, so a
 *   misconfiguration degrades to "one registry, asked alone" rather than to a
 *   silent no-op.
 *
 * @module extensibility/plugins/registry-fallback
 */

import type { ParsedInstallSpec } from "./spec-classifier";

/** npm's own registry: the one a chain trusts as public without being told. */
export const OFFICIAL_NPM_REGISTRY = "https://registry.npmjs.org/";

/** The public mirror used as the fallback when the official registry is asked. */
export const NPMMIRROR_REGISTRY = "https://registry.npmmirror.com/";

/**
 * A registry as the package manager's `--registry` takes it.
 *
 * `null` is the one the package manager's own configuration names — the
 * absence of a decision, which the plan treats as a registry only once what it
 * resolves to is known.
 */
export type Registry = string | null;

/** The registries one install will ask. */
export interface RegistryPlanConfig {
	/** The first registry: a URL, or `null` to defer to the package manager. */
	readonly registry: Registry;
	/** Registries to ask after the first, in order. */
	readonly fallbackRegistries: readonly string[];
	/**
	 * What the package manager's own configuration resolves to, when that is
	 * known — `null` when it names nothing, or when it has not been read.
	 *
	 * This is what makes `null` usable in a chain. Without it, `null` could only
	 * ever mean "unknown", and an unknown registry is asked alone; with it, a
	 * profile whose package manager configuration resolves to npm's own registry
	 * can be followed by the mirror, which is the configuration most installs
	 * actually have.
	 */
	readonly resolved: Registry;
}

/**
 * Parse a registry URL into the form two registries are compared in.
 *
 * Comparison is what makes deduplication and the public/private decision
 * possible, so it normalizes away everything that does not change which server
 * answers: host case, and the presence of the trailing slash.
 *
 * @param url - the registry as configured or requested.
 * @returns the normalized URL.
 * @throws {Error} for anything but an http(s) URL — a registry that cannot be
 * reached is a misconfiguration, and passing it to the package manager would
 * fail later with a message about the install instead.
 */
export function normalizeRegistry(url: string): string {
	let parsed: URL | undefined;
	try {
		parsed = new URL(url);
	} catch {
		// Named below: only an http(s) URL is a registry.
	}
	if (parsed === undefined || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
		throw new Error(`a registry must be an http(s) URL: ${url}`);
	}
	if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
	return parsed.href;
}

/**
 * The registries one install asks, first to last.
 *
 * The configured set is the configured first registry and the fallbacks. A
 * caller that names a registry asks it first when it is one of them, and alone
 * otherwise — so naming a registry outside the configured set does not silently
 * gain the configured fallbacks, which would defeat the private-never-public
 * rule in the other direction.
 *
 * The package manager's own registry (`null`) enters the candidate set only
 * when what it names is known to be public: npm's own, or one of the configured
 * fallbacks. While it names anything else, or while nothing says what it names,
 * it is asked alone, and a public registry asked instead never falls back into
 * it.
 *
 * @param requested - the registry the caller asked for; `undefined` defers to
 * the configured first one.
 * @param config - the configured first registry and the fallbacks after it.
 * @returns the registries to ask, in order; never empty.
 */
export function registryPlan(requested: Registry | undefined, config: RegistryPlanConfig): Registry[] {
	// What the package manager's own configuration resolves to. Until that is
	// read it is unknown, and an unknown registry is asked alone.
	const own = config.resolved === null ? null : normalizeRegistry(config.resolved);
	const fallbacks = config.fallbackRegistries.map(normalizeRegistry);
	const ownIsPublic = own !== null && (own === OFFICIAL_NPM_REGISTRY || fallbacks.includes(own));

	// What a registry is compared as: the package manager's own registry stands
	// for the URL it names, once that is known.
	const keyOf = (registry: Registry): string | null => (registry === null ? own : normalizeRegistry(registry));

	const known: Registry[] = [];
	const keys: (string | null)[] = [];
	for (const registry of [config.registry, ...config.fallbackRegistries]) {
		if (registry === null && !ownIsPublic) continue;
		const key = keyOf(registry);
		if (keys.includes(key)) continue;
		known.push(registry === null ? null : normalizeRegistry(registry));
		keys.push(key);
	}

	const first = requested === undefined ? config.registry : requested;
	const firstKey = keyOf(first);
	const normalizedFirst = first === null ? null : normalizeRegistry(first);

	// A private or unknown registry of the package manager's own, whichever way
	// it was asked for, is asked alone.
	if ((first === null || firstKey === own) && !ownIsPublic) return [normalizedFirst];
	// A registry outside the configured set is asked alone; the configured
	// fallbacks were chosen for the configured first one.
	if (!keys.includes(firstKey)) return [normalizedFirst];
	return [normalizedFirst, ...known.filter((_registry, index) => keys[index] !== firstKey)];
}

/**
 * The `--registry` argument for a registry, or none when the package manager's
 * own configuration decides.
 *
 * @param registry - the registry to ask.
 * @returns the argv fragment, or an empty array.
 */
export function registryArgument(registry: Registry): string[] {
	return registry === null ? [] : [`--registry=${registry}`];
}

/**
 * Failure shapes another registry could answer differently: this one was
 * unreachable, or its copy may not have the package yet.
 *
 * A refusal the package itself made is not in this set — a package that was
 * rejected for its own reasons will be rejected the same way everywhere.
 */
const NEXT_REGISTRY_KINDS: ReadonlySet<string> = new Set(["network", "timeout", "not-found", "no-matching-version"]);

/**
 * A line of output that reports a failure, as opposed to a warning or a
 * progress line. Warnings routinely name hosts too, and treating one as a
 * failure would send every install that mentions a mirror into a pointless
 * second attempt.
 */
const ERROR_LINE = /ERR_|ERROR|\berror\b|fatal:|Could not resolve|unable to access|ssh:|\bE[A-Z]{4,}\b/;

/**
 * What a failed attempt could not reach or get an answer from.
 *
 * - `registry` — another registry might answer differently; a retry is worth it.
 * - `spec-host` — an error line names the host a git or tarball spec is fetched
 *   from, and no registry stands in for it. Only the spec's own dependencies
 *   come from a registry.
 * - `other` — the failure is not one a registry explains.
 */
export type FailureAttribution = "registry" | "spec-host" | "other";

/**
 * Decide whether asking another registry could change the outcome.
 *
 * The test is deliberately narrow. A git or tarball spec is fetched from its
 * own host, so a registry only affects the dependencies that package pulls in;
 * when the failure names that host, switching registries cannot help. The same
 * error line means the opposite for a package spec, where every byte comes
 * through the registry — which is why the spec's kind is part of the decision
 * rather than the message alone.
 *
 * @param kind - how the attempt failed.
 * @param log - what the attempt printed.
 * @param spec - the spec the attempt installed.
 * @returns whether another registry is worth asking.
 */
export function attributeFailure(kind: string, log: string, spec: ParsedInstallSpec): FailureAttribution {
	if (!NEXT_REGISTRY_KINDS.has(kind)) return "other";
	const host = spec.kind === "git" || spec.kind === "tarball" ? spec.host?.toLowerCase() : undefined;
	// A registry spec is fetched through the registry, so any of these failures
	// is the registry's to have.
	if (host === undefined) return "registry";
	const named = log.split("\n").some(line => ERROR_LINE.test(line) && line.toLowerCase().includes(host));
	return named ? "spec-host" : "registry";
}
