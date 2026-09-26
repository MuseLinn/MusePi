/**
 * skills.marketplace.install / preview —— 能力中心「发现」屏的
 * 来源感知安装与预览（SkillHub zip 直装 + skills.sh 子目录 git 安装 +
 * skills.sh 的 SKILL.md 远程预览）。
 *
 * 背景（2026-09-26 线上实测修复）：
 *
 *   - SkillHub 目录项只暴露主页 `https://api.skillhub.cn/<ns>/<slug>`，
 *     旧 GUI 把它当 git URL 喂给 `skills.install` → git clone 403。
 *     SkillHub 的正道是 `/api/v1/download?slug=…`（302 → 对象存储 zip），
 *     本模块下载并解压后走与 git 安装同一套 resolve/copy 约定。
 *   - skills.sh 的 installUrl 是整个 monorepo（如 `anthropics/skills`），
 *     根目录有几十个子技能，不带 subdir 的 clone 必然命中
 *     "multiple SKILL.md" 歧义错误。skillId 就是仓库内子目录，
 *     必须作为 `subdir` 传给安装器。
 *   - skills.sh 搜索接口（legacy `/api/search`）不返回描述，卡片内容
 *     为空；预览时从 `raw.githubusercontent.com/<repo>/<branch>/<slug>/SKILL.md`
 *     拉正文前段补上（main → master 回退，仅读不执行）。
 *
 * 所有网络调用超时收敛，错误以可读消息跨 RPC 边界抛出。
 */
import { existsSync } from "node:fs";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { unzipSync } from "fflate";
import { resolveSkillDir, skillTargetName } from "./install";
import { skillHubDownloadUrl } from "./marketplace-client";

const FETCH_TIMEOUT_MS = 30_000;
/** Preview bodies are capped — the dialog shows a taste, not the whole file. */
const PREVIEW_MAX_BYTES = 24 * 1024;

async function fetchBytes(url: string): Promise<Uint8Array> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return new Uint8Array(await res.arrayBuffer());
	} finally {
		clearTimeout(timer);
	}
}

/** Download the SkillHub zip (302 → object storage) and install the skill
 *  folder it contains. Same resolve/copy contract as the git installer so
 *  both sources land in an indistinguishable target shape. */
export async function installSkillFromSkillHub(
	slug: string,
	destRoot: string,
	opts: { name?: string; overwrite?: boolean } = {},
): Promise<{ name: string; dir: string }> {
	const zip = await fetchBytes(skillHubDownloadUrl(slug));
	return installSkillFromSkillHubZip(zip, destRoot, opts);
}

/** Zip-extract half, exported for offline tests: feed a synthetic archive
 *  (fflate `zipSync`) through the same entry-guard + resolve/copy path. */
export async function installSkillFromSkillHubZip(
	zip: Uint8Array,
	destRoot: string,
	opts: { name?: string; overwrite?: boolean } = {},
): Promise<{ name: string; dir: string }> {
	const scratch = await mkdtemp(path.join(tmpdir(), "musepi-skillhub-"));
	try {
		const root = path.join(scratch, "zip");
		// unzipSync has no target-dir option: take the entry map and write
		// each file under `root` ourselves (also enforces the zip-slip guard).
		let entries: Record<string, Uint8Array>;
		try {
			entries = unzipSync(zip);
		} catch {
			throw new Error("skillhub download is not a valid zip archive");
		}
		for (const [rel, data] of Object.entries(entries)) {
			const safe = rel.replace(/\\/g, "/").replace(/^\/+/, "");
			if (!safe || safe.split("/").includes("..")) continue;
			const target = path.join(root, safe);
			if (safe.endsWith("/")) continue;
			await mkdirp(path.dirname(target));
			await writeFile(target, data);
		}
		const skillDir = resolveSkillDir(root);
		if (!skillDir) {
			throw new Error("skillhub zip has no SKILL.md at its root or a single subdirectory");
		}
		const name = skillTargetName(skillDir, opts.name);
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
			throw new Error(`derived skill name is not filesystem-safe: "${name}"`);
		}
		const dest = path.join(destRoot, name);
		if (existsSync(dest) && !opts.overwrite) {
			throw new Error(`skill "${name}" already exists (pass overwrite to replace)`);
		}
		await cp(skillDir, dest, { recursive: true });
		return { name, dir: dest };
	} finally {
		await rm(scratch, { recursive: true, force: true }).catch(() => {});
	}
}

async function mkdirp(dir: string): Promise<void> {
	const { mkdir } = await import("node:fs/promises");
	await mkdir(dir, { recursive: true });
}

/**
 * skills.sh preview: pull the SKILL.md body straight from the publisher's
 * GitHub repo (the skill id IS the repo-relative folder). Read-only text —
 * nothing is cloned or executed. Returns null when the repo doesn't expose
 * the file on either main or master.
 */
export async function previewSkillsShSkill(repo: string, skillId: string): Promise<{ content: string } | null> {
	const base = `https://raw.githubusercontent.com/${repo}`;
	for (const branch of ["main", "master"]) {
		try {
			const bytes = await fetchBytes(`${base}/${branch}/${encodeURIComponent(skillId)}/SKILL.md`);
			const text = new TextDecoder().decode(bytes);
			if (!text.trim()) continue;
			return {
				content: text.length > PREVIEW_MAX_BYTES ? `${text.slice(0, PREVIEW_MAX_BYTES)}\n… (truncated)` : text,
			};
		} catch {
			// try the next branch
		}
	}
	return null;
}
