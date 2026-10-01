/**
 * 文件 backend 组件通道 · 端到端契约：插件「包含的组件」开关
 * （extensions.setComponentEnabled）经 file-backend deny 通道写
 * `file.disabledBackends`，名单被真实消费——read/write/search 被禁后
 * 工具不再进入会话工具集（isToolAllowed 谓词），index 被禁后 daemon
 * 停止后台扫描（server.ts index.scan 门）。
 *
 * Why this exists: 文件子系统此前散置为工具 + 索引、无插件面；dsh fs
 * 插件族（tool-fs / tool-str-replace-editor / tool-fs-search）的 parity
 * 要求组件开关落到真实启停行为，而不是只改名单的展示层。
 *
 * A regression means: 开关写了别的键（名单漂移）、list 组件状态与名单
 * 不一致、被禁工具仍进工具集、或 index 被禁后扫描照跑。
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { ExtensionService } from "../../src/daemon/services/extension-service";
import { BUILTIN_EXTENSIONS } from "../../src/extensibility/extensions-center/builtin-registry";
import {
	fileBackendForTool,
	isFileBackendToolAllowed,
	isFileIndexBackendEnabled,
	readDisabledFileBackends,
} from "../../src/tools/file-backend";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

const FILE_ID = "file:file";

describe("文件 backend 组件通道（file-backend deny）", () => {
	let agentDir: string;
	let settings: Settings;
	let extService: ExtensionService;

	beforeAll(async () => {
		agentDir = await isolateAgentDirForTest("file-backend-component-");
		settings = Settings.isolated();
		extService = new ExtensionService({
			settings: () => settings,
			ensureRegistry: async () => ({}),
			cwd: () => process.cwd(),
			webUrl: () => null,
			webPortFile: () => "",
			dynamicRuntime: () => Promise.resolve(undefined),
			onChanged: () => {},
		});
	}, 30_000);

	afterAll(async () => {
		await restoreAgentDirForTest(agentDir);
	}, 30_000);

	it("注册表投影契约：file 行组件 = read/write/search/index × file-backend，无总开关", () => {
		const file = BUILTIN_EXTENSIONS.find(d => d.kind === "file" && d.name === "file");
		expect(file?.readonly).toBe(true);
		// 不发明总开关语义（与 terminal 行同哲学）。
		expect(file?.settingsMirror).toBeUndefined();
		expect(file?.components?.map(c => [c.id, c.deny])).toEqual([
			["read", "file-backend"],
			["write", "file-backend"],
			["search", "file-backend"],
			["index", "file-backend"],
		]);
	});

	it("setComponentEnabled 写 file.disabledBackends（不是 voice/tools/terminal/browser 名单）", async () => {
		await extService.setComponentEnabled({ id: FILE_ID, component: "write", enabled: false });
		expect(settings.get("file.disabledBackends") as string[]).toContain("write");
		expect(settings.get("voice.disabledEngines") as string[]).toEqual([]);
		expect(settings.get("tools.disabled") as string[]).toEqual([]);
		expect(settings.get("terminal.disabledBackends") as string[]).toEqual([]);
		expect(settings.get("browser.disabledBackends") as string[]).toEqual([]);
	});

	it("list 组件面如实下发：被禁组件 enabled=false + canToggle", async () => {
		const { extensions } = await extService.list();
		const file = extensions.find(e => e.id === FILE_ID);
		expect(file).toBeDefined();
		const byId = new Map(file?.components?.map(c => [c.id, c]));
		expect(byId.get("write")?.enabled).toBe(false);
		expect(byId.get("write")?.canToggle).toBe(true);
		expect(byId.get("read")?.enabled).toBe(true);
		expect(byId.get("search")?.enabled).toBe(true);
		expect(byId.get("index")?.enabled).toBe(true);
	});

	it("重新启用：名单移除、list 恢复 enabled", async () => {
		await extService.setComponentEnabled({ id: FILE_ID, component: "write", enabled: true });
		expect(settings.get("file.disabledBackends") as string[]).toEqual([]);
		const { extensions } = await extService.list();
		const file = extensions.find(e => e.id === FILE_ID);
		expect(file?.components?.find(c => c.id === "write")?.enabled).toBe(true);
	});

	it("未声明组件：结构化拒绝且名单不落盘", async () => {
		const before = [...(settings.get("file.disabledBackends") as string[])];
		const error = await extService
			.setComponentEnabled({ id: FILE_ID, component: "rename", enabled: false })
			.catch(err => err);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("rename");
		expect(settings.get("file.disabledBackends") as string[]).toEqual(before);
	});
});

describe("file-backend 谓词消费 disabledBackends", () => {
	it("readDisabledFileBackends：坏值/非数组 fail-soft 为空集", () => {
		expect(readDisabledFileBackends({ get: () => "nope" }).size).toBe(0);
		expect(
			readDisabledFileBackends({
				get: () => {
					throw new Error("boom");
				},
			}).size,
		).toBe(0);
		expect(readDisabledFileBackends({ get: () => ["index"] }).has("index")).toBe(true);
	});

	it("fileBackendForTool：工具名 → 后端分组映射（单一事实源）", () => {
		expect(fileBackendForTool("read")).toBe("read");
		expect(fileBackendForTool("write")).toBe("write");
		expect(fileBackendForTool("edit")).toBe("write");
		expect(fileBackendForTool("ast_edit")).toBe("write");
		expect(fileBackendForTool("glob")).toBe("search");
		expect(fileBackendForTool("grep")).toBe("search");
		expect(fileBackendForTool("ast_grep")).toBe("search");
		// 非文件子系统工具无后端归属。
		expect(fileBackendForTool("bash")).toBeNull();
		expect(fileBackendForTool("browser")).toBeNull();
	});

	it("isFileBackendToolAllowed：被禁后端剔除整个工具族，其余工具不受影响", () => {
		const denied = { get: () => ["write"] };
		expect(isFileBackendToolAllowed("write", denied)).toBe(false);
		expect(isFileBackendToolAllowed("edit", denied)).toBe(false);
		expect(isFileBackendToolAllowed("ast_edit", denied)).toBe(false);
		expect(isFileBackendToolAllowed("read", denied)).toBe(true);
		expect(isFileBackendToolAllowed("grep", denied)).toBe(true);
		expect(isFileBackendToolAllowed("bash", denied)).toBe(true);
	});

	it("isFileIndexBackendEnabled：index 被禁 = false，其余后端被禁不影响", () => {
		expect(isFileIndexBackendEnabled({ get: () => ["read", "write", "search"] })).toBe(true);
		expect(isFileIndexBackendEnabled({ get: () => ["index"] })).toBe(false);
		expect(isFileIndexBackendEnabled({ get: () => [] })).toBe(true);
	});
});
