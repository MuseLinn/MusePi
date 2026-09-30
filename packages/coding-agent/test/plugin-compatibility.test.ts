/**
 * 回退保护② · 兼容性预检纯函数契约（plugin-compatibility.ts +
 * compatibility-store.ts）：
 *
 * Why this exists: 三个装配入口（宿主 runtime / 会话 loader / marketplace
 *  安装）共用同一判定——判定撒谎的回归路径：
 *  - Bun 1.4.2 `Bun.semver.satisfies` 对非法区间**返回 true 不抛错**，
 *    若跳过区间语法探针，"垃圾区间"会被静默放行；
 *  - 预发布运行时（0.6.0-rc.1）无 includePrerelease 选项，少了 base 版本
 *    复检会把满足 ^0.6.0 的插件误拒；
 *  - 豁免未命中/命中渲染错状态，GUI 归因段与下次装配行为分裂。
 *
 * A regression means: a plugin with a garbage peer range loads, a
 * prerelease-compatible plugin is refused, or an exemption mis-reports.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { VERSION } from "@musepi/pi-utils";
import {
	isExactPluginVersion,
	readCompatibilityExemptions,
	resolveCompatibilityPath,
	setVersionExemption,
	validateVersionExemption,
} from "../src/extensibility/plugins/compatibility-store";
import {
	compatibilityGateForExtensionPath,
	evaluatePluginCompatibility,
	pluginCompatibilityWarning,
} from "../src/extensibility/plugins/plugin-compatibility";

const RUNTIME = "0.6.0";

describe("evaluatePluginCompatibility（纯判定）", () => {
	it("未声明 peerDependencies / 空 peer / 全部满足 → undefined（兼容）", () => {
		expect(evaluatePluginCompatibility({ name: "p", version: "1.0.0" }, {}, RUNTIME)).toBeUndefined();
		expect(
			evaluatePluginCompatibility({ name: "p", version: "1.0.0", peerDependencies: {} }, {}, RUNTIME),
		).toBeUndefined();
		expect(
			evaluatePluginCompatibility(
				{ name: "p", version: "1.0.0", peerDependencies: { "@musepi/pi-coding-agent": "^0.6.0" } },
				{},
				RUNTIME,
			),
		).toBeUndefined();
	});

	it("非 @musepi 命名空间 peer 不参与判定（平台单版本线语义）", () => {
		expect(
			evaluatePluginCompatibility(
				{ name: "p", version: "1.0.0", peerDependencies: { "some-other-pkg": "^99.0.0" } },
				{},
				RUNTIME,
			),
		).toBeUndefined();
	});

	it("未满足 peer 记 unmetPeers + incompatible-peer；豁免命中转 exempted", () => {
		const manifest = {
			name: "legacy-plugin",
			version: "2.3.4",
			peerDependencies: { "@musepi/pi-coding-agent": "^99.0.0" },
		};
		const gate = evaluatePluginCompatibility(manifest, {}, RUNTIME);
		expect(gate?.status).toBe("incompatible");
		expect(gate?.code).toBe("incompatible-peer");
		expect(gate?.plugin).toEqual({ name: "legacy-plugin", version: "2.3.4" });
		expect(gate?.runtimeVersion).toBe(RUNTIME);
		expect(gate?.unmetPeers).toEqual({ "@musepi/pi-coding-agent": "^99.0.0" });

		const exempted = evaluatePluginCompatibility(manifest, { "legacy-plugin@2.3.4": [RUNTIME] }, RUNTIME);
		expect(exempted?.status).toBe("exempted");
		// 未命中（别的版本 / 别的运行时）仍 incompatible。
		expect(evaluatePluginCompatibility(manifest, { "legacy-plugin@2.3.4": ["0.5.0"] }, RUNTIME)?.status).toBe(
			"incompatible",
		);
		expect(evaluatePluginCompatibility(manifest, { "legacy-plugin@9.9.9": [RUNTIME] }, RUNTIME)?.status).toBe(
			"incompatible",
		);
	});

	it("workspace:^/~/* 按运行时版本解析（与 dsh 同口径）", () => {
		for (const range of ["workspace:^", "workspace:~", "workspace:*"]) {
			expect(
				evaluatePluginCompatibility(
					{ name: "p", version: "1.0.0", peerDependencies: { "@musepi/pi-utils": range } },
					{},
					RUNTIME,
				),
			).toBeUndefined();
		}
	});

	it("非法/空区间 = 未满足（satisfies 对垃圾区间返回 true 的防护）", () => {
		for (const range of ["", "   ", "garbage", "^", ">=", "1.2.x.y"]) {
			const gate = evaluatePluginCompatibility(
				{ name: "p", version: "1.0.0", peerDependencies: { "@musepi/pi-coding-agent": range } },
				{},
				RUNTIME,
			);
			expect(gate?.status, `range ${JSON.stringify(range)}`).toBe("incompatible");
			expect(gate?.unmetPeers["@musepi/pi-coding-agent"]).toBe(range);
		}
	});

	it("预发布运行时按 base 版本复检（等价 includePrerelease 意图）", () => {
		// 0.6.0-rc.1 满足 ^0.6.0（base 复检），不满足 ^0.5.0。
		expect(
			evaluatePluginCompatibility(
				{ name: "p", version: "1.0.0", peerDependencies: { "@musepi/pi-coding-agent": "^0.6.0" } },
				{},
				"0.6.0-rc.1",
			),
		).toBeUndefined();
		const gate = evaluatePluginCompatibility(
			{ name: "p", version: "1.0.0", peerDependencies: { "@musepi/pi-coding-agent": "^0.5.0" } },
			{},
			"0.6.0-rc.1",
		);
		expect(gate?.status).toBe("incompatible");
	});

	it("malformed 输入抛错：manifest/peerDependencies 非对象、range 非字符串", () => {
		expect(() => evaluatePluginCompatibility(null, {}, RUNTIME)).toThrow("must be an object");
		expect(() => evaluatePluginCompatibility("x", {}, RUNTIME)).toThrow("must be an object");
		expect(() => evaluatePluginCompatibility({ name: "p", version: "1", peerDependencies: [] }, {}, RUNTIME)).toThrow(
			"peerDependencies",
		);
		expect(() =>
			evaluatePluginCompatibility({ name: "p", version: "1", peerDependencies: { "@musepi/x": 42 } }, {}, RUNTIME),
		).toThrow("must be a string");
		// 运行时版本非法也抛（装配入口不该对非法宿主静默放行）。
		expect(() => evaluatePluginCompatibility({ name: "p", version: "1" }, {}, "not-a-version")).toThrow(
			"Invalid MusePi runtime version",
		);
	});

	it("未满足 peer 但身份字段缺失 → malformed-manifest（不抛、结构化拒绝）", () => {
		const gate = evaluatePluginCompatibility(
			{ version: "1.0.0", peerDependencies: { "@musepi/pi-coding-agent": "^99.0.0" } },
			{},
			RUNTIME,
		);
		expect(gate?.code).toBe("malformed-manifest");
		expect(gate?.status).toBe("incompatible");
		// 豁免对 malformed 不生效（身份不可信，dsh 同口径）。
		const exempted = evaluatePluginCompatibility(
			{ version: "1.0.0", peerDependencies: { "@musepi/pi-coding-agent": "^99.0.0" } },
			{ "@1.0.0": [RUNTIME] },
			RUNTIME,
		);
		expect(exempted?.status).toBe("incompatible");
	});

	it("pluginCompatibilityWarning 输出含身份/版本/诊断（errors 通道证据面）", () => {
		const gate = evaluatePluginCompatibility(
			{ name: "p", version: "1.0.0", peerDependencies: { "@musepi/pi-coding-agent": "^99.0.0" } },
			{},
			RUNTIME,
		);
		const text = pluginCompatibilityWarning(gate!);
		expect(text).toContain("p@1.0.0");
		expect(text).toContain(`MusePi ${RUNTIME}`);
		expect(text).toContain("^99.0.0");
	});
});

describe("compatibilityGateForExtensionPath（路径级）", () => {
	let dir: string;
	beforeAll(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "compat-gate-"));
	});
	afterAll(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("入口文件向上找到清单并判定（文件输入先取 dirname）", async () => {
		const plugin = path.join(dir, "unmet");
		fs.mkdirSync(plugin, { recursive: true });
		fs.writeFileSync(
			path.join(plugin, "package.json"),
			JSON.stringify({
				name: "unmet",
				version: "1.0.0",
				peerDependencies: { "@musepi/pi-coding-agent": "^99.0.0" },
			}),
		);
		fs.writeFileSync(path.join(plugin, "index.ts"), "export default function () {}\n");
		const gate = await compatibilityGateForExtensionPath(path.join(plugin, "index.ts"), {}, RUNTIME);
		expect(gate?.code).toBe("incompatible-peer");
		expect(gate?.plugin).toEqual({ name: "unmet", version: "1.0.0" });
	});

	it("找不到清单（≤4 层）→ undefined，交给 Loader 自己的诊断", async () => {
		const orphan = path.join(dir, "no-manifest-here");
		fs.mkdirSync(orphan, { recursive: true });
		expect(await compatibilityGateForExtensionPath(orphan, {}, RUNTIME)).toBeUndefined();
	});

	it("peerDependencies 形态非法 → malformed-manifest 物化（不抛）", async () => {
		const bad = path.join(dir, "malformed");
		fs.mkdirSync(bad, { recursive: true });
		fs.writeFileSync(
			path.join(bad, "package.json"),
			JSON.stringify({ name: "bad", version: "1.0.0", peerDependencies: ["not-an-object"] }),
		);
		const gate = await compatibilityGateForExtensionPath(bad, {}, RUNTIME);
		expect(gate?.code).toBe("malformed-manifest");
		expect(gate?.status).toBe("incompatible");
		expect(gate?.plugin.name).toBe("bad");
		expect(gate?.detail).toBeTruthy();
	});
});

describe("compatibility-store（豁免登记面）", () => {
	it("isExactPluginVersion：精确 semver 双探针", () => {
		for (const ok of ["1.2.3", "0.0.0", "1.2.3-rc.1", "1.2.3+build.5"]) expect(isExactPluginVersion(ok)).toBe(true);
		for (const bad of ["^1.2.3", "~1.2.3", "1.2", "v1.2.3", "1.02.3", "1.2.3 ", "latest", "*"]) {
			expect(isExactPluginVersion(bad)).toBe(false);
		}
	});

	it("validateVersionExemption：身份必须 canonical（scope 名的 @ 保留）", () => {
		expect(() => validateVersionExemption("@musepi/p@1.2.3", "0.5.1")).not.toThrow();
		expect(() => validateVersionExemption("@1.2.3", "0.5.1")).toThrow();
		expect(() => validateVersionExemption("p@^1.2.3", "0.5.1")).toThrow();
		expect(() => validateVersionExemption("p@1.2.3", "^0.5.1")).toThrow();
	});

	it("读取 fail-safe：缺失 = 零豁免可重写；坏 JSON = 零豁免不可重写", () => {
		const missing = path.join(storeDir, "does-not-exist.json");
		const empty = readCompatibilityExemptions(missing);
		expect(empty).toEqual({ exemptions: {}, warnings: [], rewritable: true });

		const broken = path.join(storeDir, "broken.json");
		fs.writeFileSync(broken, "{not json");
		const state = readCompatibilityExemptions(broken);
		expect(state.exemptions).toEqual({});
		expect(state.warnings.length).toBeGreaterThan(0);
		expect(state.rewritable).toBe(false);
	});

	it("逐条校验：坏记录跳过 + 警告，好记录照常生效，含坏记录时拒绝重写", () => {
		const mixed = path.join(storeDir, "mixed.json");
		fs.writeFileSync(
			mixed,
			JSON.stringify({
				"good@1.0.0": [RUNTIME],
				"bad-key": [RUNTIME],
				"good2@2.0.0": "not-a-list",
			}),
		);
		const state = readCompatibilityExemptions(mixed);
		expect(state.exemptions).toEqual({ "good@1.0.0": [RUNTIME] });
		expect(state.warnings.length).toBe(2);
		expect(state.rewritable).toBe(false);
	});

	let storeDir: string;
	let storePath: string;
	beforeAll(() => {
		storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "compat-store-"));
		storePath = resolveCompatibilityPath(storeDir);
	});
	afterAll(() => {
		fs.rmSync(storeDir, { recursive: true, force: true });
	});

	it("授予需 acceptRisk 显式同意，且只能批当前运行时版本", async () => {
		await expect(setVersionExemption(storePath, "p@1.0.0", VERSION, true, false)).rejects.toThrow("acceptRisk");
		await expect(setVersionExemption(storePath, "p@1.0.0", "0.0.1", true, true)).rejects.toThrow(
			"this application runs MusePi",
		);
		// 未写入任何内容。
		expect(readCompatibilityExemptions(storePath).exemptions).toEqual({});
	});

	it("授予 → 落盘且精确配对；撤销 → 键移除", async () => {
		await setVersionExemption(storePath, "p@1.0.0", VERSION, true, true);
		let state = readCompatibilityExemptions(storePath);
		expect(state.exemptions).toEqual({ "p@1.0.0": [VERSION] });

		// 重复授予同版本不重复记录。
		await setVersionExemption(storePath, "p@1.0.0", VERSION, true, true);
		state = readCompatibilityExemptions(storePath);
		expect(state.exemptions["p@1.0.0"]).toEqual([VERSION]);

		await setVersionExemption(storePath, "p@1.0.0", VERSION, false, false);
		state = readCompatibilityExemptions(storePath);
		expect(state.exemptions).toEqual({});
	});

	it("文件含被拒记录时拒绝重写（保护用户手工内容）", async () => {
		const guarded = path.join(storeDir, "guarded.json");
		fs.writeFileSync(guarded, "{not json");
		await expect(setVersionExemption(guarded, "p@1.0.0", VERSION, true, true)).rejects.toThrow("must be repaired");
		expect(fs.readFileSync(guarded, "utf8")).toBe("{not json");
	});
});
