/**
 * Add the preview strings to both dictionaries. The GUI dictionary is
 * client-core's; the TUI has no file pane, so GUI only.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const root = process.cwd();
const apply = process.argv.includes("--apply");

const ENTRIES: Array<[string, string]> = [
	["settings.previewMediaUnplayable", "这个媒体文件无法播放：当前环境缺少对应的解码器。"],
	["settings.previewFontLoadFailed", "字体加载失败。"],
	["settings.previewFontSample", "预览字体：中文与 Latin 字符 AaBbGg 0123"],
];

const FILES = [
	{ file: path.resolve(root, "packages/client-core/src/i18n/zh-CN/settings.ts"), zh: true },
	{ file: path.resolve(root, "packages/client-core/src/i18n/en-US/settings.ts"), zh: false },
];

for (const { file, zh } of FILES) {
	let s = fs.readFileSync(file, "utf8");
	const add = ENTRIES.filter(([k]) => !s.includes(JSON.stringify(k) + ":")).map(([k, v]) => [k, zh ? v : k] as [string, string]);
	if (add.length === 0) {
		console.log(file.split("/").slice(-2).join("/") + ": already present");
		continue;
	}
	const topClose = s.lastIndexOf("} as const") >= 0 ? s.lastIndexOf("} as const") : s.lastIndexOf("}");
	const lineEnd = s.lastIndexOf("\n", topClose);
	const block = add.map(([k, v]) => "\t" + JSON.stringify(k) + ": " + JSON.stringify(v) + ",").join("\n") + "\n";
	s = s.slice(0, lineEnd) + block + s.slice(lineEnd);
	if (apply) fs.writeFileSync(file, s);
	console.log(file.split("/").slice(-2).join("/") + ": +" + add.length);
}
