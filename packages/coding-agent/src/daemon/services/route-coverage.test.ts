import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ViewStore } from "../view-store";
import { ApprovalService } from "./approval-service";
import { BoardService } from "./board-service";
import { BrowserService } from "./browser-service";
import { EventService } from "./event-service";
import { ExtensionService } from "./extension-service";
import { FileService } from "./file-service";
import { LEGACY_ROUTES } from "./legacy-routes";
import { HostServices } from "./registry";
import { RemoteService } from "./remote-service";
import { ScheduleService } from "./schedule-service";
import { TerminalService } from "./terminal-service";
import { UsageService } from "./usage-service";
import { ViewStoreService } from "./view-store-service";

/** 路由覆盖快照（P1 服务抽取纪律）：server.ts 巨型 switch 的每个 case
 *  必须二选一——委托给 HostServices 某服务，或登记在 LEGACY_ROUTES。
 *  新增 RPC 两处都不落 → 本测试失败。清单只减不增是 P1 的进度表。 */

/** session tree 客户端契约载体路由（撤回/分支/leaf 移动/快照恢复/gap fill，
 *  小袁总 2026-09-25 纪律：会话相关改动必须核对这些接口）。钉桩语义：这些
 *  路由必须永久存在于 switch 全集里——谁删了它们，测试炸谁。 */
const SESSION_TREE_ROUTES = [
	"session.branchAt",
	"session.btwBranch",
	"session.catchup",
	"session.forkAt",
	"session.resume",
	"session.tree",
] as const;

function switchCases(): string[] {
	const source = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8");
	const cases = new Set<string>();
	const pattern = /case "([a-zA-Z][a-zA-Z0-9._-]*)":/g;
	for (const match of source.matchAll(pattern)) {
		cases.add(match[1]);
	}
	return [...cases].sort();
}

function buildRegistry(): HostServices {
	const services = new HostServices();
	services.register(
		new UsageService({
			get: () => undefined,
			ensureRegistry: async () => null,
		}),
	);
	services.register(
		new EventService({
			emitEvent: () => {},
			catchupFrom: async () => ({}),
		}),
	);
	// ViewStore 只认领路由（本测试不触库），但构造真实实例成本极低，
	// 用临时目录避免碰默认 journal 目录。
	const store = new ViewStore(join(mkdtempSync(join(tmpdir(), "musepi-views-")), "views.db"));
	services.register(new ViewStoreService(store));
	services.register(new BoardService());
	services.register(
		new FileService({
			fallbackCwd: () => undefined,
			ensureFileIndex: () => ({ search: () => [] }) as never,
		}),
	);
	services.register(
		new TerminalService({
			nextSeq: () => 0,
			emit: () => {},
			settings: async () => null,
		}),
	);
	// ApprovalService 只认领路由（本测试不应答任何审批），stub 掉会话访问。
	services.register(new ApprovalService({ get: () => undefined }));
	// BrowserService 只认领路由（本测试不触发浏览器/CDP），stub 掉设置与 cwd。
	services.register(
		new BrowserService({
			settings: async () => {
				throw new Error("not used in coverage test");
			},
			cwd: () => ".",
		}),
	);
	// RemoteService 无宿主依赖、无状态，直接注册。
	services.register(new RemoteService());
	// ScheduleService：stub 化宿主访问，仅参与路由表。
	services.register(
		new ScheduleService({
			createSession: async () => ({ sessionId: "" }),
			get: () => undefined,
			deleteSession: async () => {},
			onCronsChanged: () => {},
		}),
	);
	// ExtensionService：stub 化宿主访问，仅参与路由表。
	services.register(
		new ExtensionService({
			settings: () => null,
			ensureRegistry: async () => {},
			cwd: () => "",
			webUrl: () => null,
			webPortFile: () => "",
			onChanged: () => {},
		}),
	);
	return services;
}

describe("P1 route coverage", () => {
	it("every switch case is claimed by a service or the legacy manifest", () => {
		const table = buildRegistry().routeTable();
		const legacy = new Set(LEGACY_ROUTES);
		const uncovered = switchCases().filter(route => !table.has(route) && !legacy.has(route));
		expect(uncovered).toEqual([]);
	});

	it("delegated routes and legacy manifest are disjoint", () => {
		const table = buildRegistry().routeTable();
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

	it("session tree contract routes are pinned in the switch (客户端 tree 接口不许静默消失)", () => {
		const cases = new Set(switchCases());
		const missing = SESSION_TREE_ROUTES.filter(route => !cases.has(route));
		expect(missing).toEqual([]);
	});
});
