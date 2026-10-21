/**
 * Repair the coding-agent dictionary collisions where two distinct source keys
 * slugged to the same identifier: "(Recommended)" and "text" both landed on
 * tools.text, and the suffix pass assigned "(Recommended)" → tools.text while
 * "text" → tools.text2. The ask-dialog renders "(Recommended)" via the first —
 * which shows "（推荐）" correctly — but the mapping table now says tools.text
 * for BOTH, so ask-dialog's suffix renders the raw-text label instead.
 *
 * The fix: "(Recommended)" gets its own namespaced key tools.recommended, and
 * the TUI call site follows.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const apply = process.argv.includes("--apply");
const root = process.cwd();

const DICT = path.resolve(root, "packages/coding-agent/src/i18n/zh-CN/tools.ts");
const DICT_EN_NOTE = "packages/coding-agent/src/i18n/zh-CN/tools.ts"; // zh only
const CALLSITE = path.resolve(root, "packages/coding-agent/src/modes/components/ask-dialog.ts");

// 1. Dictionary: add tools.recommended beside the colliding pair.
let dict = fs.readFileSync(DICT, "utf8");
if (!dict.includes('"tools.recommended"')) {
	const anchor = '"tools.text": "（推荐）",';
	if (!dict.includes(anchor)) {
		console.log("dict anchor missing — inspect manually");
		process.exit(1);
	}
	const line = '\t"tools.recommended": "（推荐）",\n';
	dict = dict.replace(
		anchor,
		`${anchor}\n${line.trimEnd()}` !== ""
			? dict.replace(anchor, dict.includes(line) ? anchor : `${anchor}\n${line.replace(/\n$/, "")}`)
			: dict,
	);
	// simpler: plain insertion
	dict = fs.readFileSync(DICT, "utf8");
	const at = dict.indexOf(anchor) + anchor.length;
	dict = `${dict.slice(0, at)}\n\t"tools.recommended": "（推荐）",${dict.slice(at)}`;
	if (apply) fs.writeFileSync(DICT, dict);
	console.log("dict: tools.recommended added");
}

// 2. Call site: the suffix is the "(Recommended)" label, not the raw "text" one.
let src = fs.readFileSync(CALLSITE, "utf8");
const wrong = 't("tools.text")';
const right = 't("tools.recommended")';
if (src.includes(wrong)) {
	src = src.split(wrong).join(right);
	if (apply) fs.writeFileSync(CALLSITE, src);
	console.log("callsite: tools.text → tools.recommended");
} else {
	console.log("callsite: already correct");
}
