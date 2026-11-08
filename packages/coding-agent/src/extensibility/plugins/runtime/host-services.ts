/**
 * Host-level service registry: the objects a host-scope plugin publishes
 * through `provide` in its Cordis entry.
 *
 * Cordis gives every plugin `ctx.get(name)` over one registry per application.
 * MusePi's session plugins have no shared process context, so the host keeps
 * this registry instead: the bundled loader publishes a host plugin's returned
 * object under the names its entry declares, and both host code and
 * `ctx.service(name)` read it back. Values are process-wide by construction —
 * only `musepi.scope: "host"` packages publish here.
 */
const services = new Map<string, unknown>();

/** Publish one host service. Returns a disposer that removes it if unchanged. */
export function provideHostService(name: string, service: unknown): () => void {
	services.set(name, service);
	return () => {
		if (services.get(name) === service) services.delete(name);
	};
}

/** The published object for `name`, or undefined when no host plugin provided it. */
export function getHostService<T>(name: string): T | undefined {
	return services.get(name) as T | undefined;
}

/** Whether a host plugin published `name`. Used by the `inject` gate. */
export function hasHostService(name: string): boolean {
	return services.has(name);
}

/** Test/teardown helper: drop every published host service. */
export function clearHostServices(): void {
	services.clear();
}
