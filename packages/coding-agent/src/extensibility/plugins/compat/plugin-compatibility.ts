/**
 * 插件兼容性预检（回退保护②，dsh plugin-compatibility.ts parity）：
 * 在不 import 插件代码的前提下读 package.json `peerDependencies`，对
 * MusePi 命名空间 peer 做 semver 区间校验，不兼容产出结构化
 * PluginCompatibility，由调用方按 code 本地化渲染。
 *
 * 判定语义（与 dsh 的差异如实记录）：
 * - MusePi 平台是**单版本线**（全部 @musepi/* 包随客户端同版本发布），
 *   因此所有 `@musepi/*` peer 都对照宿主运行时版本（pi-utils VERSION，
 *   = @musepi/pi-coding-agent 版本）判定；dsh 只查 `@deepseek-ai/dsh*`。
 * - `workspace:^` / `workspace:~` / `workspace:*` 按运行时版本解析
 *   （与 dsh 同口径）；其余非法/空区间 = 未满足（结构化拒绝，不静默
 *   放行）。Bun 1.4.2 实测 `Bun.semver.satisfies` 对非法区间**返回
 *   true 不抛错**，必须先经 `Bun.semver.order` 校验区间语法。
 * - 预发布运行时（如 0.6.0-rc.1）参与区间判定：satisfies 无
 *   includePrerelease 选项（Bun 1.4.2 实测 `0.5.0-rc.1` 不满足
 *   `^0.5.0`），故预发布版本额外按其 base 版本复检一次——等价 dsh
 *   `includePrerelease: true` 的意图。
 * - 豁免：精确 `name@version` → 被豁免的运行时版本列表（人工登记，
 *   非通配；登记面见 compatibility-store.ts）。命中 = status "exempted"
 *   （放行但如实标注），未命中 = "incompatible"。
 *
 * 契约：compatible = 返回 undefined（未声明 peer / 全部满足）；任何
 * malformed 输入（manifest 非对象、peerDependencies 非对象、range 非
 * 字符串）抛 Error——装配入口 catch 后按 malformed-manifest 结构化
 * 拒绝（dsh 同口径：peer 元数据不可验证 = 拒绝而非静默准入）。
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { VERSION } from "@musepi/pi-utils";
import type { PluginCompatibility } from "@musepi/pi-wire";

/** 参与判定的 peer 命名空间：MusePi 平台包（单版本线）。 */
const MUSEPI_PEER_PREFIX = "@musepi/";

/** 按运行时版本解析的 workspace 协议（与 dsh 同口径）。 */
const WORKSPACE_PROTOCOLS = new Set(["workspace:^", "workspace:~", "workspace:*"]);

function objectOf(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${field} must be an object`);
	}
	return value as Record<string, unknown>;
}

function runtimeVersionOf(value: unknown): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`Invalid MusePi runtime version: ${JSON.stringify(value)}; expected a semantic version`);
	}
	// order 对非法版本抛错——这里兼做运行时版本合法性校验。
	try {
		Bun.semver.order(value, value);
	} catch {
		throw new Error(`Invalid MusePi runtime version: ${JSON.stringify(value)}; expected a semantic version`);
	}
	return value;
}

/** 区间语法校验（Bun.semver.satisfies 对非法区间返回 true 不抛错,
 *  1.4.2 实测裸 "^" 既判 valid 又判满足——必须双重探针：order 不抛 +
 *  区间含数字字面量）。 */
function isValidRange(range: string): boolean {
	if (!/\d/.test(range)) return false;
	try {
		Bun.semver.order("0.0.0", range);
		return true;
	} catch {
		return false;
	}
}

/** 预发布运行时按 base 版本复检（等价 includePrerelease 意图,见头注释）。 */
function satisfiesRuntime(runtimeVersion: string, requirement: string): boolean {
	if (Bun.semver.satisfies(runtimeVersion, requirement)) return true;
	const base = runtimeVersion.split("-")[0] ?? runtimeVersion;
	if (base !== runtimeVersion && Bun.semver.satisfies(base, requirement)) return true;
	return false;
}

/**
 * 校验插件 manifest 的 MusePi peer 区间，不 import 插件代码。
 * @param manifest 解析后的插件 package.json；继承字段忽略。
 * @param exemptions 精确 `name@version` → 被豁免的运行时版本列表。
 * @param runtimeVersion 宿主运行时版本（缺省 pi-utils VERSION）。
 * @returns 未满足的 peer 与豁免判定；全部满足 / 未声明 peer 返回 undefined。
 * @throws manifest/peerDependencies 非对象、range 非字符串、运行时版本非法。
 */
export function evaluatePluginCompatibility(
	manifest: unknown,
	exemptions: Readonly<Record<string, readonly string[]>> = {},
	runtimeVersion: string = VERSION,
): PluginCompatibility | undefined {
	const runtime = runtimeVersionOf(runtimeVersion);
	const fields = objectOf(manifest, "Plugin manifest");
	if (!Object.hasOwn(fields, "peerDependencies")) return undefined;
	const dependencies = objectOf(fields.peerDependencies, "Plugin manifest peerDependencies");
	const unmetPeers: Record<string, string> = {};
	for (const [name, range] of Object.entries(dependencies)) {
		if (typeof range !== "string") {
			throw new Error(`Plugin manifest peerDependencies[${JSON.stringify(name)}] must be a string`);
		}
		if (name !== MUSEPI_PEER_PREFIX.slice(0, -1) && !name.startsWith(MUSEPI_PEER_PREFIX)) continue;
		const requirement = WORKSPACE_PROTOCOLS.has(range) ? runtime : range;
		if (requirement.trim() === "" || !isValidRange(requirement) || !satisfiesRuntime(runtime, requirement)) {
			unmetPeers[name] = range;
		}
	}
	if (Object.keys(unmetPeers).length === 0) return undefined;
	// 命中未满足 peer 才需要身份字段做豁免键；身份缺失 = malformed-manifest
	// （结构化拒绝,不抛——dsh 在这里 throw,我方按设计稿 CompatibilityGate
	//  的 code 面落地,调用方一处渲染）。
	const name = typeof fields.name === "string" ? fields.name : "";
	const version = typeof fields.version === "string" ? fields.version : "";
	const code: PluginCompatibility["code"] = name === "" || version === "" ? "malformed-manifest" : "incompatible-peer";
	const exemptedVersions = Object.hasOwn(exemptions, `${name}@${version}`)
		? exemptions[`${name}@${version}`]
		: undefined;
	const exempted = code === "malformed-manifest" ? false : exemptedVersions?.includes(runtime) === true;
	return {
		status: exempted ? "exempted" : "incompatible",
		code,
		plugin: { name, version },
		runtimeVersion: runtime,
		unmetPeers,
	};
}

/** 结构化判定的英文诊断（日志/errors 通道;GUI 按 code 自行本地化）。 */
export function pluginCompatibilityWarning(issue: PluginCompatibility): string {
	const key = `${issue.plugin.name}@${issue.plugin.version}`;
	return (
		`Plugin ${key} is incompatible with MusePi ${issue.runtimeVersion}: ` +
		`peerDependencies ${JSON.stringify(issue.unmetPeers)}. ` +
		"Running it may cause crashes or data loss. " +
		"Update the plugin or grant an exact-version exemption in compatibility.json, then retry."
	);
}

/** 从扩展路径向上查找 package.json 的最大层级（与 plugin-manifest 同口径）。 */
const MAX_MANIFEST_DEPTH = 4;

/** malformed 判定物化：peer 元数据不可验证 = 结构化拒绝（dsh 同口径）。 */
function malformedGate(name: string, version: string, runtimeVersion: string, detail: string): PluginCompatibility {
	return {
		status: "incompatible",
		code: "malformed-manifest",
		plugin: { name, version },
		runtimeVersion,
		unmetPeers: {},
		detail,
	};
}

/**
 * 路径级预检（会话装配入口用）：从扩展路径（文件或目录）向上 ≤4 层找最近
 * 的 package.json 做判定；找不到清单 = 无可判定内容（undefined，交给
 * Loader 自己的 import 诊断——dsh「只有兼容性冲突拒绝一行」parity）。
 */
export async function compatibilityGateForExtensionPath(
	extPath: string,
	exemptions: Readonly<Record<string, readonly string[]>> = {},
	runtimeVersion: string = VERSION,
): Promise<PluginCompatibility | undefined> {
	const runtime = runtimeVersionOf(runtimeVersion);
	let dir = path.resolve(extPath);
	try {
		if ((await fs.stat(dir)).isFile()) dir = path.dirname(dir);
	} catch {
		/* 路径不存在交给 Loader 诊断 */
	}
	for (let depth = 0; depth < MAX_MANIFEST_DEPTH; depth++) {
		const pkgPath = path.join(dir, "package.json");
		let manifest: unknown;
		try {
			manifest = JSON.parse(await fs.readFile(pkgPath, "utf8"));
		} catch {
			/* 向上继续 */
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
			continue;
		}
		try {
			return evaluatePluginCompatibility(manifest, exemptions, runtime);
		} catch (error) {
			const fields = typeof manifest === "object" && manifest !== null ? (manifest as Record<string, unknown>) : {};
			return malformedGate(
				typeof fields.name === "string" ? fields.name : path.basename(extPath),
				typeof fields.version === "string" ? fields.version : "",
				runtime,
				error instanceof Error ? error.message : String(error),
			);
		}
	}
	return undefined;
}
