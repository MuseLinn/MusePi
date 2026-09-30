/**
 * 兼容性豁免清单的登记面（回退保护②，dsh profile-compatibility.ts
 * parity）：`<agentDir>/compatibility.json`，**用户可编辑**（§8.3 拍板
 * 结论——随 dsh 同款设计：人工登记的精确版本豁免，天然是「知情的风险
 * 接受」，必须由用户显式授予而非随包预置），但读写两侧都做严格校验：
 *
 * - 键 = 精确 `name@version`（npm 包名 + 精确 semver，禁区间/通配/
 *   空白），值 = 被豁免的**运行时精确版本**列表——精确配对，一次豁免
 *   只放行一个插件版本在一个运行时版本上；
 * - 读取 fail-safe：文件缺失/不可读/非 JSON = 零豁免 + warnings，**永不
 *   因坏文件阻塞装配**（dsh 同口径：坏文件授权不了任何东西，但也挡不
 *   住宿主启动）；逐条校验，坏记录跳过、好记录照常生效；
 * - 授予必须 `acceptRisk: true` 显式知情同意（插件不兼容可能崩溃或丢
 *   数据），且只能授予**当前**运行时版本（dsh 同口径：不能用旧版本
 *   的豁免书批准当前运行）；文件含被拒记录时拒绝重写（保护用户手工
 *   内容，须先手工修复）；
 * - 原子写（临时文件 + rename），权限 600（Windows 忽略 chmod 失败）。
 *
 * Bun 1.4.2 无 `Bun.semver.parse`（实测只有 satisfies/order），精确版本
 * 的 canonical 校验用「严格正则 + order 自比较」双探针，语义对齐 dsh 的
 * `isExactPluginVersion`。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, logger, VERSION } from "@musepi/pi-utils";

/** 兼容性豁免文件名（agentDir 直下，与 mcp.json 同级）。 */
export const COMPATIBILITY_FILENAME = "compatibility.json";

/** npm 包名（含 scope）的合法形态，同 npm manifest 依赖键的接受面。 */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/** 精确 semver（禁区间/前缀/v 头/前导零/空白；预发布与 build 元数据允许）。 */
const EXACT_VERSION =
	/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** 豁免清单的默认落点（agentDir = ~/.musepi/agent 或 PI_CODING_AGENT_DIR；
 *  命名 profile 时为 profiles/<name>/agent——与 dsh「profile 本地豁免」parity，
 *  且随 setAgentDir 重定向，测试隔离免费获得）。 */
export function resolveCompatibilityPath(dir: string = getAgentDir()): string {
	return path.join(dir, COMPATIBILITY_FILENAME);
}

/** 是否 canonical 精确版本：严格 regex + order 自比较双探针（Bun 无
 *  semver.parse；regex 挡前导零/空白等 order 会放行的非 canonical 形态，
 *  1.4.2 实测 order("1.02.3","1.02.3") 返回 0 不抛错）。 */
export function isExactPluginVersion(value: string): boolean {
	if (!EXACT_VERSION.test(value)) return false;
	try {
		return Bun.semver.order(value, value) === 0;
	} catch {
		return false;
	}
}

/**
 * 校验一条豁免的身份字段（不授予）。@ 分隔取最后一个（scope 包名的 @ 保留）。
 * @throws 身份非 canonical 时。
 */
export function validateVersionExemption(packageVersion: string, runtimeVersion: string): void {
	const separator = packageVersion.lastIndexOf("@");
	if (
		separator <= 0 ||
		!PACKAGE_NAME.test(packageVersion.slice(0, separator)) ||
		!isExactPluginVersion(packageVersion.slice(separator + 1)) ||
		!isExactPluginVersion(runtimeVersion)
	) {
		throw new Error("Version exemptions require an exact npm package-name@version and an exact runtime version");
	}
}

/** 一次读取的结果：接受的豁免 + 全部问题（坏文件/坏记录的证据面）。 */
export interface CompatibilityExemptions {
	/** 接受的精确 name@version 键 → 允许的运行时版本列表。 */
	readonly exemptions: Record<string, string[]>;
	/** 人类可读问题；全接受时为空。 */
	readonly warnings: string[];
	/** 文件是否不含任何被拒内容（授予/撤销可安全重写）。 */
	readonly rewritable: boolean;
}

/**
 * fail-safe 读取豁免清单（不 import 插件、不装载任何运行时）。
 * 缺失文件 = 零豁免；不可读/非 JSON = 零豁免 + warning；逐条校验，
 * 坏记录跳过并记录，好记录照常生效。
 */
export function readCompatibilityExemptions(exemptionsPath: string): CompatibilityExemptions {
	const unreadable = (reason: string): CompatibilityExemptions => ({
		exemptions: {},
		warnings: [`${exemptionsPath} ${reason}; treating as having no exemptions`],
		rewritable: false,
	});
	let text: string;
	try {
		text = fs.readFileSync(exemptionsPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exemptions: {}, warnings: [], rewritable: true };
		return unreadable(`cannot be read (${String(error)})`);
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return unreadable(`is not valid JSON (${String(error)})`);
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return unreadable("must map exact package-name@version keys to runtime version lists");
	}
	const exemptions: Record<string, string[]> = {};
	const warnings: string[] = [];
	for (const [key, versions] of Object.entries(value as Record<string, unknown>)) {
		const separator = key.lastIndexOf("@");
		if (
			separator <= 0 ||
			!PACKAGE_NAME.test(key.slice(0, separator)) ||
			!isExactPluginVersion(key.slice(separator + 1))
		) {
			warnings.push(`${exemptionsPath}: ${JSON.stringify(key)} is not an exact package-name@version key; ignored`);
			continue;
		}
		if (!Array.isArray(versions) || !versions.every(v => typeof v === "string" && isExactPluginVersion(v))) {
			warnings.push(`${exemptionsPath}: ${key} must contain a list of exact runtime versions; ignored`);
			continue;
		}
		exemptions[key] = versions as string[];
	}
	return { exemptions, warnings, rewritable: warnings.length === 0 };
}

/**
 * 授予或撤销一条精确版本豁免（原子写）。
 * @param enabled true = 授予（需 acceptRisk 且 runtimeVersion 必须等于
 *   当前运行时）；false = 撤销（可指历史运行时版本）。
 * @throws 身份非法、授予缺知情同意、授予非当前运行时版本、文件含被拒
 *   记录（须用户手工修复，拒绝重写覆盖）。
 */
export async function setVersionExemption(
	exemptionsPath: string,
	packageVersion: string,
	runtimeVersion: string,
	enabled: boolean,
	acceptRisk: boolean,
): Promise<void> {
	validateVersionExemption(packageVersion, runtimeVersion);
	if (enabled && !acceptRisk) {
		throw new Error(
			"Incompatible plugins may cause crashes or data loss. To grant this exact-version exemption, explicitly acknowledge the risk with acceptRisk: true.",
		);
	}
	const runtimeNow = VERSION;
	if (enabled && runtimeVersion !== runtimeNow) {
		throw new Error(`Cannot approve MusePi ${runtimeVersion}: this application runs MusePi ${runtimeNow}.`);
	}
	const state = readCompatibilityExemptions(exemptionsPath);
	if (!state.rewritable) {
		throw new Error(
			`${COMPATIBILITY_FILENAME} must be repaired before exemptions change:\n${state.warnings.join("\n")}`,
		);
	}
	const exemptions = state.exemptions;
	const versions = exemptions[packageVersion] ?? [];
	if (enabled) {
		exemptions[packageVersion] = [...new Set([...versions, runtimeVersion])];
	} else {
		const retained = versions.filter(v => v !== runtimeVersion);
		if (retained.length > 0) exemptions[packageVersion] = retained;
		else Reflect.deleteProperty(exemptions, packageVersion);
	}
	await fs.promises.mkdir(path.dirname(exemptionsPath), { recursive: true });
	const tmp = `${exemptionsPath}.tmp-${process.pid}`;
	await fs.promises.writeFile(tmp, `${JSON.stringify(exemptions, undefined, 2)}\n`, { mode: 0o600 });
	try {
		await fs.promises.chmod(tmp, 0o600);
	} catch {
		/* Windows 忽略 chmod 失败 */
	}
	await fs.promises.rename(tmp, exemptionsPath);
	logger.warn("compatibility exemption changed", { packageVersion, runtimeVersion, enabled });
}
