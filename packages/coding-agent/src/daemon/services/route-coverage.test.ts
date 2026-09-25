import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEGACY_ROUTES } from "./legacy-routes";
import { HostServices } from "./registry";
import { UsageService } from "./usage-service";

/** 路由覆盖快照（P1 服务抽取纪律）：server.ts 巨型 switch 的每个 case
 *  必须二选一——委托给 HostServices 某服务，或登记在 LEGACY_ROUTES。
 *  新增 RPC 两处都不落 → 本测试失败。清单只减不增是 P1 的进度表。 */

function switchCases(): string[] {
	const source = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8");
	const cases = new Set<string>();
	const pattern = /case "([a-zA-Z][a-zA-Z0-9._-]*)":/g;
	for (const match of source.matchAll(pattern)) {
		cases.add(match[1]);
	}
	return [...cases].sort();
}

function registryRoutes(): Map<string, string> {
	const services = new HostServices();
	services.register(
		new UsageService({
			get: () => undefined,
			ensureRegistry: async () => null,
		}),
	);
	return services.routeTable();
}

describe("P1 route coverage", () => {
	it("every switch case is claimed by a service or the legacy manifest", () => {
		const table = registryRoutes();
		const legacy = new Set(LEGACY_ROUTES);
		const uncovered = switchCases().filter(route => !table.has(route) && !legacy.has(route));
		expect(uncovered).toEqual([]);
	});

	it("delegated routes and legacy manifest are disjoint", () => {
		const table = registryRoutes();
		const overlap = LEGACY_ROUTES.filter(route => table.has(route));
		expect(overlap).toEqual([]);
	});

	it("legacy manifest has no duplicate entries", () => {
		expect(new Set(LEGACY_ROUTES).size).toBe(LEGACY_ROUTES.length);
	});

	it("service routeTable rejects duplicate route claims across services", () => {
		const services = new HostServices();
		services.register(
			new UsageService({
				get: () => undefined,
				ensureRegistry: async () => null,
			}),
		);
		const clash = new UsageService({
			get: () => undefined,
			ensureRegistry: async () => null,
		});
		// Same key can't be registered twice either.
		expect(() => services.register(clash)).toThrow(/duplicate service key/);
	});
});
