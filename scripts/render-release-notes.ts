#!/usr/bin/env bun

/**
 * Render the GitHub release body from `CHANGELOG.musepi.md`.
 *
 * Why this exists: the release workflow used to splice the newest changelog
 * section under the download table verbatim. That repeated the version line
 * the page already shows, dropped the section's own header context, and gave
 * no at-a-glance answer to "what is new, what improved, what was fixed".
 *
 * Contract (see `.agents/rules/release.md` → "Changelog ownership"):
 *   - the newest `## [x.y.z] - date` section is the only source of the body;
 *   - the body keeps the platform download table, replaces the duplicated
 *     version heading with a counts line (`本次发布：N 项新功能 · M 项改进 ·
 *     K 项修复`), then lists the categorized entries unchanged;
 *   - the body ends with links to the full changelog and to the tag-to-tag
 *     comparison against the next older release in the file;
 *   - `--max-chars` caps the page body: whole entries are trimmed (never cut)
 *     and one line reports how many remain, because GitHub silently cuts a
 *     release body at 125,000 characters;
 *   - the OTA `update-manifest.json` notes are the same section with its
 *     version heading and counts line, so the update dialog's first ~200
 *     characters state the release and its category breakdown.
 *
 * Pure functions plus a thin CLI: the workflow passes the version, tag and
 * output paths, and the same functions are unit-tested with changelog text.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

const CHANGELOG_PATH = "packages/coding-agent/CHANGELOG.musepi.md";
const APP_PACKAGE_PATH = "apps/desktop/package.json";

export const DEFAULT_REPO = "MuseLinn/MusePi";

/** `## [1.2.3] - 2026-11-21` and `## [1.2.3-beta.1] - 2026-11-21`. */
const RELEASE_HEADING = /^## \[([^\]]+)\](?:\s*-\s*(.*))?$/;
/** Released sections only; `[Unreleased]` and prose headings are skipped. */
const RELEASED_VERSION = /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/;
const SUBSECTION_HEADING = /^###\s+(.+?)\s*$/;

/** One released changelog section, heading stripped. */
export interface ReleaseSection {
	version: string;
	/** Date from the heading; "" when the heading carries none. */
	date: string;
	/** Markdown after the `## [version] - date` heading, blank edges trimmed. */
	body: string;
}

export interface ReleaseEntryCounts {
	added: number;
	improved: number;
	fixed: number;
	/** Entries outside a category heading (released flat sections, other headings). */
	uncategorized: number;
	total: number;
}

type CategoryKind = "added" | "improved" | "fixed";

/** Heading → counts bucket. Chinese headings are canonical; the English names
 *  of older released sections still count so a legacy body renders sensibly. */
const CATEGORY_KIND: Record<string, CategoryKind> = {
	新功能: "added",
	Added: "added",
	改进: "improved",
	Changed: "improved",
	Improved: "improved",
	修复: "fixed",
	Fixed: "fixed",
};

/** Release-page heading for each category, in display order. */
const CATEGORY_ORDER: readonly CategoryKind[] = ["added", "improved", "fixed"];
const CATEGORY_HEADING: Record<CategoryKind, string> = {
	added: "新功能",
	improved: "改进",
	fixed: "修复",
};

/**
 * How a released section that shipped without category headings is filed on
 * its page. v0.7.7 predates the headings, and a released section is immutable,
 * so its flat entries cannot be re-filed in the changelog itself. Each list is
 * the section's entries in document order with the category they belong to; a
 * missing, extra or reordered entry fails the render instead of mis-filing the
 * page.
 */
const LEGACY_SECTION_CATEGORIES: Record<string, readonly (readonly [string, CategoryKind])[]> = {
	"0.7.7": [
		["吸顶提问背后不再铺底色带，药丸下方的正文照常可读", "fixed"],
		["右侧「上下文」标签页补齐读数：上下文卡片、消息统计、会话与最近消息的 token 表、原始消息列表", "added"],
		["关闭的活动折叠行下方不再留出空白", "fixed"],
		["活动折叠行与会话流共用同一条左边缘，右侧面板标签不再横向滚动", "fixed"],
		["欢迎区外框升级为 hoc 插件座位，点阵背景改由内置品牌插件提供", "improved"],
		["欢迎页与会话共用同一个输入框宿主", "improved"],
		["右侧栏「文件」标签不再显示上下文读数", "fixed"],
		["共享面转场全面规范化：欢迎页与会话输入框、图片预览与画板都连成一条", "improved"],
		["专注切换不再整窗闪，图片预览与画板连成一条一镜到底", "fixed"],
		["专注模式切换改成真正的一镜到底", "improved"],
		["Linux 桌面上，鼠标移近桌宠时快速栏现在会展开", "fixed"],
		["角色模型卡片按回退顺序重排，降级链与增删调序一眼可读", "improved"],
		["看板示例卡片都能真正操作，旧示例卡也能一键换成可交互", "fixed"],
		["「工作台」改为「右侧栏」，面板槽位改名为 `panel.tab.dock`", "improved"],
		["设置内容区收敛为统一工厂，新增页面不再需要改壳", "improved"],
		["页面自有行席位按 dsh children 的粒度收敛", "improved"],
		["「常规」页的行级偏好席位改用 dsh 命名", "improved"],
		["设置页槽位按 dsh 词汇统一为 `settings.section`，导航身份由注册者拥有", "improved"],
		["全局听写：在任何应用里用快捷键说话", "added"],
		["连接器与索引库设置页转为 Cordis 页面插件", "improved"],
		["OAuth 回调页换回 MusePi 品牌，验证码出现即复制", "fixed"],
		["⌘K 能搜设置，输入框设置并入会话与记忆，右侧面板首次展开不再失灵", "added"],
		["提及标签只剩图标与名字，占位提示与光标同线，图片预览走一镜到底", "improved"],
		["删掉图片会一并删掉它的提及，提及标签也换成图标+文字且不再互相压住", "fixed"],
		["连接引导弹窗一次成型，禁用态悬停不再变形", "fixed"],
		["会话搜索框撑满侧栏，开关有了出入场动效；⌘K 面板按匹配度排序并把“任务”改回“会话”", "improved"],
		["托盘菜单从图标的位置展开，不再固定贴着屏幕角落", "fixed"],
		["桌宠快捷输入现在能带图片、截屏与文件，语音也会有回应", "added"],
		["搜索框统一成一个组件，不再每个页面手写一套", "improved"],
		["能力中心工具行不再多出一圈渐隐方框", "fixed"],
		["分享面板由入口决定范围，网络方式改用实时探测", "improved"],
		["远程共享掉线不再等于结束，直连链接也不再把房间密钥写进代理日志", "fixed"],
		["远程共享有了四条免费路径，掉线立刻作废链接", "added"],
		["页面里的选择会真的等用户回答，浏览器接管也能交还", "fixed"],
		["重启后会话里的图片不再变破图，浏览器「我来接管」也不再掐断回合", "fixed"],
		["进展更新回到正文，不再是一张工具卡；被中断的调用也不会永远转圈", "fixed"],
		["输入框提示会随情景变化，移动/web 也换成同一套 CodeMirror 编辑器", "improved"],
		[
			"桌面操作补上 macOS 与 Linux 的三处空白：物理 Esc 能停下 agent、Linux 菜单与应用目录可用、前台保持 API 先行导出",
			"added",
		],
		["技能更新后不必新建会话，检查更新也变成显式动作", "improved"],
		["桌面 computer 新增 `regions()` 区域提案，只有 AX 为空或自绘界面才该用它", "added"],
		["macOS 的编译错误在 PR 上就会被拦住，桌面测试也进了 CI", "improved"],
		["技能更新后不必新建会话，检查更新也变成显式动作", "improved"],
		["computer 画中画：桌面窗口与同一 shell 的网页/移动端都能看到", "added"],
		["技能更新补上破坏性确认与“降级不算更新”", "fixed"],
		["输入框编辑器换成 CodeMirror 6，文档仍是纯字符串", "improved"],
		["撤回用户消息会把原文和图片放回输入框，回退后重发不再露出旧分支", "fixed"],
		["输入框里的 token 统一成液态玻璃材质", "improved"],
		["粘贴图片时自动在光标处生成 @ 提及，并新增「输入框」设置分节", "added"],
		["窗口变窄时左侧栏先折起，会话列不再被挤成一条缝", "improved"],
		["输入框的模型胶囊先收缩再换行，思考等级始终可见", "improved"],
		["连接器的每个动作都有回执，滚到列表底部也看得见", "improved"],
		["连接器目录改成两列索引与二级详情弹窗，60 个连接器不再是一条长列表", "improved"],
		["连接器的分类筛选会真的筛选，示例也变成中文并能一键写进输入框", "fixed"],
		["登录不再三种方式并排，连接只有一条路，设备码与 Token 收进「其他登录方式」", "improved"],
		["授权成功才算连上，登录与报错也不再替用户假设结果", "fixed"],
		["从其他智能体导入变成两步确认，并标出接入与凭据状态", "improved"],
		["弹窗切换内容会形变，连接器页把目录外的 MCP 收进独立分区", "improved"],
		["有起点的弹窗改用共享元素转场，没有起点的保持原动效", "improved"],
		["技能、插件市场与看板的卡片也接入一镜到底", "improved"],
		["图片与生成式 UI 的全屏预览也统一到一镜到底，点面板外即可返回", "improved"],
		["模型胶囊只留品牌、模型名与等级", "improved"],
		["目录可以在不发布新版本的情况下更新，而且断网不会让连接器消失", "improved"],
		["技能市场能检测已安装技能的更新", "added"],
		["能力中心能显示技能版本，内置技能的更新方式也说清楚了", "added"],
		["供应商可以给自己起显示名，自定义供应商的编辑也跟着补全了", "added"],
		["连接器图标改成随包数据，每张卡片不再去敲厂商的门", "improved"],
		["发行包不再携带维护者技能与开发文件", "fixed"],
		["连接器目录补上飞书与 Lark，图标与示例也补齐了", "added"],
		["性能与用量胶囊拆成两条可独立替换的席位条目", "improved"],
		["创造模式与扩展开发技能补上「发布到插件市场」的路径", "improved"],
		["顶栏不再显示 ctx 百分比", "improved"],
		["外部改写 `models.yml` 后，模型列表不用重启 daemon 就能更新", "fixed"],
		["输入区席位改成参考实现的层级，输入卡由会话插件自持", "improved"],
		["根层与空态席位补齐，页面挂载改用参考实现的 `main` 命名", "improved"],
		["桌面运行时升到 Electron 45，启动日志里那条资源包报错也随之消失", "improved"],
		["会话内 ⌘⇧E 的输入框形变不再抖，也不会顶到窗口边缘", "fixed"],
		["思考档位崩溃修好了，空态胶囊也不会再挂着模型没有的档位", "fixed"],
		["专注模式的输入框形变也回到统一的弹簧语言，修掉三处隐形问题", "fixed"],
		["侧栏展开与输入框长高也用上了弹簧，形变语言统一了", "improved"],
		["设置页与扩展中心的展开收起改用弹簧，形变有了「冲过去再回来」的质感", "improved"],
		["鸿蒙与托盘的图标换成客户端那一张", "improved"],
		["GitHub 连接器多了一条退路", "improved"],
		["鸿蒙连接页不再自成一派", "improved"],
		["手机设置页的三页终于有文案了", "fixed"],
		["手机界面在宽屏触屏设备上不再退回桌面布局", "fixed"],
		["GitHub 连接器现在能连上了，而且不用填任何东西", "fixed"],
		["鸿蒙：材质名称与实际材质对上了", "fixed"],
		["鸿蒙：列表里的材质摘要会跟着滑块变", "fixed"],
		["GitHub 连接器可以连上了：填一次自己的 OAuth 应用即可", "added"],
		["鸿蒙：材质滑块点了立刻生效，启动图标恢复品牌配色", "fixed"],
		["折叠屏展开后浏览器里不再退回桌面布局", "fixed"],
		["跨会话搜索改用全文索引，中文能搜到词中间的字，助手发言与工具输出一并可查", "added"],
		["界面块能画图，且和正文图片共用同一套读取规则", "added"],
		["桌宠悬停浮出快捷胶囊，气泡进出场有完整节奏", "added"],
		["可以直接导入 WorkBuddy 的会话，Kimi Code 的子代理归回它的父会话", "added"],
		["可以直接导入 DeepSeek Harness 的会话", "added"],
		["按钮组不再互抢答案，选项可横排，块里能翻页", "fixed"],
		["导入别人留下的多目录会话时，先看清会多挂几个目录", "improved"],
		["界面块能对单个选项补条件、能一次点开链接并回话、能画小图标", "added"],
		["会话地图与移动端会话树修掉五处真实缺陷", "fixed"],
		["长会话的目录状态不再永久卡在加载中", "fixed"],
		["启动的「新功能」面板在 Windows 检出上不再空白", "fixed"],
		["导入会话的来源全部改用各自的品牌标志", "improved"],
		["切换模型后思考等级不再停留在新模型没有的档位", "fixed"],
		["导入会话显示项目名与标题，而不是一串会话 id", "improved"],
		["表格数字列右对齐、卡片内表格去掉双框、进度条不再提前显示 100%", "fixed"],
		["手机浏览器拿到和 App 一致的信息架构，扫码不再被外壳挡住", "improved"],
		["手机设置补上通知、存储与隐私、关于三页", "added"],
		["安卓：品牌配色、通知渠道与启动器长按快捷方式", "added"],
		["回复里的可视化块补齐阅读与排版组件", "added"],
		["外观预览与示例看板恢复可用", "fixed"],
		["子代理会话不再让窗口崩成错误页，侧边会话补上头像，左侧会话列表恢复滚动", "fixed"],
		["安卓：启动器角标恢复计数，会话切换卡不再被键盘顶出屏幕", "fixed"],
		["配对面板直接给出电脑地址，失败不再静默", "improved"],
		["鸿蒙：设置材质即时生效、返回按层级退、麦克风不再借相机说明", "fixed"],
		["代理操作标记重新画在网页里", "fixed"],
		["看板插件不再因加载顺序被拒绝", "fixed"],
		["浏览器地址栏的网站图标不再破图；连接器页的 MCP 标题不再重复两遍", "fixed"],
		["浏览器面板、压缩摘要标签页与浮动滚动条恢复正常", "fixed"],
		["异步任务卡不再有两个折叠控件", "fixed"],
		["MCP 服务器并入连接器，设置里不再有两处入口", "improved"],
		["宿主可以声明由谁回答计算机使用", "added"],
		["浮层滚到顶/尾后不再带动背景滚动", "fixed"],
	],
};

function trimBlankLines(lines: readonly string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && (lines[start] ?? "").trim() === "") start++;
	while (end > start && (lines[end - 1] ?? "").trim() === "") end--;
	return lines.slice(start, end);
}

/** Every released section in document order (the file is newest-first). */
export function listReleaseSections(changelog: string): ReleaseSection[] {
	const sections: ReleaseSection[] = [];
	let current: { version: string; date: string; lines: string[] } | null = null;

	const flush = (): void => {
		if (!current) return;
		sections.push({
			version: current.version,
			date: current.date,
			body: trimBlankLines(current.lines).join("\n"),
		});
		current = null;
	};

	for (const line of changelog.split(/\r?\n/)) {
		const heading = RELEASE_HEADING.exec(line);
		if (heading) {
			flush();
			const version = (heading[1] ?? "").trim();
			if (RELEASED_VERSION.test(version)) {
				current = { version, date: (heading[2] ?? "").trim(), lines: [] };
			}
			continue;
		}
		if (current) current.lines.push(line);
	}
	flush();
	return sections;
}

/** The section for one exact version, or undefined when the file has none. */
export function findReleaseSection(changelog: string, version: string): ReleaseSection | undefined {
	return listReleaseSections(changelog).find(section => section.version === version);
}

/** Per-category entry counts for a section body. */
export function countReleaseEntries(body: string): ReleaseEntryCounts {
	const counts: ReleaseEntryCounts = { added: 0, improved: 0, fixed: 0, uncategorized: 0, total: 0 };
	let kind: "added" | "improved" | "fixed" | undefined;

	for (const line of body.split(/\r?\n/)) {
		if (line.startsWith("#")) {
			const title = SUBSECTION_HEADING.exec(line)?.[1] ?? "";
			kind = CATEGORY_KIND[title];
			continue;
		}
		// Top-level bullets only; the indented `- EN:` child is part of its parent.
		if (!line.startsWith("- ")) continue;
		counts.total++;
		counts[kind ?? "uncategorized"]++;
	}

	return counts;
}

/** One blank-line-separated block of a section body. */
export interface SectionBlock {
	/** 1-based line number of the block's first line, counted from the body's first line. */
	line: number;
	lines: string[];
}

/**
 * Non-empty blocks of a section, separated by blank lines, with their line
 * numbers. The release body and `check-changelog-i18n` both read a section
 * through this one split: only `- ` blocks are entries on the page, so a block
 * that starts anywhere else is prose the page keeps and the entry count loses.
 */
export function sectionBlockRanges(body: string): SectionBlock[] {
	const blocks: SectionBlock[] = [];
	let current: string[] = [];
	let start = 0;
	body.split(/\r?\n/).forEach((line, index) => {
		if (line.trim() === "") {
			if (current.length > 0) blocks.push({ line: start + 1, lines: current });
			current = [];
			return;
		}
		if (current.length === 0) start = index;
		current.push(line);
	});
	if (current.length > 0) blocks.push({ line: start + 1, lines: current });
	return blocks;
}

function sectionBlocks(body: string): string[] {
	return sectionBlockRanges(body).map(block => block.lines.join("\n"));
}

interface SectionGroup {
	/** `### 新功能` block, or null for entries that precede any heading. */
	heading: string | null;
	blocks: string[];
}

/** A section body as labelled groups: each heading and the blocks after it. */
function groupSectionBody(body: string): SectionGroup[] {
	const groups: SectionGroup[] = [];
	for (const block of sectionBlocks(body)) {
		if (block.startsWith("### ")) {
			groups.push({ heading: block, blocks: [] });
			continue;
		}
		const current = groups[groups.length - 1];
		if (current) current.blocks.push(block);
		else groups.push({ heading: null, blocks: [block] });
	}
	return groups;
}

/** True when a block is an entry — the only block shape the page counts. */
export function isEntryBlock(block: string): boolean {
	return block.startsWith("- ");
}

function entryCount(group: SectionGroup): number {
	return group.blocks.filter(isEntryBlock).length;
}

function entryChars(group: SectionGroup): number {
	return group.blocks.filter(isEntryBlock).reduce((total, block) => total + characterLength(block), 0);
}

function characterLength(text: string): number {
	return [...text].length;
}

interface FlatEntry {
	title: string;
	lines: string[];
}

/** Every top-level bullet of a flat section, with its continuation lines. */
function parseFlatEntries(body: string): FlatEntry[] {
	const entries: FlatEntry[] = [];
	for (const line of body.split(/\r?\n/)) {
		if (line.trim() === "") continue;
		if (line.startsWith("#")) {
			throw new Error(`a section with a category table cannot carry headings: "${line}"`);
		}
		if (line.startsWith("- ")) {
			const title = /^-\s+\*\*(.+?)\*\*/.exec(line)?.[1];
			if (!title) throw new Error(`flat section entry has no bold title: "${line.slice(0, 60)}"`);
			entries.push({ title, lines: [line] });
			continue;
		}
		const current = entries[entries.length - 1];
		if (!current) throw new Error(`text before the first flat entry: "${line.slice(0, 60)}"`);
		current.lines.push(line);
	}
	return entries;
}

/** Regroup a flat section under the category headings, keeping every entry's
 *  lines exactly as written. */
function categorizeFlatSection(body: string, plan: readonly (readonly [string, CategoryKind])[]): string {
	const entries = parseFlatEntries(body);
	if (entries.length !== plan.length) {
		throw new Error(`flat section has ${entries.length} entries, ${plan.length} are categorized`);
	}
	const buckets: Record<CategoryKind, string[]> = { added: [], improved: [], fixed: [] };
	for (const [index, entry] of entries.entries()) {
		const [title, kind] = plan[index]!;
		if (entry.title !== title) {
			throw new Error(`entry ${index + 1} is "${entry.title}", categorized as "${title}"`);
		}
		buckets[kind].push(entry.lines.join("\n"));
	}
	return CATEGORY_ORDER.filter(kind => buckets[kind].length > 0)
		.map(kind => `### ${CATEGORY_HEADING[kind]}\n\n${buckets[kind].join("\n\n")}`)
		.join("\n\n");
}

/** The body the release artifacts show: a legacy flat section is regrouped by
 *  its table, everything else is used as written. */
function sectionBody(section: ReleaseSection): string {
	const plan = LEGACY_SECTION_CATEGORIES[section.version];
	return plan ? categorizeFlatSection(section.body, plan) : section.body;
}

/** Drop one entry from the category with the most entry characters, so the
 *  page keeps a prefix of every category. Returns false when none is left. */
function dropLastEntry(groups: readonly SectionGroup[]): boolean {
	let target: SectionGroup | undefined;
	let targetChars = -1;
	for (const group of groups) {
		if (entryCount(group) === 0) continue;
		const chars = entryChars(group);
		if (chars > targetChars) {
			target = group;
			targetChars = chars;
		}
	}
	if (!target) return false;
	for (let index = target.blocks.length - 1; index >= 0; index--) {
		if (isEntryBlock(target.blocks[index]!)) {
			target.blocks.splice(index, 1);
			return true;
		}
	}
	return false;
}

function omittedNotice(omitted: number, repo = DEFAULT_REPO): string {
	return `还有 ${omitted} 项变更未在此页展开，见[完整更新日志](https://github.com/${repo}/blob/main/${CHANGELOG_PATH})。`;
}

/**
 * The one-line release summary. Zero categories are omitted so a fix-only
 * release reads "本次发布：3 项修复" rather than three zeroes.
 */
export function formatReleaseSummary(counts: ReleaseEntryCounts): string {
	const parts: string[] = [];
	if (counts.added > 0) parts.push(`${counts.added} 项新功能`);
	if (counts.improved > 0) parts.push(`${counts.improved} 项改进`);
	if (counts.fixed > 0) parts.push(`${counts.fixed} 项修复`);
	if (counts.uncategorized > 0) parts.push(`${counts.uncategorized} 项其他变更`);
	return `本次发布：${parts.length > 0 ? parts.join(" · ") : "无用户可见变更"}`;
}

function assetsBaseUrl(repo: string, assetsTag: string): string {
	return `https://github.com/${repo}/releases/download/${assetsTag}`;
}

/** Platform download table; `assetsTag` is the tag the assets are uploaded under. */
export function buildDownloadTable(version: string, assetsTag: string, repo = DEFAULT_REPO): string {
	const base = assetsBaseUrl(repo, assetsTag);
	const link = (name: string): string => `[${name}](${base}/${name})`;
	return [
		"| Platform | 下载 |",
		"| --- | --- |",
		`| macOS (Apple Silicon) | ${link(`MusePi-${version}-arm64.dmg`)} |`,
		`| Windows | ${link(`MusePi-${version}-setup.exe`)} · ${link(`MusePi-${version}-arm64-setup.exe`)} |`,
		`| Linux x64 | ${link(`MusePi-${version}-x86_64.AppImage`)} · ${link(`MusePi-${version}-amd64.deb`)} |`,
		`| Linux arm64 | ${link(`MusePi-${version}-arm64.AppImage`)} · ${link(`MusePi-${version}-arm64.deb`)} |`,
		`| Android | ${link(`MusePi-${version}-app-debug.apk`)} (debug build, adb 安装) |`,
	].join("\n");
}

/** Full changelog and previous-release comparison footer. */
export function buildReleaseLinks(input: {
	version: string;
	tag: string;
	previousVersion?: string;
	repo?: string;
}): string {
	const repo = input.repo ?? DEFAULT_REPO;
	const changelog = `[完整更新日志](https://github.com/${repo}/blob/main/${CHANGELOG_PATH})`;
	const previous = input.previousVersion;
	const comparison = previous
		? `[对比 v${previous}…v${input.version}](https://github.com/${repo}/compare/v${previous}...${input.tag})`
		: `[全部发布](https://github.com/${repo}/releases)`;
	return `${changelog} · ${comparison}`;
}

/** Derive the released version from a `v<version>` tag. */
function versionFromTag(tag: string): string {
	if (!tag.startsWith("v") || tag.length === 1) {
		throw new Error(`tag "${tag}" must use the release form "v<version>"`);
	}
	return tag.slice(1);
}

/**
 * Resolve the version and tag the body is rendered for. `--tag` alone derives
 * the version, so a tag can never silently render another release's section;
 * when both are given they must agree on `v<version>`.
 */
export function resolveReleaseVersion(input: { version?: string; tag?: string; packageVersion: string }): {
	version: string;
	tag: string;
} {
	const version = input.version ?? (input.tag ? versionFromTag(input.tag) : input.packageVersion);
	const tag = input.tag ?? `v${version}`;
	if (tag !== `v${version}`) {
		throw new Error(`tag "${tag}" does not match version ${version} (expected "v${version}")`);
	}
	return { version, tag };
}

export interface RenderReleaseNotesInput {
	changelog: string;
	/** Version being released; must exist as a `## [version]` section. */
	version: string;
	/** Git tag of this release, used for the comparison link (`v0.7.8`). */
	tag: string;
	/** Tag the assets were uploaded under; defaults to `tag` (`channel-beta` for betas). */
	assetsTag?: string;
	repo?: string;
	/** Cap the body at this many characters. Entries are trimmed at their
	 *  boundaries and the omission is reported; the text is never cut. */
	maxChars?: number;
}

function buildPage(input: {
	version: string;
	tag: string;
	assetsTag?: string;
	repo?: string;
	previousVersion?: string;
	summary: string;
	groups: readonly SectionGroup[];
	omitted: number;
}): string {
	const blocks = [
		`# MusePi ${input.version}`,
		buildDownloadTable(input.version, input.assetsTag ?? input.tag, input.repo),
		input.summary,
	];
	for (const group of input.groups) {
		const body = group.blocks.join("\n\n");
		if (body === "") continue;
		blocks.push(group.heading ? `${group.heading}\n\n${body}` : body);
	}
	if (input.omitted > 0) blocks.push(omittedNotice(input.omitted, input.repo));
	blocks.push(
		"---",
		buildReleaseLinks({
			version: input.version,
			tag: input.tag,
			previousVersion: input.previousVersion,
			repo: input.repo,
		}),
	);
	return `${blocks.join("\n\n")}\n`;
}

/** The GitHub release body: download table, counts line, entries, links. */
export function renderReleaseNotes(input: RenderReleaseNotesInput): string {
	if (input.tag !== `v${input.version}`) {
		throw new Error(`tag "${input.tag}" does not match version ${input.version} (expected "v${input.version}")`);
	}
	const sections = listReleaseSections(input.changelog);
	const index = sections.findIndex(section => section.version === input.version);
	if (index < 0) {
		const latest = sections[0]?.version;
		throw new Error(
			`no \`## [${input.version}]\` section in the changelog` +
				(latest ? ` (newest released section is \`## [${latest}]\`)` : ""),
		);
	}
	const section = sections[index];
	const previousVersion = sections[index + 1]?.version;
	const entries = sectionBody(section);
	const counts = countReleaseEntries(entries);
	const groups = groupSectionBody(entries);
	const page = (omitted: number): string =>
		buildPage({
			version: input.version,
			tag: input.tag,
			assetsTag: input.assetsTag,
			repo: input.repo,
			previousVersion,
			summary: formatReleaseSummary(counts),
			groups,
			omitted,
		});

	let body = page(0);
	if (input.maxChars !== undefined) {
		let omitted = 0;
		while (characterLength(body) > input.maxChars) {
			if (!dropLastEntry(groups)) {
				throw new Error(
					`release body is ${characterLength(body)} characters; nothing is left to fit --max-chars ${input.maxChars}`,
				);
			}
			omitted++;
			body = page(omitted);
		}
		const shown = groups.reduce((total, group) => total + entryCount(group), 0);
		if (shown + omitted !== counts.total) {
			throw new Error(`release body shows ${shown} and omits ${omitted} entries, but ${counts.total} are counted`);
		}
	}
	return body;
}

/**
 * OTA `update-manifest.json` notes: the version heading, the counts line and
 * the categorized entries. The update dialog clamps to ~200 characters, so the
 * heading and the category breakdown must come first.
 */
export function buildUpdateNotes(section: ReleaseSection): string {
	const heading = section.date ? `## [${section.version}] - ${section.date}` : `## [${section.version}]`;
	const body = sectionBody(section);
	const blocks = [heading, formatReleaseSummary(countReleaseEntries(body))];
	if (body !== "") blocks.push(body);
	return `${blocks.join("\n\n")}\n`;
}

// --------------------------------------------------------------------------
// CLI

interface CliOptions {
	changelogPath: string;
	appPackagePath: string;
	version?: string;
	tag?: string;
	assetsTag?: string;
	repo: string;
	out: string;
	otaOut?: string;
	maxChars?: number;
}

function parseCharBudget(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`--max-chars must be a positive integer, got "${raw}"`);
	}
	return value;
}

function parseOptions(argv: string[]): CliOptions {
	const { values } = parseArgs({
		args: argv,
		options: {
			changelog: { type: "string" },
			"app-package": { type: "string" },
			version: { type: "string" },
			tag: { type: "string" },
			"assets-tag": { type: "string" },
			repo: { type: "string" },
			out: { type: "string" },
			"ota-out": { type: "string" },
			"max-chars": { type: "string" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) {
		console.log(
			[
				"Usage: bun scripts/render-release-notes.ts [options]",
				"  --changelog <path>     CHANGELOG.musepi.md to read",
				"  --app-package <path>   package.json carrying the app version",
				"  --version <x.y.z>      released version (default: --tag without its leading v, else the app package version)",
				"  --tag <tag>            release tag; must equal v<version> (default: v<version>)",
				"  --assets-tag <tag>     tag the assets are published under (default: --tag)",
				"  --repo <owner/name>    repository (default: MuseLinn/MusePi)",
				"  --out <path>           release body output (default: dist/RELEASE_NOTES.md)",
				"  --ota-out <path>       also write the update-manifest notes",
				"  --max-chars <n>        cap the page body at n characters, trimming whole entries (default: no cap)",
			].join("\n"),
		);
		process.exit(0);
	}
	return {
		changelogPath: values.changelog ?? CHANGELOG_PATH,
		appPackagePath: values["app-package"] ?? APP_PACKAGE_PATH,
		version: values.version,
		tag: values.tag,
		assetsTag: values["assets-tag"],
		repo: values.repo ?? DEFAULT_REPO,
		out: values.out ?? "dist/RELEASE_NOTES.md",
		otaOut: values["ota-out"],
		maxChars: parseCharBudget(values["max-chars"]),
	};
}

async function readAppVersion(packagePath: string): Promise<string> {
	const pkg = (await Bun.file(packagePath).json()) as { version?: unknown };
	if (typeof pkg.version !== "string" || pkg.version.trim() === "") {
		throw new Error(`no version in ${packagePath}`);
	}
	return pkg.version.trim();
}

async function main(): Promise<number> {
	try {
		const options = parseOptions(process.argv.slice(2));
		const { version, tag } = resolveReleaseVersion({
			version: options.version,
			tag: options.tag,
			packageVersion: await readAppVersion(options.appPackagePath),
		});
		const changelog = await Bun.file(options.changelogPath).text();
		const section = findReleaseSection(changelog, version);
		if (!section) throw new Error(`no \`## [${version}]\` section in the changelog`);
		const body = renderReleaseNotes({
			changelog,
			version,
			tag,
			assetsTag: options.assetsTag,
			repo: options.repo,
			maxChars: options.maxChars,
		});

		fs.mkdirSync(path.dirname(options.out), { recursive: true });
		fs.writeFileSync(options.out, body);
		console.log(
			`release-notes: ${version} → ${options.out} ` +
				`(${formatReleaseSummary(countReleaseEntries(sectionBody(section)))}, ${characterLength(body)} characters)`,
		);

		if (options.otaOut) {
			fs.mkdirSync(path.dirname(options.otaOut), { recursive: true });
			fs.writeFileSync(options.otaOut, buildUpdateNotes(section));
			console.log(`release-notes: OTA notes → ${options.otaOut}`);
		}
		return 0;
	} catch (error) {
		console.error(`render-release-notes: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

if (import.meta.main) {
	process.exit(await main());
}
