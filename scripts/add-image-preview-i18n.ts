/**
 * The image preview's control labels — GUI-only, so client-core's dictionary.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const root = process.cwd();
const apply = process.argv.includes("--apply");

const ENTRIES: Array<[string, string]> = [
	["settings.previewImageZoomOut", "缩小"],
	["settings.previewImageZoomIn", "放大"],
	["settings.previewImageActualSize", "实际大小"],
	["settings.previewImageFit", "适应窗口"],
	["settings.previewImageExpand", "全屏查看"],
];

const FILES = [
	{ file: path.resolve(root, "packages/client-core/src/i18n/zh-CN/settings.ts"), zh: true },
	{ file: path.resolve(root, "packages/client-core/src/i18n/en-US/settings.ts"), zh: false },
];

for (const { file, zh } of FILES) {
	let s = fs.readFileSync(file, "utf8");
	const add = ENTRIES.filter(([k]) => !s.includes(`${JSON.stringify(k)}:`)).map(
		([k, v]) => [k, zh ? v : k] as [string, string],
	);
	if (add.length === 0) {
		console.log(`${file.split("/").slice(-2).join("/")}: already present`);
		continue;
	}
	const topClose = s.lastIndexOf("} as const") >= 0 ? s.lastIndexOf("} as const") : s.lastIndexOf("}");
	const lineEnd = s.lastIndexOf("\n", topClose);
	const block = `${add.map(([k, v]) => `\t${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n")}\n`;
	s = s.slice(0, lineEnd) + block + s.slice(lineEnd);
	if (apply) fs.writeFileSync(file, s);
	console.log(`${file.split("/").slice(-2).join("/")}: +${add.length}`);
}
