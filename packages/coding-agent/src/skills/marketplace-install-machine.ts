/**
 * marketplace 安装状态机（roadmap M2-2.2，dsh plugin-manager 参考）。
 *
 * 把 `skills.marketplace.install` 从"一次性动作"升级为可观测、可取消、
 * 可批准的状态机。状态枚举与迁移：
 *
 *   inspecting → downloading → verifying → (awaiting-approval) → installing → done
 *        ↘ failed{invalid}      ↘ failed{network}      ↘ failed{conflict}
 *                                                      ↘ failed{script-declined}
 *   任何进行态可 cancel → cancelled（半成品 staging/dest 全部清理）。
 *
 * 三场景恢复路径（验收契约）：
 *   - 断网：downloading 阶段抛错 → `failed{kind:"network"}`，重试 = 重新
 *     发起安装（不做断点续传——zip 与浅克隆都是秒级小载荷，续传成本不成比例）；
 *   - 取消：cancel RPC 触发 abort + 半成品清理，终态 `cancelled`；
 *   - 脚本拦截：verify 阶段扫描出可执行脚本（.sh/.bat/.ps1/exe 与
 *     package.json install hooks）→ `awaiting-approval`，批准 → 继续安装，
 *     拒绝 → `failed{kind:"script-declined"}`（选 failed 而非 cancelled：
 *     安装没有中断，而是被一次明确的用户否决终止——与 cancel 语义区分，
 *     GUI 文案也不同）。
 *
 * 安装分两个落盘阶段：download 落在进程外（zip 内存 / git 浅克隆落
 * staging），copy 只在 installing 阶段发生；staging 目录在任何终态都被
 * 清理，dest 只在 cancelled 时清理半成品。
 */

import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { logger } from "@musepi/pi-utils";
import { parseGitUrl } from "../extensibility/plugins/git-url";
import { normalizeSkillSource, resolveSkillDir, shallowClone, skillTargetName } from "./install";
import { skillHubDownloadUrl } from "./marketplace-client";
import { extractZipEntries, fetchBytes } from "./marketplace-install";

export type MarketplaceInstallState =
	| "inspecting"
	| "downloading"
	| "verifying"
	| "awaiting-approval"
	| "installing"
	| "done"
	| "failed"
	| "cancelled";

export type MarketplaceInstallFailureKind = "network" | "script-declined" | "invalid" | "conflict" | "unknown";

/** 怎么区分"网络断"与"用户取消"：AbortError 是 cancel 的载体，其余
 *  downloading 阶段错误一律按 network 归类（该阶段只有网络访问）。 */
class InstallAbort extends Error {}

interface InstallFailure extends Error {
	kind: MarketplaceInstallFailureKind;
}

function installFailure(kind: MarketplaceInstallFailureKind, message: string): InstallFailure {
	const err: InstallFailure = Object.assign(new Error(message), { kind });
	return err;
}

/** 可执行脚本/安装钩子的识别面：扩展名 + 常见安装脚本名 + package.json
 *  install hooks。保守集合——宁可漏报也不把 README.md 之类误杀。 */
const SCRIPT_EXT_RE = /\.(sh|bash|zsh|bat|cmd|ps1|exe|msi|dll|vbs|wsf|scr)$/i;
const INSTALL_HOOK_KEYS = ["preinstall", "install", "postinstall"] as const;
/** 扫描边界：技能包都是小载荷，防恶意 zip 撑爆遍历。 */
const SCAN_MAX_ENTRIES = 4000;
const SCAN_MAX_DEPTH = 8;

async function scanScripts(dir: string): Promise<string[]> {
	const hits: string[] = [];
	let visited = 0;
	const walk = async (current: string, rel: string, depth: number): Promise<void> => {
		if (depth > SCAN_MAX_DEPTH || visited > SCAN_MAX_ENTRIES) return;
		let rows: Dirent[];
		try {
			rows = await readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const row of rows) {
			visited += 1;
			if (visited > SCAN_MAX_ENTRIES) return;
			const childRel = rel ? `${rel}/${row.name}` : row.name;
			const child = path.join(current, row.name);
			if (row.isDirectory()) {
				if (row.name === "node_modules" || row.name === ".git") continue;
				await walk(child, childRel, depth + 1);
				continue;
			}
			if (SCRIPT_EXT_RE.test(row.name)) {
				hits.push(childRel);
				continue;
			}
			if (row.name === "package.json") {
				try {
					const pkg = JSON.parse(await readFile(child, "utf8")) as {
						scripts?: Record<string, string>;
					};
					const hooks = INSTALL_HOOK_KEYS.filter(key => typeof pkg.scripts?.[key] === "string");
					if (hooks.length > 0) hits.push(`${childRel} (scripts.${hooks.join(", scripts.")})`);
				} catch {
					// unparsable package.json — not a script hit on its own
				}
			}
		}
	};
	await walk(dir, "", 0);
	return hits;
}

/** 对外视图（RPC `skills.marketplace.status` / 事件载荷同形）。 */
export interface MarketplaceInstallView {
	installId: string;
	source: "skillhub" | "skills.sh";
	slug: string;
	repo?: string;
	/** resolved skill name（verify 阶段解析出来之后才有）。 */
	name?: string;
	state: MarketplaceInstallState;
	/** failed 时：语义分类（network/script-declined/invalid/conflict/unknown）。 */
	kind?: MarketplaceInstallFailureKind;
	/** failed 时：人类可读原因。 */
	message?: string;
	/** awaiting-approval 时：拦截到的脚本清单。 */
	scripts?: string[];
	/** 诊断用：staging 目录（终态已清理，仅供测试/排障断言）。 */
	stagingDir?: string;
	startedAt: number;
	updatedAt: number;
}

interface InstallRecord {
	installId: string;
	params: {
		source: "skillhub" | "skills.sh";
		slug: string;
		repo?: string;
		name?: string;
		overwrite?: boolean;
	};
	destRoot: string;
	view: MarketplaceInstallView;
	controller: AbortController;
	approval: PromiseWithResolvers<"approved" | "declined">;
	cancelRequested: boolean;
	/** git 克隆 / zip 解压的暂存目录（终态清理）。 */
	stagingDir: string | null;
	/** copy 目标（installing 阶段才已知；cancelled 时清理半成品用）。 */
	dest: string | null;
	phase: MarketplaceInstallState;
}

export interface MarketplaceInstallStartParams {
	source: "skillhub" | "skills.sh";
	slug: string;
	repo?: string;
	name?: string;
	overwrite?: boolean;
}

/** 终态记录保留上限（status 查询可见，超出裁最旧）。 */
const TERMINAL_KEEP = 20;

export class MarketplaceInstallMachine {
	readonly #records = new Map<string, InstallRecord>();
	readonly #onState: ((view: MarketplaceInstallView) => void) | null;

	/** `onState` 每次状态迁移都被调用（daemon 接 EventService 广播）。 */
	constructor(onState?: (view: MarketplaceInstallView) => void) {
		this.#onState = onState ?? null;
	}

	/** 发起安装：校验参数（同步抛错给 RPC 层），登记记录并异步驱动状态机。 */
	start(params: MarketplaceInstallStartParams, destRoot: string): string {
		if (params.source !== "skillhub" && params.source !== "skills.sh") {
			throw new Error("skills.marketplace.install: source must be skillhub or skills.sh");
		}
		if (!params.slug || typeof params.slug !== "string") {
			throw new Error("skills.marketplace.install: slug required");
		}
		if (params.source === "skills.sh" && !params.repo) {
			throw new Error("skills.marketplace.install: repo required for skills.sh");
		}
		for (const rec of this.#records.values()) {
			if (
				rec.phase !== "done" &&
				rec.phase !== "failed" &&
				rec.phase !== "cancelled" &&
				rec.params.source === params.source &&
				rec.params.slug === params.slug
			) {
				throw new Error(`skills.marketplace.install: "${params.slug}" is already installing`);
			}
		}
		const installId = crypto.randomUUID();
		const now = Date.now();
		const record: InstallRecord = {
			installId,
			params: { ...params },
			destRoot,
			view: {
				installId,
				source: params.source,
				slug: params.slug,
				repo: params.repo,
				state: "inspecting",
				startedAt: now,
				updatedAt: now,
			},
			controller: new AbortController(),
			approval: Promise.withResolvers<"approved" | "declined">(),
			cancelRequested: false,
			stagingDir: null,
			dest: null,
			phase: "inspecting",
		};
		this.#records.set(installId, record);
		this.#pruneTerminal();
		void this.#run(record).catch((err: unknown) => {
			// #run has its own catch-all; this guard only catches machinery bugs.
			logger.error("marketplace install machine crashed", { installId, err });
			this.#settle(record, "failed", "unknown", err instanceof Error ? err.message : String(err));
		});
		return installId;
	}

	/** 请求取消进行中的安装。返回 `cancelled` 表示已受理（终态事件随后到），
	 *  `not-running` 表示该 id 不存在或已终态（dsh cancelInstall 同语义）。 */
	cancel(installId: string): { status: "cancelled" | "not-running" } {
		const rec = this.#records.get(installId);
		if (!rec || this.#isTerminal(rec)) return { status: "not-running" };
		rec.cancelRequested = true;
		rec.controller.abort();
		if (rec.phase === "awaiting-approval") rec.approval.resolve("declined");
		return { status: "cancelled" };
	}

	/** 脚本批准/拒绝（仅 awaiting-approval 态有效）。 */
	approve(installId: string, ok: boolean): { ok: boolean } {
		const rec = this.#records.get(installId);
		if (!rec || rec.phase !== "awaiting-approval") return { ok: false };
		rec.approval.resolve(ok ? "approved" : "declined");
		return { ok: true };
	}

	/** 状态查询：进行中的在前，其后是终态记录（新→旧，有上限）。 */
	status(): { installs: MarketplaceInstallView[] } {
		const all = [...this.#records.values()];
		const active = all.filter(rec => !this.#isTerminal(rec));
		const terminal = all.filter(rec => this.#isTerminal(rec)).sort((a, b) => b.view.startedAt - a.view.startedAt);
		return { installs: [...active, ...terminal].map(rec => ({ ...rec.view })) };
	}

	/** 停止全部进行中安装（服务 stop 钩子；半成品照常清理）。 */
	stop(): void {
		for (const rec of this.#records.values()) {
			if (!this.#isTerminal(rec)) this.cancel(rec.installId);
		}
	}

	#isTerminal(rec: InstallRecord): boolean {
		return rec.phase === "done" || rec.phase === "failed" || rec.phase === "cancelled";
	}

	#pruneTerminal(): void {
		const terminal = [...this.#records.values()].filter(rec => this.#isTerminal(rec));
		if (terminal.length <= TERMINAL_KEEP) return;
		for (const rec of terminal
			.sort((a, b) => a.view.startedAt - b.view.startedAt)
			.slice(0, terminal.length - TERMINAL_KEEP)) {
			this.#records.delete(rec.installId);
		}
	}

	#setPhase(rec: InstallRecord, phase: MarketplaceInstallState, extra?: Partial<MarketplaceInstallView>): void {
		rec.phase = phase;
		rec.view = {
			...rec.view,
			...extra,
			state: phase,
			// 诊断面：staging 在场说明半成品还在（终态清理后为 undefined）。
			stagingDir: rec.stagingDir ?? undefined,
			updatedAt: Date.now(),
		};
		this.#onState?.({ ...rec.view });
	}

	#settle(
		rec: InstallRecord,
		state: "done" | "failed" | "cancelled",
		kind?: MarketplaceInstallFailureKind,
		message?: string,
	): void {
		if (state === "failed") {
			this.#setPhase(rec, "failed", { kind, message });
		} else {
			this.#setPhase(rec, state);
		}
	}

	/** 终态清理：staging 一律删；dest 只在取消时清半成品（done/failed
	 *  的 dest 是完整安装或从未落盘）。 */
	async #cleanup(rec: InstallRecord, removeDest: boolean): Promise<void> {
		if (rec.stagingDir) {
			await rm(rec.stagingDir, { recursive: true, force: true }).catch(() => {});
			rec.stagingDir = null;
		}
		if (removeDest && rec.dest) {
			await rm(rec.dest, { recursive: true, force: true }).catch(() => {});
			rec.dest = null;
		}
	}

	async #run(rec: InstallRecord): Promise<void> {
		const signal = rec.controller.signal;
		try {
			// ── downloading ─────────────────────────────────────────────
			this.#setPhase(rec, "downloading");
			let skillDir: string | null;
			if (rec.params.source === "skillhub") {
				const zip = await fetchBytes(skillHubDownloadUrl(rec.params.slug), { signal });
				this.#setPhase(rec, "verifying");
				const staging = rec.stagingDir ?? (await mkdtemp(path.join(tmpdir(), "musepi-mkt-")));
				rec.stagingDir = staging;
				const root = path.join(staging, "zip");
				await extractZipEntries(zip, root);
				skillDir = resolveSkillDir(root);
			} else {
				const url = normalizeSkillSource(`https://github.com/${rec.params.repo}`);
				// parseGitUrl 与 skills.install 同一道门（防通用 fetch-and-write）。
				if (!parseGitUrl(url)) throw installFailure("invalid", `not a git source: ${url}`);
				const scratch = await shallowClone(url, { signal });
				rec.stagingDir = scratch;
				this.#setPhase(rec, "verifying");
				skillDir = resolveSkillDir(path.join(scratch, "repo"), rec.params.slug);
			}
			if (!skillDir) {
				throw installFailure(
					"invalid",
					rec.params.source === "skills.sh"
						? `no SKILL.md under subdir "${rec.params.slug}"`
						: "skillhub zip has no SKILL.md at its root or a single subdirectory",
				);
			}

			// ── verifying：名字解析 + 冲突预检 + 脚本扫描 ────────────────
			const name = skillTargetName(skillDir, rec.params.name);
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
				throw installFailure("invalid", `derived skill name is not filesystem-safe: "${name}"`);
			}
			this.#setPhase(rec, "verifying", { name });
			const dest = path.join(rec.destRoot, name);
			if (!rec.params.overwrite && existsSync(dest)) {
				throw installFailure("conflict", `skill "${name}" already exists (pass overwrite to replace)`);
			}
			rec.dest = dest;
			const scripts = await scanScripts(skillDir);
			if (signal.aborted) throw new InstallAbort();
			if (scripts.length > 0) {
				this.#setPhase(rec, "awaiting-approval", { scripts });
				const decision = await rec.approval.promise;
				if (decision === "declined") {
					if (rec.cancelRequested) throw new InstallAbort();
					throw installFailure("script-declined", "install scripts declined by user");
				}
				if (signal.aborted) throw new InstallAbort();
			}

			// ── installing：staging → dest 的唯一落盘窗口 ────────────────
			this.#setPhase(rec, "installing");
			await cp(skillDir, dest, { recursive: true });
			if (signal.aborted || rec.cancelRequested) throw new InstallAbort();

			await this.#cleanup(rec, false);
			this.#settle(rec, "done");
		} catch (err: unknown) {
			if (rec.cancelRequested || signal.aborted || err instanceof InstallAbort) {
				await this.#cleanup(rec, true);
				this.#settle(rec, "cancelled");
				return;
			}
			await this.#cleanup(rec, false);
			if (rec.phase === "downloading") {
				// 下载阶段只跟网络打交道：统一归类 network（消息留原始错误）。
				this.#settle(rec, "failed", "network", err instanceof Error ? err.message : String(err));
				return;
			}
			const kind = (err as Partial<InstallFailure>).kind ?? "unknown";
			this.#settle(rec, "failed", kind, err instanceof Error ? err.message : String(err));
		}
	}
}
