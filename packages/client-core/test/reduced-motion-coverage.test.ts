import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 常驻无限动画的减少动效覆盖契约（体检报告 2026-11-17 §2.3）。
 *
 * `prefers-reduced-motion: reduce` 是移动端唯一生效的动效开关：`.gui-motion-off`
 * 只在桌面端由「动效开关」写入，Capacitor / 鸿蒙 WebView / 手机浏览器里恒不生效，
 * 所以无限动画只靠这个类兜底，在移动端会一直播放。
 *
 * 契约：两份 CSS 里每个声明了 `animation: … infinite` 的选择器，都要有一条
 * 位置更靠后、选择器文本完全相同的 reduce 规则写 `animation: none`。
 * 要求「完全相同」而不是「包含关系」：媒体查询不改变优先级，只有同选择器、
 * 同优先级且更靠后的规则才一定压得住原规则；这同时排除了「带 `.gui-motion-off`
 * 前缀的规则冒充覆盖」的假通过。
 *
 * bun 没有 CSS 引擎，所以这里静态解析规则本身，做法与
 * `shell-interaction-contract.test.ts` 一致。
 */

interface CssRule {
	selectors: string[];
	body: string;
	/** 所在 at-rule 的前导文本（顶层为空串），例如 `@media (prefers-reduced-motion: reduce)`。 */
	atRule: string;
	/** 规则 `{` 在文件里的字符偏移。 */
	offset: number;
}

const REDUCE_MEDIA = /prefers-reduced-motion\s*:\s*reduce/;
const INFINITE_ANIMATION = /\banimation(?:-iteration-count)?\s*:[^;{}]*\binfinite\b/;
const DISABLES_ANIMATION = /\banimation(?:-name)?\s*:\s*none\b/;

/** 注释替换为等长空白，保证字符偏移与行号仍对应原文件。 */
function stripComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, " "));
}

function normalizeSelector(selector: string): string {
	return selector.replace(/\s+/g, " ").trim();
}

function splitSelectors(head: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let current = "";
	for (const ch of head) {
		if (ch === "(") depth++;
		else if (ch === ")") depth = Math.max(0, depth - 1);
		if (ch === "," && depth === 0) {
			out.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	out.push(current);
	return out.map(normalizeSelector).filter(Boolean);
}

/** 从 `open` 处的 `{` 开始，返回配对 `}` 的下标。 */
function blockEnd(src: string, open: number): number {
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		const ch = src[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return src.length - 1;
}

const DECLARATION_ONLY_AT_RULE = /^@(-webkit-)?keyframes\b|^@font-face\b|^@property\b/;
const NESTING_AT_RULE = /^@(media|supports|layer|container|document)\b/;

function parseInto(src: string, base: number, atRule: string, out: CssRule[]): void {
	let i = 0;
	let prelude = "";
	while (i < src.length) {
		const ch = src[i]!;
		if (ch === "{") {
			const end = blockEnd(src, i);
			const body = src.slice(i + 1, end);
			const head = prelude.trim();
			prelude = "";
			if (DECLARATION_ONLY_AT_RULE.test(head)) {
				// @keyframes / @font-face 内部的关键帧选择器不是样式规则。
			} else if (NESTING_AT_RULE.test(head)) {
				parseInto(body, base + i + 1, atRule ? `${atRule} ${head}` : head, out);
			} else if (head) {
				out.push({ selectors: splitSelectors(head), body, atRule, offset: base + i });
			}
			i = end + 1;
			continue;
		}
		if (ch === "}" || ch === ";") {
			prelude = "";
			i++;
			continue;
		}
		prelude += ch;
		i++;
	}
}

function parseRules(css: string): CssRule[] {
	const out: CssRule[] = [];
	parseInto(stripComments(css), 0, "", out);
	return out;
}

function lineAt(css: string, offset: number): number {
	return css.slice(0, offset).split("\n").length;
}

const FILES = {
	"shell.css": path.resolve(import.meta.dir, "../src/components/shell/shell.css"),
	"transcript.css": path.resolve(import.meta.dir, "../src/components/transcript/transcript.css"),
} as const;

const CASES = Object.entries(FILES).map(([name, file]) => ({
	name,
	css: stripComments(fs.readFileSync(file, "utf8")),
	rules: parseRules(fs.readFileSync(file, "utf8")),
}));

describe("常驻无限动画在减少动效下停帧", () => {
	for (const { name, css, rules } of CASES) {
		test(`${name}: 每个 infinite 选择器都被一条更靠后的 reduce 规则关掉`, () => {
			const reduceEntries = rules.flatMap(rule =>
				REDUCE_MEDIA.test(rule.atRule) && DISABLES_ANIMATION.test(rule.body)
					? rule.selectors.map(selector => ({ selector, offset: rule.offset }))
					: [],
			);

			const infinite = rules.flatMap(rule =>
				!REDUCE_MEDIA.test(rule.atRule) && INFINITE_ANIMATION.test(rule.body)
					? rule.selectors.map(selector => ({ selector, offset: rule.offset }))
					: [],
			);

			// 解析器如果静默失效，下面的 every 会变成空集合上的永真断言。
			expect(infinite.length, `${name}: 没有解析到任何 infinite 动画，解析器或文件路径失效`).toBeGreaterThan(0);

			const missing = infinite
				.filter(
					item => !reduceEntries.some(entry => entry.selector === item.selector && entry.offset > item.offset),
				)
				.map(item => `${item.selector}  (${name}:${lineAt(css, item.offset)})`);

			expect(missing, `以下无限动画缺少更靠后的 prefers-reduced-motion: reduce 复位`).toEqual([]);
		});
	}
});
