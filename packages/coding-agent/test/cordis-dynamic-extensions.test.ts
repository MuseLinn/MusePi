/**
 * M2-2.9 spike ①（动态插件运行时）四能力契约测试。
 *
 * 钉死的契约（消费者 = 试点报告与后续收编决策）：
 *  1. 加载：真实扩展目录（package.json musepi.extensions 入口，musepi 为权威
 *     清单字段）→ 命令可调用，
 *     检视如实报告 ACTIVE + 效果账本标签（command/on/interval 三面）；
 *  2. 隔离：跨扩展重名命令 = 结构化碰撞拒绝（教学式文案带归属），后加载者
 *     FAILED 且不留半挂载 fiber，先加载者登记不受影响；
 *  3. 生命周期：unload = fiber.dispose() 反向回收——interval 停止、命令从
 *     全局注册表摘除、其他扩展的登记与回调原样存活；reload 拾取入口文件
 *     改写的新代码；
 *  4. 检视：多扩展并列（状态/fiber 状态机/效果标签/探针日志 tail/错误归因）；
 *  5. 失败不留挂载：factory 抛错 → 结构化失败记录，宿主 Context 与其余扩展
 *     无损；
 *  6. HMR 实测口径：Bun 1.4.2（Windows）下裸查询串与 Bun.plugin onLoad
 *     均不能可靠击穿同进程模块缓存（探针实测）；可靠口径 = 整包暂存复制
 *     （新绝对路径 = 新缓存键），入口与子模块改写均在 reload 时拾取；
 *     watch 触发粒度契约（AGENTS.md：入口 mtime）不变。
 *
 * 测试纪律（ADR 边界 3）：真 cordis Context（DaemonHostContext），不 mock。
 * fixture 扩展在临时目录程序化生成（含子模块 helper），不写仓库工作区。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CordisDynamicExtensionRuntime, DynamicExtensionLoadError } from "../src/daemon/cordis-dynamic-extensions";
import { DaemonHostContext } from "../src/daemon/host-context";

/** 探针扩展共用的窄 API 形状（与 cordis-dynamic-extensions.ts 的接口对齐）。 */
const PROBE_API_TS = `interface ProbeApi {
	readonly extensionName: string;
	emitProbe(line: string): void;
	registerCommand(name: string, handler: (...args: string[]) => unknown): void;
	on(event: string, handler: (...args: unknown[]) => unknown): void;
	setInterval(handler: () => void, ms: number): void;
}
`;

function probeManifest(name: string): string {
	return JSON.stringify({ name, version: "0.0.0", musepi: { extensions: ["./index.ts"] } });
}

/** probe-a：命令 + 事件订阅 + 周期回调三个贡献面；版本字面量与 greeting 分处
 *  入口/子模块，分别支撑入口改写拾取与子模块不拾取两个 HMR 实测。 */
function probeAIndex(version: string): string {
	return `${PROBE_API_TS}
import { greeting } from "./helper";
export default function extension(pi: ProbeApi) {
	pi.registerCommand("probe-a-hello", () => \`\${greeting()}:${version}\`);
	pi.on("refresh", () => { pi.emitProbe("refreshed"); });
	pi.setInterval(() => { pi.emitProbe("tick"); }, 5);
}
`;
}

const PROBE_A_HELPER = `export function greeting() { return "A"; }
`;

const PROBE_B_INDEX = `${PROBE_API_TS}
export default function extension(pi: ProbeApi) {
	pi.registerCommand("probe-b-hello", () => "B-hello");
	pi.setInterval(() => { pi.emitProbe("b-tick"); }, 5);
}
`;

/** 碰撞者：抢注 probe-a 的命令名。 */
const PROBE_COLLIDER_INDEX = `${PROBE_API_TS}
export default function extension(pi: ProbeApi) {
	pi.registerCommand("probe-a-hello", () => "stolen");
}
`;

const PROBE_BROKEN_INDEX = `${PROBE_API_TS}
export default function extension(_pi: ProbeApi) {
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

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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

describe("spike ① 动态插件运行时（Loader / 隔离 / 生命周期 / 检视）", () => {
	test("加载：真实扩展目录 → 命令可调用，检视如实报告 ACTIVE + 效果账本", async () => {
		const handle = await runtime.load(path.join(rootDir, "probe-a"));
		expect(await handle.invoke("probe-a-hello")).toBe("A:v1");

		const entry = runtime.inspect().find(r => r.name === "probe-a");
		expect(entry?.status).toBe("active");
		expect(entry?.fiberState).toBe("ACTIVE");
		expect(entry?.effectLabels).toContain("command:probe-a-hello");
		expect(entry?.effectLabels).toContain("on:refresh");
		expect(entry?.effectLabels).toContain("interval:5ms");
	});

	test("遗留 omp 清单字段仍可读（musepi 权威前的旧上游扩展不掉队）", async () => {
		const host = new DaemonHostContext();
		const legacyRuntime = new CordisDynamicExtensionRuntime(host);
		const dir = await writeExtension("legacy-omp-manifest", {
			"package.json": JSON.stringify({
				name: "legacy-omp-manifest",
				version: "0.0.0",
				omp: { extensions: ["./index.ts"] },
			}),
			"index.ts": probeAIndex("v1"),
			"helper.ts": PROBE_A_HELPER,
		});
		const handle = await legacyRuntime.load(dir);
		expect(await handle.invoke("probe-a-hello")).toBe("A:v1");
		expect(legacyRuntime.inspect().find(r => r.name === "legacy-omp-manifest")?.status).toBe("active");
		await legacyRuntime.dispose();
		await host.dispose();
	});

	test("隔离·碰撞：重名命令结构化拒绝，先加载者不受影响，FAILED fiber 不留挂载", async () => {
		// 共享 runtime 上 probe-a 已在役（首个用例）；碰撞者抢注其命令名。
		expect(runtime.inspect().find(r => r.name === "probe-a")?.status).toBe("active");
		const error = await runtime.load(path.join(rootDir, "probe-collider")).catch(err => err);
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
		const aHandle2 = await runtime2.load(dir);
		const colliderError = await runtime2
			.load(path.join(rootDir, "probe-collider"))
			.then(() => null)
			.catch(err => err);
		expect(colliderError).toBeInstanceOf(DynamicExtensionLoadError);
		expect(await aHandle2.invoke("probe-a-hello")).toBe("A:v1");
		expect(runtime2.inspect().find(r => r.name === "probe-collider")?.status).toBe("failed");
		await runtime2.dispose();
		await host2.dispose();
	});

	test("生命周期：unload 反向回收自己的效果——interval 停止、命令摘除、其他扩展存活", async () => {
		const bHandle = await runtime.load(path.join(rootDir, "probe-b"));
		expect(runtime.inspect().find(r => r.name === "probe-a")?.status).toBe("active");

		// 事件分发给所有订阅者：probe-a 订阅了 refresh。
		runtime.emit("refresh");
		await sleep(20);
		expect(runtime.inspect().find(r => r.name === "probe-a")?.probeLogTail).toContain("refreshed");

		// 卸载 b：b 的 interval 停、命令缺席；a 原样存活。
		await bHandle.unload();
		const bTicksAfterUnload = bHandle.getProbeLog().length;
		await sleep(60);
		expect(bHandle.getProbeLog().length).toBe(bTicksAfterUnload);

		const absent = await bHandle.invoke("probe-b-hello").catch(err => err);
		expect(absent).toBeInstanceOf(DynamicExtensionLoadError);
		expect((absent as DynamicExtensionLoadError).code).toBe("entry-missing");
		expect((absent as Error).message).toContain("capability absent");

		const bEntry = runtime.inspect().find(r => r.name === "probe-b");
		expect(bEntry?.status).toBe("unloaded");
		expect(bEntry?.effectLabels).toEqual([]);
	});

	test("生命周期：reload 拾取入口文件改写的新代码", async () => {
		// 复用独立运行时，避免与共享 runtime 的顺序耦合。
		const host2 = new DaemonHostContext();
		const runtime2 = new CordisDynamicExtensionRuntime(host2);
		const dir = await writeExtension("hmr-probe", {
			"package.json": probeManifest("hmr-probe"),
			"index.ts": probeAIndex("v1"),
			"helper.ts": PROBE_A_HELPER,
		});
		const handle = await runtime2.load(dir);
		expect(await handle.invoke("probe-a-hello")).toBe("A:v1");

		await fs.writeFile(path.join(dir, "index.ts"), probeAIndex("v2"));
		await handle.reload();
		expect(await handle.invoke("probe-a-hello")).toBe("A:v2");
		await runtime2.dispose();
		await host2.dispose();
	});

	test("HMR 实测：reload 经整包暂存复制拾取改写——子模块改写同样生效", async () => {
		const host2 = new DaemonHostContext();
		const runtime2 = new CordisDynamicExtensionRuntime(host2);
		const dir = await writeExtension("hmr-submodule-probe", {
			"package.json": probeManifest("hmr-submodule-probe"),
			"index.ts": probeAIndex("v2"),
			"helper.ts": PROBE_A_HELPER,
		});
		const handle = await runtime2.load(dir);
		expect(await handle.invoke("probe-a-hello")).toBe("A:v2");

		// 整包暂存复制口径：子模块也是新 specifier，改写即拾取（优于旧入口
		// mtime 粒度——失败模式若回归为缓存旧实例则仍返回 "A:v2"）。
		await fs.writeFile(path.join(dir, "helper.ts"), `export function greeting() { return "Z"; }\n`);
		await handle.reload();
		expect(await handle.invoke("probe-a-hello")).toBe("Z:v2");
		await runtime2.dispose();
		await host2.dispose();
	});

	test("失败不留挂载：factory 抛错 → 结构化失败，宿主与其余扩展无损", async () => {
		const error = await runtime.load(path.join(rootDir, "probe-broken")).catch(err => err);
		expect(error).toBeInstanceOf(DynamicExtensionLoadError);
		expect((error as DynamicExtensionLoadError).code).toBe("factory-threw");
		expect((error as Error).message).toContain("boom from probe-broken");

		const broken = runtime.inspect().find(r => r.name === "probe-broken");
		expect(broken?.status).toBe("failed");
		expect(broken?.error).toContain("boom from probe-broken");
		expect(broken?.fiberState).toBeUndefined();

		// 宿主与在役扩展无损：probe-a 仍 ACTIVE、可调用；宿主检视有注册表规模。
		expect(runtime.inspect().find(r => r.name === "probe-a")?.status).toBe("active");
		expect(host.inspect().registrySize).toBeGreaterThan(0);
	});

	test("检视：多扩展并列 + 探针日志 tail 如实", async () => {
		const snapshot = runtime.inspect();
		const names = snapshot.map(r => r.name);
		expect(names).toContain("probe-a");
		expect(names).toContain("probe-b");
		expect(names).toContain("probe-collider");
		expect(names).toContain("probe-broken");

		// probe-a 的 interval 仍在跑：tail 里有 tick。
		const a = snapshot.find(r => r.name === "probe-a");
		expect(a?.probeLogTail.some(line => line === "tick")).toBe(true);
	});
});
