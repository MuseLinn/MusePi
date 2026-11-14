import { describe, expect, it } from "bun:test";
import { DiagnosticsService } from "./diagnostics-service";
import type { DaemonService } from "./types";

describe("DiagnosticsService catalog", () => {
	const service = new DiagnosticsService({
		inspect: () => ({
			keys: ["zeta", "alpha", "orphan"],
			registrySize: 4,
			lifecycles: { zeta: "external", alpha: "cordis" },
		}),
		services: (): Pick<DaemonService, "key" | "routes">[] => [
			{ key: "zeta", routes: { "zeta.run": "run", "zeta.list": "list" } },
			{ key: "alpha" },
			{ key: "unregistered", routes: { "ghost.route": "ghost" } },
		],
	});

	it("lists only services that are really mounted on the cordis context", () => {
		// Failure mode if regressed: reporting the registry instead of the mounted
		// set hides a service whose mount never settled — the exact state an
		// operator needs to see after a failed startup.
		expect(service.list().services.map(entry => entry.key)).toEqual(["alpha", "zeta"]);
	});

	it("reports each service's lifecycle authority and sorted routes", () => {
		const catalog = service.list();
		expect(catalog.registrySize).toBe(4);
		expect(catalog.services).toEqual([
			{ key: "alpha", lifecycle: "cordis", routes: [] },
			{ key: "zeta", lifecycle: "external", routes: ["zeta.list", "zeta.run"] },
		]);
		expect(catalog.lifecycle).toEqual({ cordis: 1, external: 1 });
	});

	it("treats a mounted service with no recorded authority as external", () => {
		// "orphan" is mounted but has no lifecycle record; the catalog must not
		// claim framework ownership it cannot prove.
		const catalog = new DiagnosticsService({
			inspect: () => ({ keys: ["orphan"], registrySize: 1, lifecycles: {} }),
			services: () => [{ key: "orphan" }],
		}).list();
		expect(catalog.services[0]?.lifecycle).toBe("external");
	});
});
