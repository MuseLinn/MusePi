/**
 * 收编第二刀 · 接线契约：ExtensionService.getExtensionRuntimeLoad 的
 * cordis fiber 路径（dynamicRuntime 注入）与既有失效链的 reconcile。
 *
 * Why this exists: 宿主级 session-less 装载从「直接 loadExtensions」切到
 * 「每插件一 cordis fiber + 效果账本」。回归路径：
 *  - fiber 路径结果形状与直接装载不一致 → design.systems.list 宿主重放
 *    拿不到扩展注册（welcome 预览 rail 空白）；
 *  - 失效（invalidateExtensionsCache）后 reconcile 不卸载消失的路径 →
 *    卸包残留 stale 设计体系；
 *  - 宿主未注入 dynamicRuntime（测试/降级）时回退直接装载的行为漂移。
 *
 * A regression means: the rail goes stale, a removed extension's design
 * system survives invalidation, or the fallback path stops loading.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { clearExtensionDesignSystems } from "@musepi/pi-coding-agent/presets/design-systems";
import { getProjectAgentDir } from "@musepi/pi-utils";
import { CordisDynamicExtensionRuntime } from "../../src/daemon/cordis-dynamic-extensions";
import { DaemonHostContext } from "../../src/daemon/host-context";
import { DesignSystemsService } from "../../src/daemon/services/design-systems-service";
import { ExtensionService } from "../../src/daemon/services/extension-service";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

const FIXTURE_ID = "fiber-host-replay-brand";
const FIXTURE_BRIEF = "FIBER-HOST-REPLAY-BRIEF";

describe("getExtensionRuntimeLoad cordis fiber 接线（收编第二刀）", () => {
	let agentDir: string;
	let projectDir: string;
	let fixturePath: string;
	let fixtureSourceId = "";
	let host: DaemonHostContext;
	let dynamic: CordisDynamicExtensionRuntime;
	let extService: ExtensionService;
	let dsService: DesignSystemsService;

	beforeAll(async () => {
		agentDir = await isolateAgentDirForTest("fiber-runtime-load-");
		projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "fiber-runtime-proj-"));
		const extensionsDir = path.join(getProjectAgentDir(projectDir), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		fixturePath = path.join(extensionsDir, "fiber-brand.ts");
		fs.writeFileSync(
			fixturePath,
			`
export default function (pi) {
	pi.registerDesignSystem({
		id: "${FIXTURE_ID}",
		label: "Fiber Host Replay Brand",
		description: "fixture extension design system",
		swatches: ["#112233"],
		tokens: { "--accent": "#112233" },
		promptSection: { name: "design-system", order: 40, text: "${FIXTURE_BRIEF}" },
	});
}
`,
		);
		host = new DaemonHostContext();
		dynamic = new CordisDynamicExtensionRuntime(host);
		const settings = Settings.isolated();
		extService = new ExtensionService({
			settings: () => settings,
			ensureRegistry: async () => ({}),
			cwd: () => projectDir,
			webUrl: () => null,
			webPortFile: () => path.join(projectDir, "web.port"),
			dynamicRuntime: () => Promise.resolve(dynamic),
			onChanged: () => {},
		});
		dsService = new DesignSystemsService({ extensionRuntimeLoad: () => extService.getExtensionRuntimeLoad() });
	}, 30_000);

	afterAll(async () => {
		// 注册表是模块级全局：宿主重放写入的行不许漏进别的套件。
		if (fixtureSourceId) clearExtensionDesignSystems(fixtureSourceId);
		await dynamic.dispose();
		await host.dispose();
		fs.rmSync(projectDir, { recursive: true, force: true });
		await restoreAgentDirForTest(agentDir);
	}, 30_000);

	it("fiber 路径装载：设计体系经宿主重放可见（与直接装载同形状）", async () => {
		const { systems } = await dsService.listDesignSystems();
		const row = systems.find(s => s.id === FIXTURE_ID);
		expect(row?.source).toBe("extension");
		expect(row?.promptSection.text).toBe(FIXTURE_BRIEF);

		const load = await extService.getExtensionRuntimeLoad();
		fixtureSourceId =
			load.runtime.pendingDesignSystemRegistrations.find(r => r.config.id === FIXTURE_ID)?.sourceId ?? "";
		expect(fixtureSourceId.length).toBeGreaterThan(0);

		// fiber 装载的在役扩展同样进入 extensions 聚合面。
		expect(load.errors).toEqual([]);
		expect(load.extensions.length).toBeGreaterThan(0);
	});

	it("TTL 重入不重复登记：连续两次 list 不抛冲突、列表去重", async () => {
		const first = await dsService.listDesignSystems();
		const second = await dsService.listDesignSystems();
		expect(second.systems.filter(s => s.id === FIXTURE_ID)).toHaveLength(1);
		expect(second.systems.map(s => s.id)).toEqual(first.systems.map(s => s.id));
	});

	it("失效后 reconcile：删扩展源 + invalidate → fiber 卸载、效果回收、无残留", async () => {
		fs.rmSync(fixturePath, { force: true });
		extService.invalidateExtensionsCache();
		const { systems } = await dsService.listDesignSystems();
		expect(systems.find(s => s.id === FIXTURE_ID)).toBeUndefined();
	});
});
