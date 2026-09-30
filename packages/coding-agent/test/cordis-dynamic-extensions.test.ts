/**
 * M2-2.9 收编第二刀：user 插件宿主级 cordis 装载运行时的契约测试。
 *
 * 钉死的契约（消费者 = getExtensionRuntimeLoad 的 session-less RPC，如
 * design.systems.list 的宿主重放，以及插件管理面的运行状态检视）：
 *  1. 加载：真实扩展目录（package.json musepi.extensions 入口，musepi 为权威
 *     清单字段）→ 命令可调用，检视如实报告 ACTIVE + 效果账本标签
 *     （真实 API verb 名：registerCommand:/on:/registerFlag:…）；
 *  2. 同源：扩展拿到的就是生产 ConcreteExtensionAPI（registerSetting/
 *     registerFlag/registerProvider 等行为与会话装载一致）；
 *  3. 隔离：跨扩展重名命令 = 结构化碰撞拒绝（教学式文案带归属），后加载者
 *     FAILED 且不留半挂载 fiber，先加载者登记不受影响；
 *  4. 生命周期：unload = fiber.dispose() 反向回收——命令从 extension 集合
 *     摘除（invoke 报能力缺席）、效果账本清空、registerProvider 从共享
 *     runtime 的排队注册注销、其他扩展的登记与回调原样存活；reload 拾取
 *     入口文件改写的新代码；
 *  5. reconcile（loadAll）：发现清单 ↔ 在役记录对账——extensions/errors/
 *     runtime 与 loadExtensions 同形状；清单路径消失 → 自动卸载且效果
 *     回收（design system/provider 排队注册随之注销），供 design.systems
 *     .list 的「按 sourceId 先 clear 再重放」消费；
 *  6. 检视：多扩展并列（状态/fiber 状态机/效果标签/错误归因）；
 *  7. 失败不留挂载：factory 抛错 → 结构化失败记录，宿主 Context 与其余
 *     扩展无损；
 *  8. HMR 实测口径：Bun 1.4.2（Windows）下裸查询串与 Bun.plugin onLoad
 *     均不能可靠击穿同进程模块缓存（spike 探针实测）；可靠口径 = loader
 *     的 loadLegacyPiModule 每次装载单调 `?mtime=` 标签（raw path），
 *     入口与子模块改写均在 reload 时拾取。
 *
 * 测试纪律（ADR 边界 3）：真 cordis Context（DaemonHostContext），不 mock。
 * fixture 扩展在临时目录程序化生成（含子模块 helper），不写仓库工作区。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	CordisDynamicExtensionRuntime,
	type DynamicExtensionHandle,
	DynamicExtensionLoadError,
} from "../src/daemon/cordis-dynamic-extensions";
import { DaemonHostContext } from "../src/daemon/host-context";

function probeManifest(name: string): string {
	return JSON.stringify({ name, version: "0.0.0", musepi: { extensions: ["./index.ts"] } });
}

/** probe-a：命令 + 事件订阅 + 设置/供应器登记（多 verb 账本面）；版本字面量
 *  与 greeting 分处入口/子模块，分别支撑入口改写拾取与子模块拾取两个 HMR 实测。 */
function probeAIndex(version: string): string {
	return `import { greeting } from "./helper";
const seen: string[] = [];
export default function extension(pi: any) {
	pi.registerCommand("probe-a-hello", { handler: async (args: string) => \`\${greeting()}:\${args}:${version}\` });
	pi.on("refresh", (line: string) => { seen.push(String(line)); });
	pi.registerCommand("probe-a-dump", { handler: async () => seen.join(",") });
	pi.registerSetting({ key: "probe-a.opt", description: "opt", defaultValue: 1 });
	pi.registerFlag("probe-a-flag", { type: "boolean", default: true });
	pi.registerProvider("probe-provider", {});
}
`;
}

const PROBE_A_HELPER = `export function greeting() { return "A"; }
`;

const PROBE_B_INDEX = `export default function extension(pi: any) {
	pi.registerCommand("probe-b-hello", { handler: async () => "B-hello" });
}
`;

/** 碰撞者：抢注 probe-a 的命令名。 */
const PROBE_COLLIDER_INDEX = `export default function extension(pi: any) {
	pi.registerCommand("probe-a-hello", { handler: async () => "stolen" });
}
`;

const PROBE_BROKEN_INDEX = `export default function extension(_pi: any) {
	throw new Error("boom from probe-broken");
}
`;

let rootDir = "";
let host: DaemonHostContext;
let runtime: CordisDynamicExtensionRuntime;

async function writeExtension(name: string, files: Record<string, string>): Promise<string> {
	const dir = path.join(rootDir, name);
	await fs.mkdir(dir, { recursive: true });
	for (const [file, content] of Object.entries(files)) {
		await fs.writeFile(path.join(dir, file), content);
	}
	return dir;
}

beforeAll(async () => {
	rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-cordis-spike-"));
	await writeExtension("probe-a", {
		"package.json": probeManifest("probe-a"),
		"index.ts": probeAIndex("v1"),
		"helper.ts": PROBE_A_HELPER,
	});
	await writeExtension("probe-b", {
		"package.json": probeManifest("probe-b"),
		"index.ts": PROBE_B_INDEX,
	});
	await writeExtension("probe-collider", {
		"package.json": probeManifest("probe-collider"),
		"index.ts": PROBE_COLLIDER_INDEX,
	});
	await writeExtension("probe-broken", {
		"package.json": probeManifest("probe-broken"),
		"index.ts": PROBE_BROKEN_INDEX,
	});
	host = new DaemonHostContext();
	runtime = new CordisDynamicExtensionRuntime(host);
});

afterAll(async () => {
	await runtime.dispose();
	await host.dispose();
	await fs.rm(rootDir, { recursive: true, force: true });
	await fs.rm(path.join(os.tmpdir(), "musepi-cordis-spike-stage"), { recursive: true, force: true });
});

describe("收编第二刀 宿主级 user 插件 cordis 装载（Loader / 同源 / 隔离 / 生命周期 / reconcile / 检视）", () => {
	test("加载：真实扩展目录 → 命令可调用，检视如实报告 ACTIVE + 效果账本", async () => {
		const handle = await runtime.load(path.join(rootDir, "probe-a"), rootDir);
		expect(await handle.invoke("probe-a-hello", "ping")).toBe("A:ping:v1");

		const entry = runtime.inspect().find(r => r.name === "probe-a");
		expect(entry?.status).toBe("active");
		expect(entry?.fiberState).toBe("ACTIVE");
		expect(entry?.effectLabels).toContain("registerCommand:probe-a-hello");
		expect(entry?.effectLabels).toContain("on:refresh");
		expect(entry?.effectLabels).toContain("registerSetting:probe-a.opt");
		expect(entry?.effectLabels).toContain("registerFlag:probe-a-flag");
		expect(entry?.effectLabels).toContain("registerProvider:probe-provider");
	});

	test("遗留 omp 清单字段仍可读（musepi 权威前的旧上游扩展不掉队）", async () => {
		const localHost = new DaemonHostContext();
		const legacyRuntime = new CordisDynamicExtensionRuntime(localHost);
		const dir = await writeExtension("legacy-omp-manifest", {
			"package.json": JSON.stringify({
				name: "legacy-omp-manifest",
				version: "0.0.0",
				omp: { extensions: ["./index.ts"] },
			}),
			"index.ts": probeAIndex("v1"),
			"helper.ts": PROBE_A_HELPER,
		});
		const handle = await legacyRuntime.load(dir, rootDir);
		expect(await handle.invoke("probe-a-hello", "x")).toBe("A:x:v1");
		expect(legacyRuntime.inspect().find(r => r.name === "legacy-omp-manifest")?.status).toBe("active");
		await legacyRuntime.dispose();
		await localHost.dispose();
	});

	test("隔离·碰撞：重名命令结构化拒绝，先加载者不受影响，FAILED fiber 不留挂载", async () => {
		// 共享 runtime 上 probe-a 已在役（首个用例）；碰撞者抢注其命令名。
		expect(runtime.inspect().find(r => r.name === "probe-a")?.status).toBe("active");
		const error = await runtime.load(path.join(rootDir, "probe-collider"), rootDir).catch(err => err);
		expect(error).toBeInstanceOf(DynamicExtensionLoadError);
		expect((error as DynamicExtensionLoadError).code).toBe("collision");
		expect((error as Error).message).toContain('command "probe-a-hello" is already registered');
		expect((error as Error).message).toContain('"probe-a"');
		expect(runtime.inspect().find(r => r.name === "probe-collider")?.status).toBe("failed");

		// 失败模式若回归（碰撞覆盖静默成功）：后加载者抢走命令、检视无 failed 记录。
		const host2 = new DaemonHostContext();
		const runtime2 = new CordisDynamicExtensionRuntime(host2);
		const dir = await writeExtension("collision-order-a", {
			"package.json": probeManifest("collision-order-a"),
			"index.ts": probeAIndex("v1"),
			"helper.ts": PROBE_A_HELPER,
		});
		const aHandle2 = await runtime2.load(dir, rootDir);
		const colliderError = await runtime2
			.load(path.join(rootDir, "probe-collider"), rootDir)
			.then(() => null)
			.catch(err => err);
		expect(colliderError).toBeInstanceOf(DynamicExtensionLoadError);
		expect(await aHandle2.invoke("probe-a-hello", "y")).toBe("A:y:v1");
		expect(runtime2.inspect().find(r => r.name === "probe-collider")?.status).toBe("failed");
		await runtime2.dispose();
		await host2.dispose();
	});

	test("事件分发：宿主事件送达所有在役订阅扩展，卸载后即退出分发", async () => {
		const host2 = new DaemonHostContext();
		const runtime2 = new CordisDynamicExtensionRuntime(host2);
		const dir = await writeExtension("event-a", {
			"package.json": probeManifest("event-a"),
			"index.ts": probeAIndex("v1"),
			"helper.ts": PROBE_A_HELPER,
		});
		const handle = await runtime2.load(dir, rootDir);
		runtime2.emit("refresh", "ping-1");
		expect(await handle.invoke("probe-a-dump")).toBe("ping-1");

		await handle.unload();
		runtime2.emit("refresh", "ping-2");
		// 卸载后能力缺席（dump 随 extension 集合一并回收）。
		const absent = await handle.invoke("probe-a-dump").catch(err => err);
		expect(absent).toBeInstanceOf(DynamicExtensionLoadError);
		expect((absent as DynamicExtensionLoadError).code).toBe("entry-missing");

		await runtime2.dispose();
		await host2.dispose();
	});

	test("生命周期：unload 反向回收自己的效果——命令摘除、效果账本清空，其他扩展存活", async () => {
		const bHandle = await runtime.load(path.join(rootDir, "probe-b"), rootDir);
		expect(runtime.inspect().find(r => r.name === "probe-a")?.status).toBe("active");

		// 卸载 b：b 的命令缺席、效果账本清空；a 原样存活。
		await bHandle.unload();
		const absent = await bHandle.invoke("probe-b-hello").catch(err => err);
		expect(absent).toBeInstanceOf(DynamicExtensionLoadError);
		expect((absent as DynamicExtensionLoadError).code).toBe("entry-missing");
		expect((absent as Error).message).toContain("capability absent");

		const bEntry = runtime.inspect().find(r => r.name === "probe-b");
		expect(bEntry?.status).toBe("unloaded");
		expect(bEntry?.effectLabels).toEqual([]);

		const a = runtime.inspect().find(r => r.name === "probe-a");
		expect(a?.status).toBe("active");
		expect(a?.effectLabels).toContain("registerCommand:probe-a-hello");
	});

	test("生命周期：loadAll reconcile——清单消失的路径自动卸载且效果回收（provider 排队注册注销）", async () => {
		const host2 = new DaemonHostContext();
		const runtime2 = new CordisDynamicExtensionRuntime(host2);
		const dir = await writeExtension("reconcile-a", {
			"package.json": probeManifest("reconcile-a"),
			"index.ts": probeAIndex("v1"),
			"helper.ts": PROBE_A_HELPER,
		});
		const loaded = await runtime2.loadAll([dir], rootDir);
		expect(loaded.errors).toEqual([]);
		expect(loaded.extensions).toHaveLength(1);
		// registerProvider 进了共享 runtime 的排队注册（session-less RPC 的消费面）。
		expect(
			loaded.runtime.pendingProviderRegistrations.some(registration => registration.name === "probe-provider"),
		).toBe(true);

		// 清单变空 → 对账卸载 → 效果账本反向回收：provider 排队注册随之注销。
		const unloaded = await runtime2.loadAll([], rootDir);
		expect(unloaded.extensions).toHaveLength(0);
		expect(unloaded.runtime.pendingProviderRegistrations).toHaveLength(0);
		expect(runtime2.inspect().find(r => r.name === "reconcile-a")?.status).toBe("unloaded");

		await runtime2.dispose();
		await host2.dispose();
	});

	test("生命周期：reload 拾取入口文件改写的新代码", async () => {
		const host2 = new DaemonHostContext();
		const runtime2 = new CordisDynamicExtensionRuntime(host2);
		const dir = await writeExtension("hmr-probe", {
			"package.json": probeManifest("hmr-probe"),
			"index.ts": probeAIndex("v1"),
			"helper.ts": PROBE_A_HELPER,
		});
		const handle = await runtime2.load(dir, rootDir);
		expect(await handle.invoke("probe-a-hello", "k")).toBe("A:k:v1");

		await fs.writeFile(path.join(dir, "index.ts"), probeAIndex("v2"));
		await handle.reload();
		expect(await handle.invoke("probe-a-hello", "k")).toBe("A:k:v2");
		await runtime2.dispose();
		await host2.dispose();
	});

	test("HMR 实测：reload 经 mtime 标签口径拾取改写——子模块改写同样生效", async () => {
		const host2 = new DaemonHostContext();
		const runtime2 = new CordisDynamicExtensionRuntime(host2);
		const dir = await writeExtension("hmr-submodule-probe", {
			"package.json": probeManifest("hmr-submodule-probe"),
			"index.ts": probeAIndex("v2"),
			"helper.ts": PROBE_A_HELPER,
		});
		const handle = await runtime2.load(dir, rootDir);
		expect(await handle.invoke("probe-a-hello", "k")).toBe("A:k:v2");

		// mtime 标签口径：reload 重新装载时 loader 给入口挂单调 `?mtime=` 查询，
		// 子模块随新图重解析即拾取改写（失败模式若回归为缓存旧实例则仍返回
		// "A:k:v2"）。
		await fs.writeFile(path.join(dir, "helper.ts"), `export function greeting() { return "Z"; }\n`);
		await handle.reload();
		expect(await handle.invoke("probe-a-hello", "k")).toBe("Z:k:v2");
		await runtime2.dispose();
		await host2.dispose();
	});

	test("失败不留挂载：factory 抛错 → 结构化失败，宿主与其余扩展无损", async () => {
		const error = await runtime.load(path.join(rootDir, "probe-broken"), rootDir).catch(err => err);
		expect(error).toBeInstanceOf(DynamicExtensionLoadError);
		expect((error as DynamicExtensionLoadError).code).toBe("factory-threw");
		expect((error as Error).message).toContain("boom from probe-broken");

		const broken = runtime.inspect().find(r => r.name === "probe-broken");
		expect(broken?.status).toBe("failed");
		expect(broken?.error).toContain("boom from probe-broken");
		expect(broken?.fiberState).toBeUndefined();

		// 宿主与在役扩展无损：probe-a 仍 ACTIVE；宿主检视有注册表规模。
		expect(runtime.inspect().find(r => r.name === "probe-a")?.status).toBe("active");
		expect(host.inspect().registrySize).toBeGreaterThan(0);
	});

	test("检视：多扩展并列（状态/fiber 状态机/效果标签/错误归因）", async () => {
		const snapshot = runtime.inspect();
		const names = snapshot.map(r => r.name);
		expect(names).toContain("probe-a");
		expect(names).toContain("probe-b");
		expect(names).toContain("probe-collider");
		expect(names).toContain("probe-broken");

		// probe-a 在役且效果账本职守：每个登记 verb 都留了标签。
		const a = snapshot.find(r => r.name === "probe-a");
		expect(a?.effectLabels.some(label => label.startsWith("registerCommand:"))).toBe(true);
		expect(a?.effectLabels).toContain("on:refresh");
	});
});

describe("组件对齐刀 清单组件子 fiber（dsh `- insert:` 子插件 parity / 独立启停 / 检视）", () => {
	let compsHost: DaemonHostContext;
	let compsRuntime: CordisDynamicExtensionRuntime;
	let compsDir = "";
	let compsHandle: DynamicExtensionHandle;

	function compsManifest(): string {
		return JSON.stringify({
			name: "probe-comps",
			version: "0.0.0",
			musepi: {
				extensions: ["./index.ts"],
				components: [
					{ id: "alpha", description: "Alpha unit", entry: "./alpha.ts" },
					{ id: "beta", description: "Beta unit", entry: "./beta.ts" },
					{ id: "readonly" },
				],
			},
		});
	}

	const COMPS_MAIN = `export default function extension(pi: any) {
	pi.registerCommand("probe-comps-main", { handler: async () => "main" });
}
`;
	const COMPS_ALPHA = `export default function extension(pi: any) {
	pi.registerCommand("probe-comps-alpha", { handler: async () => "alpha" });
}
`;
	const COMPS_BETA_V1 = `export default function extension(pi: any) {
	pi.registerCommand("probe-comps-beta", { handler: async () => "beta-v1" });
}
`;
	const COMPS_BETA_V2 = `export default function extension(pi: any) {
	pi.registerCommand("probe-comps-beta", { handler: async () => "beta-v2" });
}
`;

	beforeAll(async () => {
		compsHost = new DaemonHostContext();
		compsRuntime = new CordisDynamicExtensionRuntime(compsHost);
		compsDir = await writeExtension("probe-comps", {
			"package.json": compsManifest(),
			"index.ts": COMPS_MAIN,
			"alpha.ts": COMPS_ALPHA,
			"beta.ts": COMPS_BETA_V1,
		});
		compsHandle = await compsRuntime.load(compsDir, rootDir);
	});

	afterAll(async () => {
		await compsRuntime.dispose();
		await compsHost.dispose();
	});

	test("组件装载：entry 组件 = 独立子 fiber（独立效果账本/状态机），无 entry 组件如实只读", async () => {
		const handle = compsHandle;
		expect(await handle.invoke("probe-comps-main")).toBe("main");
		expect(await handle.invoke("probe-comps-alpha")).toBe("alpha");
		expect(await handle.invoke("probe-comps-beta")).toBe("beta-v1");

		const entry = compsRuntime.inspect().find(r => r.name === "probe-comps");
		const byId = new Map(entry?.components.map(c => [c.id, c]));
		expect(byId.get("alpha")?.status).toBe("active");
		expect(byId.get("alpha")?.fiberState).toBe("ACTIVE");
		expect(byId.get("alpha")?.effectLabels).toContain("registerCommand:probe-comps-alpha");
		expect(byId.get("beta")?.status).toBe("active");
		// 只读声明组件：不挂 fiber,如实 disabled 且无 fiberState。
		expect(byId.get("readonly")?.status).toBe("disabled");
		expect(byId.get("readonly")?.fiberState).toBeUndefined();
	});

	test("组件独立启停：停用即能力缺席（效果回收），主入口与其余组件无损；启用即重挂", async () => {
		const handle = compsHandle;
		await compsRuntime.setComponentEnabled("probe-comps", "alpha", false);
		const missing = await handle.invoke("probe-comps-alpha").catch(err => err);
		expect(missing).toBeInstanceOf(DynamicExtensionLoadError);
		expect((missing as DynamicExtensionLoadError).code).toBe("entry-missing");
		expect(await handle.invoke("probe-comps-main")).toBe("main");
		expect(await handle.invoke("probe-comps-beta")).toBe("beta-v1");
		expect(
			compsRuntime
				.inspect()
				.find(r => r.name === "probe-comps")
				?.components.find(c => c.id === "alpha")?.status,
		).toBe("disabled");

		await compsRuntime.setComponentEnabled("probe-comps", "alpha", true);
		expect(await handle.invoke("probe-comps-alpha")).toBe("alpha");
	});

	test("禁用集装载：disabledComponents 命中的组件不挂 fiber,其余照常", async () => {
		const localHost = new DaemonHostContext();
		const localRuntime = new CordisDynamicExtensionRuntime(localHost);
		const handle = await localRuntime.load(compsDir, rootDir, new Set(["probe-comps/beta"]));
		const missing = await handle.invoke("probe-comps-beta").catch(err => err);
		expect(missing).toBeInstanceOf(DynamicExtensionLoadError);
		expect(await handle.invoke("probe-comps-alpha")).toBe("alpha");
		expect(
			localRuntime
				.inspect()
				.find(r => r.name === "probe-comps")
				?.components.find(c => c.id === "beta")?.status,
		).toBe("disabled");
		await localRuntime.dispose();
		await localHost.dispose();
	});

	test("组件失败层隔离：单组件抛错只记 FAILED,插件与兄弟组件无损", async () => {
		const dir = await writeExtension("probe-comps-fragile", {
			"package.json": JSON.stringify({
				name: "probe-comps-fragile",
				version: "0.0.0",
				musepi: {
					extensions: ["./index.ts"],
					components: [
						{ id: "good", entry: "./good.ts" },
						{ id: "broken", entry: "./broken.ts" },
					],
				},
			}),
			"index.ts": COMPS_MAIN,
			"good.ts": COMPS_ALPHA,
			"broken.ts": `export default function extension(_pi: any) { throw new Error("boom from component"); }\n`,
		});
		const localHost = new DaemonHostContext();
		const localRuntime = new CordisDynamicExtensionRuntime(localHost);
		const handle = await localRuntime.load(dir, rootDir);
		expect(await handle.invoke("probe-comps-alpha")).toBe("alpha");
		const entry = localRuntime.inspect().find(r => r.name === "probe-comps-fragile");
		expect(entry?.status).toBe("active");
		const broken = entry?.components.find(c => c.id === "broken");
		expect(broken?.status).toBe("failed");
		expect(broken?.error).toContain("boom from component");
		expect(broken?.fiberState).toBeUndefined();
		await localRuntime.dispose();
		await localHost.dispose();
	});

	test("组件 HMR：reload 拾取组件入口改写", async () => {
		const handle = compsHandle;
		await fs.writeFile(path.join(compsDir, "beta.ts"), COMPS_BETA_V2);
		await handle.reload();
		expect(await handle.invoke("probe-comps-beta")).toBe("beta-v2");
	});

	test("组件命令碰撞守卫：组件抢主入口命令名 → 组件 FAILED（插件无损）", async () => {
		const dir = await writeExtension("probe-comps-usurper", {
			"package.json": JSON.stringify({
				name: "probe-comps-usurper",
				version: "0.0.0",
				musepi: {
					extensions: ["./index.ts"],
					components: [{ id: "usurper", entry: "./usurper.ts" }],
				},
			}),
			"index.ts": COMPS_MAIN,
			"usurper.ts": `export default function extension(pi: any) {
	pi.registerCommand("probe-comps-main", { handler: async () => "stolen" });
}
`,
		});
		const localHost = new DaemonHostContext();
		const localRuntime = new CordisDynamicExtensionRuntime(localHost);
		const handle = await localRuntime.load(dir, rootDir);
		expect(await handle.invoke("probe-comps-main")).toBe("main");
		const usurper = localRuntime
			.inspect()
			.find(r => r.name === "probe-comps-usurper")
			?.components.find(c => c.id === "usurper");
		expect(usurper?.status).toBe("failed");
		expect(usurper?.error).toContain("already registered");
		await localRuntime.dispose();
		await localHost.dispose();
	});
});
