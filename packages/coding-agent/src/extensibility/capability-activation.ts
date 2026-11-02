/** Process-local activation registry shared by the daemon and separately
 * bundled component modules. A domain is implicitly available before its first
 * plugin mount, which keeps CLI and isolated worker paths backward compatible. */

const ACTIVATION_REGISTRY_KEY = Symbol.for("musepi.capability-activations");
const globalScope = globalThis as typeof globalThis & { [key: symbol]: unknown };
const registrations = (globalScope[ACTIVATION_REGISTRY_KEY] ?? new Map()) as Map<string, Map<string, symbol>>;
globalScope[ACTIVATION_REGISTRY_KEY] = registrations;

export function activateCapability(domain: string, id: string): () => void {
	let domainRegistrations = registrations.get(domain);
	if (!domainRegistrations) {
		domainRegistrations = new Map<string, symbol>();
		registrations.set(domain, domainRegistrations);
	}
	const token = Symbol(`${domain}:${id}`);
	domainRegistrations.set(id, token);
	return () => {
		if (domainRegistrations.get(id) === token) domainRegistrations.delete(id);
	};
}

export function isCapabilityActive(domain: string, id: string): boolean {
	return registrations.get(domain)?.has(id) ?? true;
}

/** Restore implicit availability after an isolated runtime is disposed. */
export function resetCapabilityActivations(): void {
	registrations.clear();
}
