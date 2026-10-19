/**
 * 设置清单文案 i18n 门禁：schema 里的每个文案串，必须在两份词典里都有中文。
 *
 * 为什么需要它：`settings.schema` 是 GUI 与 TUI 同一个数据源，文案以**英文字符串**
 * 的形式写在 `settings-schema.ts` 里，渲染侧用 `t(label as TranslationKey)` 解析——
 * `as TranslationKey` 是类型断言，不是校验。于是三种漏译都不会被任何门禁发现：
 *
 *   1. 词典里根本没有这个键（新增设置项时最容易漏）；
 *   2. 键的大小写与 schema 不一致（`Show all` vs `show all`，永远匹配不上）；
 *   3. 只往一份词典里加了中文（GUI 读 client-core，TUI 读 coding-agent，两份都要）。
 *
 * 更隐蔽的是：`verify-client-ui-i18n.ts` 只扫描 `desktop-app/src` 与
 * `client-core/src`，schema 所在的 `coding-agent/src/config/` 不在它的视野里，
 * 而 schema 恰恰是文案的源头之一。
 *
 * 只检查会被 `t()` 消费的四处：ui.label / ui.description / options[].label /
 * options[].description（与 SchemaSettings 的实际调用点一一对应）。
 *
 * 用法：`bun scripts/verify-schema-labels-i18n.ts`
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseBabel } from "@babel/parser";
import type * as Babel from "@babel/types";

const root = path.resolve(import.meta.dirname, "..");
const BASELINE_PATH = path.resolve(import.meta.dirname, "verify-schema-labels-i18n-baseline.json");
const update = process.argv.includes("--update");
const SCHEMA = path.resolve(root, "packages/coding-agent/src/config/settings-schema.ts");

/** 两份词典都要齐：桌面读 client-core，终端读 coding-agent。 */
const DICTIONARIES = [
	{ label: "client-core (GUI)", dir: "packages/client-core/src/i18n/zh-CN" },
	{ label: "coding-agent (TUI)", dir: "packages/coding-agent/src/i18n/zh-CN" },
];

const KEY_LINE = /^\t("[^"]+"|[A-Za-z_$][\w$]*)\s*:\s*(.*)$/;

/** 每个词典域文件里的一级键 → 值首行（多行值时足以判定「是否仍是英文」）。 */
function readDictionary(dir: string): Map<string, string> {
	const keys = new Map<string, string>();
	const abs = path.resolve(root, dir);
	const files = readDirTs(abs);
	for (const file of files) {
		const text = fs.readFileSync(file, "utf8");
		const lines = text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const m = KEY_LINE.exec(lines[i]);
			if (!m) continue;
			const key = m[1].replace(/^"|"$/g, "");
			// A key may span two lines (value on the next line); take both.
			const value = m[2].trim().startsWith('"') ? m[2] : (lines[i + 1] ?? "");
			keys.set(key, value);
		}
	}
	return keys;
}

function readDirTs(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir)) {
		const abs = path.resolve(dir, entry);
		if (fs.statSync(abs).isDirectory()) out.push(...readDirTs(abs));
		else if (entry.endsWith(".ts") && entry !== "index.ts") out.push(abs);
	}
	return out;
}

/** Schema 里会被 t() 消费的字符串，按来源位置分组。 */
interface StringSite {
	text: string;
	kind: "label" | "description" | "option-label" | "option-description" | "group";
	key: string;
}

function collectSites(): StringSite[] {
	const source = fs.readFileSync(SCHEMA, "utf8");
	const ast = parseBabel(source, { sourceType: "module", plugins: ["typescript"] });
	const sites: StringSite[] = [];

	const literal = (node: Babel.Node | null | undefined): string | null => {
		if (!node) return null;
		if (node.type === "StringLiteral") return node.value;
		if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
			return node.quasis[0]?.value.cooked ?? null;
		}
		return null;
	};

	/** Nearest enclosing object property name — the setting key, or "ui"/"options". */
	const ownerName = (path: Babel.Node[]): string => {
		for (let i = path.length - 1; i >= 0; i--) {
			const node = path[i];
			if (node.type === "ObjectProperty" && node.key) {
				if (node.key.type === "StringLiteral") return node.key.value;
				if (node.key.type === "Identifier") return node.key.name;
			}
		}
		return "<unknown>";
	};

	/** The setting key: the outermost property whose value is the item object. */
	const settingKey = (path: Babel.Node[]): string => {
		for (let i = 0; i < path.length; i++) {
			const node = path[i];
			if (node.type === "ObjectProperty" && node.key) {
				if (node.key.type === "StringLiteral") return node.key.value;
				if (node.key.type === "Identifier") return node.key.name;
			}
		}
		return "<unknown>";
	};

	const walk = (node: Babel.Node, path: Babel.Node[]): void => {
		if (node.type === "ObjectExpression") {
			// An object is an OPTION object when the property it hangs from is
			// `options`; otherwise its label/description belong to the setting
			// itself. Matching any ancestor named "ui" misclassified every option
			// nested under ui.options as a plain setting label.
			const option = ownerName(path) === "options";
			const key = settingKey(path);
			for (const prop of node.properties) {
				if (prop.type !== "ObjectProperty" || !prop.key) continue;
				const name =
					prop.key.type === "Identifier" ? prop.key.name : prop.key.type === "StringLiteral" ? prop.key.value : "";
				if (name !== "label" && name !== "description") continue;
				const text = literal(prop.value);
				if (text === null || text.length === 0) continue;
				const kind: StringSite["kind"] = option
					? name === "label"
						? "option-label"
						: "option-description"
					: name === "label"
						? "label"
						: "description";
				sites.push({ text, kind, key });
			}
		}
		for (const key of Object.keys(node) as Array<keyof Babel.Node>) {
			if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
			const child = (node as unknown as Record<string, unknown>)[key as string];
			if (Array.isArray(child)) {
				for (const c of child)
					if (c && typeof c === "object" && "type" in c) walk(c as Babel.Node, [...path, node]);
			} else if (child && typeof child === "object" && "type" in (child as object)) {
				walk(child as Babel.Node, [...path, node]);
			}
		}
	};

	if (ast.type === "File") walk(ast.program as unknown as Babel.Node, []);
	return sites;
}

/** A translated entry must exist AND differ from the English source. */
function isTranslated(dict: Map<string, string>, text: string): "missing" | "untranslated" | "ok" {
	const value = dict.get(text);
	if (value === undefined) return "missing";
	// Value line holds either `"中文…",` or a continuation line; compare the
	// string content against the key to catch an identity mapping left in zh.
	const stripped = value.replace(/^"/, "").replace(/",?$/, "").replace(/",?$/g, "");
	if (stripped === text) return "untranslated";
	return "ok";
}

const sites = collectSites();
const dicts = DICTIONARIES.map(d => ({ ...d, keys: readDictionary(d.dir) }));

/** Every (dictionary, string) pair that is not yet translated. */
const outstanding: Array<{ dict: string; text: string; kind: string; key: string }> = [];
for (const dict of dicts) {
	for (const site of sites) {
		if (isTranslated(dict.keys, site.text) !== "ok") {
			outstanding.push({ dict: dict.label, text: site.text, kind: site.kind, key: site.key });
		}
	}
}

if (update) {
	const pairs = [...new Set(outstanding.map(o => `${o.dict}\u0000${o.text}`))].sort();
	fs.writeFileSync(
		BASELINE_PATH,
		`${JSON.stringify(
			{
				note: "Schema label/description strings that have no translation YET. Only shrink this list: a new entry means a new setting shipped untranslated.",
				count: pairs.length,
				pairs,
			},
			null,
			"\t",
		)}\n`,
	);
	console.log(`schema-labels-i18n: baseline written — ${pairs.length} outstanding pair(s)`);
	process.exit(0);
}

const baseline = fs.existsSync(BASELINE_PATH)
	? new Set<string>(JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")).pairs as string[])
	: new Set<string>();

// A string already in the baseline is known debt; anything else is a NEW
// untranslated string and fails. Stale baseline entries (since translated) are
// reported so the file shrinks as the debt is paid.
const fresh = outstanding.filter(o => !baseline.has(`${o.dict}\u0000${o.text}`));
const stillOutstanding = new Set(outstanding.map(o => `${o.dict}\u0000${o.text}`));
const stale = [...baseline].filter(p => !stillOutstanding.has(p));

if (fresh.length === 0) {
	console.log(
		`schema-labels-i18n: OK — ${sites.length} string(s) checked; ${stillOutstanding.size} known untranslated (baseline)${stale.length > 0 ? `, ${stale.length} baseline entr(ies) can be removed` : ""}`,
	);
	process.exit(0);
}

console.error(`schema-labels-i18n: ${fresh.length} NEW untranslated schema string(s)\n`);
const seen = new Set<string>();
for (const o of fresh) {
	if (seen.has(o.text)) continue;
	seen.add(o.text);
	console.error(`  [${o.dict}] (${o.kind} of ${o.key}) ${JSON.stringify(o.text)}`);
}
console.error("\nAdd these to BOTH dictionaries under their zh-CN entry, then run --update to re-baseline.");
process.exit(1);
