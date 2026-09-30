/**
 * 组件对齐刀 · 接线契约：extensions.setComponentEnabled 的 user 插件径
 * （extension-module 条目清单 `musepi.components` 声明的 entry 组件）与
 * extensions.list 的组件 runtime 面下发。
 *
 * Why this exists: 组件开关从「builtin deny 软开关」扩展到「user 插件
 * entry 组件 = fiber 子插件」后,回归路径：
 *  - RPC 只写黑名单不触 fiber → 禁用后组件命令实际仍可调用（展示层开关）；
 *  - 运行时尚未 reconcile（插件未装载）时开关直接抛错而不是先装载再切换；
 *  - list 组件面不带 fiber 运行态 → GUI 详情弹窗组件行无真实状态可显示。
 *
 * A regression means: the toggle lies (command still callable), the first
 * toggle fails on a freshly started daemon, or the list plane loses the
 * per-component fiber truth.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { getProjectAgentDir } from "@musepi/pi-utils";
import { CordisDynamicExtensionRuntime } from "../../src/daemon/cordis-dynamic-extensions";
import { DaemonHostContext } from "../../src/daemon/host-context";
import { ExtensionService } from "../../src/daemon/services/extension-service";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

const PLUGIN = "svc-comps";

describe("extensions.setComponentEnabled user 插件径（组件对齐刀接线）", () => {
	let agentDir: string;
	let projectDir: string;
	let host: DaemonHostContext;
	let dynamic: CordisDynamicExtensionRuntime;
	let extService: ExtensionService;
	let settings: Settings;

	beforeAll(async () => {
		agentDir = await isolateAgentDirForTest("component-toggle-");
		projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "component-toggle-proj-"));
		const pluginDir = path.join(getProjectAgentDir(projectDir), "extensions", PLUGIN);
		fs.mkdirSync(pluginDir, { recursive: true });
		fs.writeFileSync(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: PLUGIN,
				version: "0.0.0",
				musepi: {
					extensions: ["./index.ts"],
					components: [
						{ id: "alpha", description: "Alpha unit", entry: "./alpha.ts" },
						{ id: "beta", entry: "./beta.ts" },
					],
				},
			}),
		);
		fs.writeFileSync(
			path.join(pluginDir, "index.ts"),
			`export default function (pi) { pi.registerCommand("${PLUGIN}-main", { handler: async () => "main" }); }\n`,
		);
		fs.writeFileSync(
			path.join(pluginDir, "alpha.ts"),
			`export default function (pi) { pi.registerCommand("${PLUGIN}-alpha", { handler: async () => "alpha" }); }\n`,
		);
		fs.writeFileSync(
			path.join(pluginDir, "beta.ts"),
			`export default function (pi) { pi.registerCommand("${PLUGIN}-beta", { handler: async () => "beta" }); }\n`,
		);
		host = new DaemonHostContext();
		dynamic = new CordisDynamicExtensionRuntime(host);
		settings = Settings.isolated();
		extService = new ExtensionService({
			settings: () => settings,
			ensureRegistry: async () => ({}),
			cwd: () => projectDir,
			webUrl: () => null,
			webPortFile: () => path.join(projectDir, "web.port"),
			dynamicRuntime: () => Promise.resolve(dynamic),
			onChanged: () => {},
		});
	}, 30_000);

	afterAll(async () => {
		await dynamic.dispose();
		await host.dispose();
		fs.rmSync(projectDir, { recursive: true, force: true });
		await restoreAgentDirForTest(agentDir);
	}, 30_000);

	it("首次开关（运行时尚未 reconcile）：先装载再切换,黑名单持久化且 fiber 真实停用", async () => {
		await extService.setComponentEnabled({ id: `extension-module:${PLUGIN}`, component: "alpha", enabled: false });

		// 黑名单落盘（复合键 <plugin>/<component>）。
		const denylist = settings.get("disabledExtensionComponents") as string[];
		expect(denylist).toContain(`${PLUGIN}/alpha`);

		// fiber 真实停用：宿主命令面缺席（不是展示层）。
		const record = dynamic.inspect().find(r => r.name === PLUGIN);
		expect(record?.status).toBe("active");
		expect(record?.components.find(c => c.id === "alpha")?.status).toBe("disabled");
		expect(record?.components.find(c => c.id === "beta")?.status).toBe("active");
	});

	it("list 组件面：enabled/canToggle/disabledReason + 组件级 fiber runtime 如实下发", async () => {
		const { extensions } = await extService.list();
		const entry = extensions.find(e => e.id === `extension-module:${PLUGIN}`);
		expect(entry).toBeDefined();
		const byId = new Map(entry?.components?.map(c => [c.id, c]));
		expect(byId.get("alpha")?.enabled).toBe(false);
		expect(byId.get("alpha")?.canToggle).toBe(true);
		expect(byId.get("alpha")?.disabledReason).toBe("component-disabled");
		expect(byId.get("beta")?.enabled).toBe(true);
		expect(byId.get("beta")?.runtime?.fiberState).toBe("ACTIVE");
		expect(byId.get("beta")?.runtime?.effects).toBeGreaterThan(0);
	});

	it("重新启用：黑名单移除、组件 fiber 重挂、命令面恢复", async () => {
		await extService.setComponentEnabled({ id: `extension-module:${PLUGIN}`, component: "alpha", enabled: true });
		expect(settings.get("disabledExtensionComponents") as string[]).not.toContain(`${PLUGIN}/alpha`);
		expect(
			dynamic
				.inspect()
				.find(r => r.name === PLUGIN)
				?.components.find(c => c.id === "alpha")?.status,
		).toBe("active");
	});

	it("未声明组件：结构化拒绝且黑名单不落盘", async () => {
		const before = [...(settings.get("disabledExtensionComponents") as string[])];
		const error = await extService
			.setComponentEnabled({ id: `extension-module:${PLUGIN}`, component: "nope", enabled: false })
			.catch(err => err);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("nope");
		expect(settings.get("disabledExtensionComponents") as string[]).toEqual(before);
	});
});
