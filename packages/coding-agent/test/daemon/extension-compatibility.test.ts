/**
 * 回退保护② · 宿主 runtime 预检 + 豁免授予整链契约：
 * 不兼容插件在宿主 reconcile 装载时被结构化拒绝（failed 记录 + 错误码），
 * 授予精确版本豁免后重载放行且如实标注 exempted，extensions.list 透出
 * 版本与兼容性判定，extensions.setVersionExemption RPC 落盘并失效缓存。
 *
 * Why this exists: 宿主升级后旧插件静默装载可能崩溃或丢数据；若预检只在
 *  会话 loader 生效而宿主 runtime 绕过，管理面（list/详情弹窗）看到的是
 *  「在役」假象；若豁免不失效清单缓存，GUI 重拉仍是旧标注。
 *
 * A regression means: an incompatible plugin mounts, the failed record /
 *  list plane loses the gate truth, or granting an exemption does not change
 *  the next load's observable outcome.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { getProjectAgentDir, VERSION } from "@musepi/pi-utils";
import { CordisDynamicExtensionRuntime } from "../../src/daemon/cordis-dynamic-extensions";
import { DaemonHostContext } from "../../src/daemon/host-context";
import { ExtensionService } from "../../src/daemon/services/extension-service";
import { DynamicExtensionLoadError } from "../../src/extensibility/extensions/dynamic-extension-error";
import {
	readCompatibilityExemptions,
	resolveCompatibilityPath,
} from "../../src/extensibility/plugins/compatibility-store";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

const PLUGIN = "compat-guard";
const PLUGIN_VERSION = "2.3.4";
const UNMET_RANGE = "^99.0.0";

describe("插件兼容性预检（回退保护② · 宿主 runtime 整链）", () => {
	let agentDir: string;
	let projectDir: string;
	let host: DaemonHostContext;
	let dynamic: CordisDynamicExtensionRuntime;
	let extService: ExtensionService;
	let pluginDir: string;

	beforeAll(async () => {
		agentDir = await isolateAgentDirForTest("compat-preflight-");
		projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "compat-preflight-proj-"));
		pluginDir = path.join(getProjectAgentDir(projectDir), "extensions", PLUGIN);
		fs.mkdirSync(pluginDir, { recursive: true });
		fs.writeFileSync(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: PLUGIN,
				version: PLUGIN_VERSION,
				peerDependencies: { "@musepi/pi-coding-agent": UNMET_RANGE },
				musepi: { extensions: ["./index.ts"] },
			}),
		);
		fs.writeFileSync(
			path.join(pluginDir, "index.ts"),
			`export default function (pi) { pi.registerCommand("${PLUGIN}-probe", { handler: async () => "ok" }); }\n`,
		);
		host = new DaemonHostContext();
		dynamic = new CordisDynamicExtensionRuntime(host);
		extService = new ExtensionService({
			settings: () => Settings.isolated(),
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

	it("预检拒绝：load 抛 incompatible-peer 结构化错，记录 failed 且透出 gate", async () => {
		const error = await dynamic.load(pluginDir, projectDir).catch(err => err);
		expect(error).toBeInstanceOf(DynamicExtensionLoadError);
		expect((error as DynamicExtensionLoadError).code).toBe("incompatible-peer");
		expect((error as Error).message).toContain(UNMET_RANGE);

		const record = dynamic.inspect().find(r => r.name === PLUGIN);
		expect(record?.status).toBe("failed");
		expect(record?.error).toContain(UNMET_RANGE);
		expect(record?.version).toBe(PLUGIN_VERSION);
		expect(record?.compatibility?.code).toBe("incompatible-peer");
		expect(record?.compatibility?.status).toBe("incompatible");
		expect(record?.compatibility?.plugin).toEqual({ name: PLUGIN, version: PLUGIN_VERSION });
	});

	it("list 面透出 version + compatibility（GUI 归因段数据源）", async () => {
		const { extensions } = await extService.list();
		const entry = extensions.find(e => e.id === `extension-module:${PLUGIN}`);
		expect(entry).toBeDefined();
		expect(entry?.version).toBe(PLUGIN_VERSION);
		expect(entry?.compatibility?.code).toBe("incompatible-peer");
		expect(entry?.compatibility?.status).toBe("incompatible");
	});

	it("setVersionExemption 授予（acceptRisk + 当前运行时）→ 重载放行且标注 exempted", async () => {
		const result = await extService.setVersionExemption({
			package: `${PLUGIN}@${PLUGIN_VERSION}`,
			runtimeVersion: VERSION,
			enabled: true,
			acceptRisk: true,
		});
		expect(result).toEqual({ ok: true });

		// 落盘证据：精确 name@version → [当前运行时]。
		const state = readCompatibilityExemptions(resolveCompatibilityPath());
		expect(state.exemptions).toEqual({ [`${PLUGIN}@${PLUGIN_VERSION}`]: [VERSION] });

		// 重载：同一记录复用（failed → active），gate 如实转 exempted，命令面真实可用。
		const handle = await dynamic.load(pluginDir, projectDir);
		expect(handle.name).toBe(PLUGIN);
		const record = dynamic.inspect().find(r => r.name === PLUGIN);
		expect(record?.status).toBe("active");
		expect(record?.compatibility?.status).toBe("exempted");
		await expect(handle.invoke(`${PLUGIN}-probe`)).resolves.toBe("ok");
	});

	it("撤销豁免 → 落盘移除 + 缓存失效（list 不再标注 exempted）", async () => {
		await extService.setVersionExemption({
			package: `${PLUGIN}@${PLUGIN_VERSION}`,
			runtimeVersion: VERSION,
			enabled: false,
			acceptRisk: false,
		});
		expect(readCompatibilityExemptions(resolveCompatibilityPath()).exemptions).toEqual({});
		// 缓存已失效：重拉 list 不再带 exempted 标注（在役记录仍是 active——
		// 撤销只影响**下次装配**，不热卸载在役 fiber，与 dsh 口径一致）。
		const { extensions } = await extService.list();
		const entry = extensions.find(e => e.id === `extension-module:${PLUGIN}`);
		expect(entry?.compatibility?.status).not.toBe("exempted");
	});
});
