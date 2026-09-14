import { describe, expect, it } from "bun:test";
import { inlineMarkersBalanced, renderStreamingMarkdown } from "../src/components/transcript/Markdown";

/**
 * Streaming-tail rendering contract (显示错位 fix): while a message
 * streams, the not-yet-settled tail is RAW PLAIN TEXT (returned in the
 * `tail` field for the caller's incremental per-char DOM) — never
 * partial markdown — so closing a fence/table/list cannot re-parse the
 * same region from a code block to text and jump the layout. Completed
 * head blocks stay markdown (reused verbatim); the full markdown renders
 * once on settle (html contains no tail field then).
 */
describe("renderStreamingMarkdown", () => {
	it("renders the settled text as full markdown (fence becomes a code block)", () => {
		const text = "说明\n\n```ts\nconst x = 1;\n```\n\n完毕";
		const { html, tail } = renderStreamingMarkdown(text, false, null);
		expect(html).toContain('<div class="tr-code">');
		expect(tail).toBeNull();
		expect(html).toContain("const x = 1;");
	});

	it("keeps an open fence literal in the streaming tail (never a code block)", () => {
		const { html, tail } = renderStreamingMarkdown("说明\n\n```ts\nconst x = 1;\n", true, null);
		expect(html).not.toContain('<div class="tr-code">');
		// The tail is raw text returned separately; the head is just the
		// completed "说明" paragraph.
		expect(tail).toBe("```ts\nconst x = 1;\n");
		expect(html).toContain("<p>说明</p>");
	});

	it("promotes a code block the moment its fence closes while streaming", () => {
		const first = renderStreamingMarkdown("说明\n\n```ts\nconst x = 1;\n", true, null);
		// An OPEN fence stays literal — the region after the last balanced
		// boundary is the plain text the per-character spans need.
		expect(first.tail).toBe("```ts\nconst x = 1;\n");
		expect(first.html).not.toContain('<div class="tr-code">');

		// The fence closes and a blank line completes the block, so it is
		// promoted to markdown NOW instead of at settle: code takes shape while
		// the message streams, which is the point of promoting per frame. Only
		// the still-unsettled region stays plain.
		const second = renderStreamingMarkdown("说明\n\n```ts\nconst x = 1;\n```\n\n完毕", true, first.state);
		expect(second.html).toContain('<div class="tr-code">');
		expect(second.html).toContain("const x = 1;");
		expect(second.html).toContain("<p>说明</p>");
		expect(second.tail).toBe("完毕");
	});

	it("promotes each paragraph as it completes, leaving only the last one plain", () => {
		const first = renderStreamingMarkdown("甲", true, null);
		expect(first.tail).toBe("甲");

		const second = renderStreamingMarkdown("甲\n\n乙", true, first.state);
		expect(second.html).toContain("<p>甲</p>");
		expect(second.tail).toBe("乙");
	});

	it("returns the plain-text tail raw (the caller appends it as text nodes)", () => {
		const { html, tail } = renderStreamingMarkdown("<img src=x onerror=alert(1)>", true, null);
		// Raw tail — the incremental DOM pass appends via textContent, so no
		// escaping is needed here (and no markup can execute).
		expect(tail).toBe("<img src=x onerror=alert(1)>");
		expect(html).toBe("");
	});

	it("renders settled head blocks as markdown, only the growing tail as plain text", () => {
		const first = renderStreamingMarkdown("第一段\n\n第二段\n\n第三段开", true, null);
		const second = renderStreamingMarkdown("第一段\n\n第二段\n\n第三段开始更多", true, first.state);
		expect(second.html).toContain("<p>第一段</p>");
		expect(second.html).toContain("<p>第二段</p>");
		expect(second.tail).toBe("第三段开始更多");
	});

	it("reuses head blocks verbatim across appends (no re-parse of settled text)", () => {
		const first = renderStreamingMarkdown("甲\n\n乙\n\n丙", true, null);
		const second = renderStreamingMarkdown("甲\n\n乙\n\n丙丁", true, first.state);
		// Settled head blocks stay markdown and identical; the grown tail is
		// plain text (never a re-parsed "<p>丙</p>").
		expect(second.html).toContain("<p>甲</p>");
		expect(second.html).toContain("<p>乙</p>");
		expect(second.html).not.toContain("<p>丙</p>");
		expect(second.tail).toBe("丙丁");
	});

	it("settles by reusing head blocks and parsing only the tail once", () => {
		const first = renderStreamingMarkdown("甲\n\n乙\n\n丙", true, null);
		const settled = renderStreamingMarkdown("甲\n\n乙\n\n丙", false, first.state);
		expect(settled.html).toContain("<p>甲</p>");
		expect(settled.html).toContain("<p>乙</p>");
		expect(settled.html).toContain("<p>丙</p>");
		expect(settled.tail).toBeNull();
	});

	it("promotes a prose line at a SINGLE newline while streaming (weak boundary)", () => {
		// The common Chinese-model case: prose with no blank lines. Without
		// weak boundaries the whole message stays raw text until settle.
		const first = renderStreamingMarkdown("第一行", true, null);
		expect(first.tail).toBe("第一行");

		const second = renderStreamingMarkdown("第一行\n第二行", true, first.state);
		expect(second.html).toContain("<p>第一行</p>");
		expect(second.tail).toBe("第二行");

		const third = renderStreamingMarkdown("第一行\n第二行\n第三行", true, second.state);
		expect(third.html).toContain("<p>第一行</p>");
		expect(third.html).toContain("<p>第二行</p>");
		expect(third.tail).toBe("第三行");
	});

	it("renders a list line-by-line as it streams (weak boundaries)", () => {
		const first = renderStreamingMarkdown("- 甲", true, null);
		const second = renderStreamingMarkdown("- 甲\n- 乙", true, first.state);
		expect(second.html).toContain("<li>甲</li>");
		expect(second.tail).toBe("- 乙");
	});

	it("does NOT cut at a newline while emphasis is still open", () => {
		const first = renderStreamingMarkdown("这是 **加粗", true, null);
		const second = renderStreamingMarkdown("这是 **加粗\n第二行", true, first.state);
		// The ** run is unpaired, so the single \n is not a safe cut: the whole
		// region stays raw text rather than shipping half an emphasis.
		expect(second.html).not.toContain("<p>这是");
		expect(second.tail).toBe("这是 **加粗\n第二行");

		// Emphasis closes mid-line → the NEXT newline becomes a safe cut again.
		const third = renderStreamingMarkdown("这是 **加粗**\n第二行", true, second.state);
		expect(third.html).toContain("<strong>加粗</strong>");
		expect(third.tail).toBe("第二行");
	});

	it("does NOT cut at a newline inside an open inline code span", () => {
		const first = renderStreamingMarkdown("见 `code", true, null);
		const second = renderStreamingMarkdown("见 `code\n续", true, first.state);
		expect(second.html).not.toContain("<code>");
		expect(second.tail).toBe("见 `code\n续");
	});

	it("merges a soft-wrapped paragraph on settle (weak blocks are not kept)", () => {
		// Streaming showed two <p>s across the weak cut; the settled layout
		// must equal a fresh parse (what a reload shows).
		const first = renderStreamingMarkdown("甲\n乙", true, null);
		expect(first.html).toContain("<p>甲</p>");
		const settled = renderStreamingMarkdown("甲\n乙", false, first.state);
		expect(settled.html).toContain("<p>甲<br>乙</p>");
		expect(settled.tail).toBeNull();
	});

	it("re-parses from the first weak block on settle so strong blocks after it are context-correct", () => {
		// 甲\n乙 is one soft-wrapped paragraph; a strong boundary follows. The
		// strong block was parsed as "<p>乙</p>" during streaming (its context
		// starts at the weak cut), so settle must re-parse from the weak cut,
		// not just drop the tail weak block.
		const first = renderStreamingMarkdown("甲\n乙\n\n丙", true, null);
		expect(first.html).toContain("<p>甲</p>");
		expect(first.html).toContain("<p>乙</p>");
		const settled = renderStreamingMarkdown("甲\n乙\n\n丙", false, first.state);
		expect(settled.html).toContain("<p>甲<br>乙</p>");
		expect(settled.html).toContain("<p>丙</p>");
		expect(settled.html).not.toContain("<p>乙</p>");
	});
});

describe("inlineMarkersBalanced", () => {
	it("pairs simple emphasis runs", () => {
		expect(inlineMarkersBalanced("")).toBe(true);
		expect(inlineMarkersBalanced("纯文本")).toBe(true);
		expect(inlineMarkersBalanced("*em*")).toBe(true);
		expect(inlineMarkersBalanced("**bold**")).toBe(true);
		expect(inlineMarkersBalanced("***both***")).toBe(true);
		expect(inlineMarkersBalanced("_em_")).toBe(true);
	});
	it("rejects an unclosed emphasis run", () => {
		expect(inlineMarkersBalanced("**bold")).toBe(false);
		expect(inlineMarkersBalanced("*em")).toBe(false);
		expect(inlineMarkersBalanced("文字 **加粗")).toBe(false);
	});
	it("rejects an unclosed inline code span", () => {
		expect(inlineMarkersBalanced("`code")).toBe(false);
		expect(inlineMarkersBalanced("`code\n续")).toBe(false);
		expect(inlineMarkersBalanced("`a` and `b")).toBe(false);
	});
	it("rejects an unclosed link", () => {
		expect(inlineMarkersBalanced("[x")).toBe(false);
		expect(inlineMarkersBalanced("[x](y")).toBe(false);
		expect(inlineMarkersBalanced("[x](y)")).toBe(true);
	});
	it("ignores escaped markers", () => {
		expect(inlineMarkersBalanced("a\\*b")).toBe(true);
		expect(inlineMarkersBalanced("\\*未闭合")).toBe(true);
	});
});
