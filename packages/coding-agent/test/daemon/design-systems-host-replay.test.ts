/**
 * Contract: 3.7d daemon 侧「装包即见」——design.systems.list 的宿主级重放
 * 与 marketplace.install/remove 的失效 + 广播链。
 *
 * Why this exists: welcome 页预览 rail 直渲染 design.systems.list；扩展
 * registerDesignSystem 的注册原本只在会话引导时重放，宿主进程里装包后
 * rail 永远看不到新体系。回归路径：装包 → GUI 不重拉 / 重拉了列表仍旧；
 * 卸包 → 残留 stale 体系；广播事件名不对 → GUI 单例注册表不重拉。
 *
 * A regression means: the rail goes stale after install/remove, a duplicate
 * replay throws an id-collision, or the broadcast is not `extensions.changed`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { clearExtensionDesignSystems } from "@musepi/pi-coding-agent/presets/design-systems";
import { getProjectAgentDir } from "@musepi/pi-utils";
import { DesignSystemsService } from "../../src/daemon/services/design-systems-service";
import { EventService } from "../../src/daemon/services/event-service";
import { ExtensionService } from "../../src/daemon/services/extension-service";
import { MarketplaceService } from "../../src/daemon/services/marketplace-service";
import * as marketplaceManager from "../../src/extensibility/plugins/marketplace/manager";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

const FIXTURE_ID = "host-replay-brand";
const FIXTURE_BRIEF = "HOST-REPLAY-BRAND-BRIEF";

// ═══════════════════════════════════════════════════════════════════════════
// 测试 A + B：装包即见 / 重放幂等（真实 ExtensionService 运行时加载管线）
// ═══════════════════════════════════════════════════════════════════════════

describe("design.systems.list host-level replay (装包即见)", () => {
	let agentDir: string;
	let projectDir: string;
	let fixturePath: string;
	let fixtureSourceId = "";
	let extService: ExtensionService;
	let dsService: DesignSystemsService;

	beforeAll(async () => {
		agentDir = await isolateAgentDirForTest("design-systems-host-");
		projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "design-systems-proj-"));
		const extensionsDir = path.join(getProjectAgentDir(projectDir), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		fixturePath = path.join(extensionsDir, "brand.ts");
		fs.writeFileSync(
			fixturePath,
			`
export default function (pi) {
	pi.registerDesignSystem({
		id: "${FIXTURE_ID}",
		label: "Host Replay Brand",
		description: "fixture extension design system",
		swatches: ["#112233"],
		tokens: { "--accent": "#112233" },
		promptSection: { name: "design-system", order: 40, text: "${FIXTURE_BRIEF}" },
	});
}
`,
		);
		const settings = Settings.isolated();
		extService = new ExtensionService({
			settings: () => settings,
			ensureRegistry: async () => ({}),
			cwd: () => projectDir,
			webUrl: () => null,
			webPortFile: () => path.join(projectDir, "web.port"),
			onChanged: () => {},
		});
		dsService = new DesignSystemsService({ extensionRuntimeLoad: () => extService.getExtensionRuntimeLoad() });
	}, 30_000);

	afterAll(async () => {
		// 注册表是模块级全局：宿主重放写入的行不许漏进别的套件。
		if (fixtureSourceId) clearExtensionDesignSystems(fixtureSourceId);
		fs.rmSync(projectDir, { recursive: true, force: true });
		await restoreAgentDirForTest(agentDir);
	}, 30_000);

	it("A: 扩展注册的设计体系经宿主重放出现在列表（装包即见）", async () => {
		const { systems } = await dsService.listDesignSystems();
		const row = systems.find(s => s.id === FIXTURE_ID);
		// 宿主进程无会话引导——列表必须经本 RPC 内的运行时加载 + 重放拿到扩展体系。
		expect(row?.source).toBe("extension");
		expect(row?.promptSection.text).toBe(FIXTURE_BRIEF);
		const load = await extService.getExtensionRuntimeLoad();
		fixtureSourceId =
			load.runtime.pendingDesignSystemRegistrations.find(r => r.config.id === FIXTURE_ID)?.sourceId ?? "";
		expect(fixtureSourceId.length).toBeGreaterThan(0);
	});

	it("B: 同一 sourceId 连续两次 list 不抛冲突、列表去重", async () => {
		const first = await dsService.listDesignSystems();
		const second = await dsService.listDesignSystems();
		expect(second.systems.filter(s => s.id === FIXTURE_ID)).toHaveLength(1);
		expect(second.systems.map(s => s.id)).toEqual(first.systems.map(s => s.id));
	});

	it("A: 卸包模拟（删扩展源 + invalidateExtensionsCache）后列表不再残留", async () => {
		fs.rmSync(fixturePath, { force: true });
		// marketplace.remove 的服务层链：invalidateExtensionsCache → GUI 重拉 → 本 RPC 重载 + 重放。
		extService.invalidateExtensionsCache();
		const { systems } = await dsService.listDesignSystems();
		expect(systems.find(s => s.id === FIXTURE_ID)).toBeUndefined();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// 测试 C：marketplace.install/remove 的失效 + 广播契约
// ═══════════════════════════════════════════════════════════════════════════

describe("marketplace.install/remove 失效与广播契约", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function makeService(calls: string[]): {
		service: MarketplaceService;
		installPlugin: ReturnType<typeof vi.fn>;
		uninstallPlugin: ReturnType<typeof vi.fn>;
	} {
		const installPlugin = vi.fn(async () => {});
		const uninstallPlugin = vi.fn(async () => {});
		// 类构造器的 mockImplementation 形参推导为 never：直接给实现函数做 never 断言。
		vi.spyOn(marketplaceManager, "MarketplaceManager").mockImplementation((() => ({
			installPlugin,
			uninstallPlugin,
		})) as never);
		const service = new MarketplaceService({
			cwd: () => fs.mkdtempSync(path.join(os.tmpdir(), "marketplace-contract-")),
			settings: () => null,
			extensionEntries: async () => [],
			invalidateExtensionsCache: () => calls.push("invalidateExtensionsCache"),
			invalidatePluginCaches: () => calls.push("invalidatePluginCaches"),
			onChanged: () => calls.push("onChanged"),
			onInstallState: () => {},
		});
		return { service, installPlugin, uninstallPlugin };
	}

	it("install 成功后的失效序：插件缓存 → 扩展运行时缓存 → 广播", async () => {
		const calls: string[] = [];
		const { service, installPlugin } = makeService(calls);
		const result = await service.install({ name: "some-plugin", marketplace: "default" });
		expect(result).toEqual({ ok: true, installed: true, scope: "user" });
		expect(installPlugin).toHaveBeenCalledTimes(1);
		// 关键契约：清扩展运行时加载缓存（设计体系重放依赖它重载）+ 广播
		// extensions.changed（宿主 onChanged → EventService.broadcastExtensionsChanged）。
		expect(calls).toEqual(["invalidatePluginCaches", "invalidateExtensionsCache", "onChanged"]);
	});

	it("remove 成功后的失效序与 install 同款", async () => {
		const calls: string[] = [];
		const { service, uninstallPlugin } = makeService(calls);
		const result = await service.remove({ name: "some-plugin", marketplace: "default" });
		expect(result).toEqual({ ok: true });
		expect(uninstallPlugin).toHaveBeenCalledTimes(1);
		expect(calls).toEqual(["invalidatePluginCaches", "invalidateExtensionsCache", "onChanged"]);
	});

	it("extensions.changed 广播事件名契约：GUI 单例注册表按此事件重拉", () => {
		const emitted: unknown[] = [];
		const events = new EventService({
			emitEvent: (_conn, event) => emitted.push(event),
			catchupFrom: async () => ({}),
		});
		events.subscribe({ id: "gui-client" });
		events.broadcastExtensionsChanged();
		expect(emitted).toHaveLength(1);
		const envelope = emitted[0] as { kind: string; payload: { type: string; at: number } };
		expect(envelope.kind).toBe("event");
		// 事件名即本任务验收关键：不是 extensions.changed，GUI 不会重拉 design.systems.list。
		expect(envelope.payload.type).toBe("extensions.changed");
		expect(typeof envelope.payload.at).toBe("number");
	});
});
