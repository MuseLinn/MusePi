import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 关闭的折叠槽位不贡献任何流内高度（fold-slot-gap）。
 *
 * 隐藏行保持挂载在 `.tr-fold-slot` 里：显式轨道 `minmax(0, 0fr)` 只压住第一个
 * 子元素，槽位里还挂着第二个子元素（运行中裁剪的「+N 行」提示跟着它那一行）
 * 时会落进隐式行；隐式行默认 `auto`，按内容高度撑开槽位，折叠头与回复之间就
 * 多出一条空白。关闭态必须把隐式行也压到 0，展开态再还原自然高度。
 *
 * bun 没有 CSS 引擎，这里静态解析规则文本（与 `reduced-motion-coverage.test.ts`
 * 同一做法）。
 */

const cssPath = path.resolve(import.meta.dir, "../src/components/transcript/transcript.css");
const css = fs.readFileSync(cssPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, " "));

function ruleBody(selector: string): string {
	const head = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`);
	const match = head.exec(css);
	if (!match) throw new Error(`rule not found: ${selector}`);
	let depth = 0;
	const open = match.index + match[0].length - 1;
	for (let i = open; i < css.length; i++) {
		if (css[i] === "{") depth++;
		else if (css[i] === "}") {
			depth--;
			if (depth === 0) return css.slice(open + 1, i);
		}
	}
	throw new Error(`unterminated rule: ${selector}`);
}

describe("关闭的折叠槽位不贡献流内高度", () => {
	test("关闭态连隐式行一起压到 0", () => {
		const closed = ruleBody(".tr-fold-slot");
		expect(closed).toMatch(/grid-template-rows:\s*minmax\(0,\s*0fr\)/);
		expect(closed).toMatch(/grid-auto-rows:\s*0\b/);
		expect(closed).toMatch(/overflow:\s*hidden/);
	});

	test("展开态保留自然行高，开合动画轨道不变", () => {
		const open = ruleBody(".tr-fold-slot--open");
		expect(open).toMatch(/grid-template-rows:\s*minmax\(0,\s*1fr\)/);
		expect(open).toMatch(/grid-auto-rows:\s*auto\b/);
	});
});
