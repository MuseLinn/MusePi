/**
 * Batch 7 apply: these strings are NOT in the settings-schema gate baseline —
 * they live in component data objects the schema gate doesn't scan. Write them
 * directly: client-core settings.ts (GUI barrel), coding-agent settings.ts
 * (TUI), plus the en identities in client-core en-US.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const root = process.cwd();
const apply = process.argv.includes("--apply");

const TRANSLATIONS: Record<string, string> = {
	context: "上下文",
	files: "文件",
	artifacts: "产物",
	trajectory: "轨迹",
	jobs: "任务",
	git: "Git",
	notes: "笔记",
	browser: "浏览器",
	agents: "子代理",
	widget: "组件",
	board: "看板",
	"surface description context": "会话上下文与回合流",
	"surface description files": "工作区文件树与编辑",
	"surface description artifacts": "本轮产生的文件产物",
	"surface description trajectory": "回合与事件的轨迹视图",
	"surface description jobs": "后台任务与投递状态",
	"surface description git": "工作区变更与提交历史",
	"surface description notes": "项目知识：笔记、待办与计划",
	"surface description browser": "托管浏览器与会话标签页",
	"surface description agents": "子代理运行状态与产物",
	"surface description widget": "组件卡片预览与挂件",
	"project knowledge": "项目知识",
	"scheduled cron ex every5": "每 5 分钟",
	"scheduled cron ex hourly": "每小时",
	"scheduled cron ex monday9": "周一 9 点",
	"scheduled cron ex 9and17": "每天 9 点与 17 点",
	"scheduled cron ex month1": "每月 1 号",
	"workspace changes": "工作区变更",
	"commit history": "提交历史",
	"pull requests": "拉取请求",
	"widget pomodoro focus": "专注时长",
	"widget pomodoro short": "短休息",
	"widget pomodoro long": "长休息",
	"widget noise": "噪声强度",
	"widget jitter": "抖动",
	"widget frequency": "频率",
	"widget amplitude": "振幅",
	"voice engine auto": "语音引擎：自动",
	"voice engine daemon": "语音引擎：守护进程",
	"voice engine native": "语音引擎：系统原生",
	"voice input lang auto": "输入语言：自动",
	"Multilingual · default": "多语言 · 默认",
	"SoTA · EN/EU only": "效果最佳 · 仅英/欧语",
	"Chinese-optimized · zh/en": "中文优化 · 中/英",
	"Copy current line": "复制当前行",
	"Copy whole prompt": "复制整条提示词",
	"Move cursor to end of message": "光标移到消息末尾",
	"Move cursor to beginning of message": "光标移到消息开头",
	"Move cursor to beginning of line": "光标移到行首",
	"Move cursor to end of line": "光标移到行尾",
	"Current message": "当前消息",
	"Bot token": "Bot 令牌",
	"Token (optional — QR login if empty)": "令牌（可选——留空用二维码登录）",
	"Bot token (from @BotFather)": "Bot 令牌（来自 @BotFather）",
	"App ID": "App ID",
	"App Secret": "App Secret",
	"inherit provider protocol": "继承供应商协议",
	"Chat Completions (/chat/completions)": "Chat Completions（/chat/completions）",
	"Responses (/responses)": "Responses（/responses）",
	"Anthropic Messages (/messages)": "Anthropic Messages（/messages）",
	"Google Generative AI": "Google Generative AI",
	"openai responses": "openai responses",
};

/** TUI-only keys (coding-agent components render them; GUI doesn't). */
const TUI_ONLY = new Set([
	"Copy current line",
	"Copy whole prompt",
	"Move cursor to end of message",
	"Move cursor to beginning of message",
	"Move cursor to beginning of line",
	"Move cursor to end of line",
	"Current message",
]);
/** GUI-only keys (desktop components; TUI has its own settings surface). */
const GUI_ONLY = new Set([
	"scheduled cron ex every5",
	"scheduled cron ex hourly",
	"scheduled cron ex monday9",
	"scheduled cron ex 9and17",
	"scheduled cron ex month1",
	"workspace changes",
	"commit history",
	"pull requests",
	"widget pomodoro focus",
	"widget pomodoro short",
	"widget pomodoro long",
	"widget noise",
	"widget jitter",
	"widget frequency",
	"widget amplitude",
	"voice engine auto",
	"voice engine daemon",
	"voice engine native",
	"voice input lang auto",
	"Multilingual · default",
	"SoTA · EN/EU only",
	"Chinese-optimized · zh/en",
	"Bot token",
	"Token (optional — QR login if empty)",
	"Bot token (from @BotFather)",
	"App ID",
	"App Secret",
	"inherit provider protocol",
	"Chat Completions (/chat/completions)",
	"Responses (/responses)",
	"Anthropic Messages (/messages)",
	"Google Generative AI",
	"openai responses",
]);

function insert(text: string, entries: Array<[string, string]>): string {
	const topClose = text.lastIndexOf("} as const") >= 0 ? text.lastIndexOf("} as const") : text.lastIndexOf("}");
	const lineEnd = text.lastIndexOf("\n", topClose);
	const block = `${entries.map(([k, v]) => `\t${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n")}\n`;
	return text.slice(0, lineEnd) + block + text.slice(lineEnd);
}
function existingKeys(file: string): Set<string> {
	const keys = new Set<string>();
	const KEY = /^\t(["'])(.+?)\1\s*:/;
	for (const l of fs.readFileSync(file, "utf8").split("\n")) {
		const m = KEY.exec(l);
		if (m) keys.add(m[2].replace(/\\'/g, "'").replace(/\\"/g, '"'));
	}
	return keys;
}

const GUI_ZH = path.resolve(root, "packages/client-core/src/i18n/zh-CN/settings.ts");
const GUI_EN = path.resolve(root, "packages/client-core/src/i18n/en-US/settings.ts");
const TUI_ZH = path.resolve(root, "packages/coding-agent/src/i18n/zh-CN/settings.ts");

const guiEntries: Array<[string, string]> = [];
const tuiEntries: Array<[string, string]> = [];
for (const [k, v] of Object.entries(TRANSLATIONS)) {
	const guiOnly = GUI_ONLY.has(k);
	const tuiOnly = TUI_ONLY.has(k);
	if (!tuiOnly) guiEntries.push([k, v]);
	if (!guiOnly) tuiEntries.push([k, v]);
}

if (apply) {
	const guiKeys = existingKeys(GUI_ZH);
	const guiAdd = guiEntries.filter(([k]) => !guiKeys.has(k));
	if (guiAdd.length > 0) fs.writeFileSync(GUI_ZH, insert(fs.readFileSync(GUI_ZH, "utf8"), guiAdd));
	const enKeys = existingKeys(GUI_EN);
	const enAdd = guiEntries.filter(([k]) => !enKeys.has(k)).map(([k]) => [k, k] as [string, string]);
	if (enAdd.length > 0) fs.writeFileSync(GUI_EN, insert(fs.readFileSync(GUI_EN, "utf8"), enAdd));
	const tuiKeys = existingKeys(TUI_ZH);
	const tuiAdd = tuiEntries.filter(([k]) => !tuiKeys.has(k));
	if (tuiAdd.length > 0) fs.writeFileSync(TUI_ZH, insert(fs.readFileSync(TUI_ZH, "utf8"), tuiAdd));
	console.log(`written: GUI zh +${guiAdd.length}, GUI en +${enAdd.length}, TUI zh +${tuiAdd.length}`);
} else {
	console.log(`planned: GUI ${guiEntries.length}, TUI ${tuiEntries.length} (dry run)`);
}
