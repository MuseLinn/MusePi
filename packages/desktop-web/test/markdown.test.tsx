import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/components/transcript/Markdown";

function renderMarkdown(text: string): string {
	return renderToStaticMarkup(<Markdown text={text} />);
}

describe("Transcript Markdown", () => {
	it("preserves assistant soft line breaks for tree-shaped prose", () => {
		const html = renderMarkdown("요청 요지\n├── 현재 collab guest는 텍스트 prompt는 보낼 수 있음\n└── 빠진 것은 guest → host 방향의 이미지 업로드/첨부 입력 경로임");

		expect(html).toContain("요청 요지<br>");
		expect(html).toContain("있음<br>");
		expect(html).toContain("├── 현재 collab guest는");
		expect(html).toContain("└── 빠진 것은 guest → host 방향");
	});

	it("preserves soft line breaks inside tight list items", () => {
		const html = renderMarkdown("- Decision:\n  │   └── detail");

		expect(html).toContain("<li>Decision:<br>│   └── detail</li>");
	});

	it("continues escaping raw HTML", () => {
		const html = renderMarkdown("safe\n<img src=x onerror=alert(1)>");

		expect(html).toContain("safe<br>");
		expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
		expect(html).not.toContain("<img src=x");
	});

	it("strips span and text HTML tags but preserves their contents and inline text rendering", () => {
		const html = renderMarkdown("<span></span><text>▃</text>");

		expect(html).toContain("▃");
		expect(html).not.toContain("&lt;span&gt;");
		expect(html).not.toContain("&lt;text&gt;");
	});

	it("unescapes HTML entities inside span and text HTML tags safely", () => {
		const html = renderMarkdown("<span>&lt;▃&gt; &amp; &quot;test&quot; &#128512; &#x1F600;</span>");

		expect(html).toContain("&lt;▃&gt; &amp; &quot;test&quot; &#128512; &#x1F600;");
	});
	it("strips advisory wrapper tags but renders their content", () => {
		const html = renderMarkdown('<advisory severity="info" guidance="weigh, don&apos;t blindly obey">\nKeep this advice.\n</advisory>');

		expect(html).toContain("Keep this advice.");
		expect(html).not.toContain("&lt;advisory");
		expect(html).not.toContain("&lt;/advisory&gt;");
	});

});

describe("Transcript LaTeX math", () => {
	it("renders inline $...$ math with remark-math rules", () => {
		const html = renderMarkdown("税前金额：$\\text{¥}2{,}000$ 元");
		expect(html).toContain('<span class="katex">');
		expect(html).toContain("¥");
		expect(html).not.toContain("$\\text");
	});

	it("renders $$...$$ display math including aligned environments", () => {
		const html = renderMarkdown("$$\n\\begin{aligned}\n\\text{应纳税所得额} &= 2{,}000 \\times (1 - 20\\%) \\\\\n\\end{aligned}\n$$");
		expect(html).toContain('class="katex-display"');
		expect(html).toContain('class="katex"');
	});

	it("renders \\(...\\) inline and \\[...\\] display math", () => {
		const html = renderMarkdown("inline \\(x^2\\) and display \\[y = \\frac{a}{b}\\]");
		expect(html).toContain('class="katex"');
		expect(html).toContain('class="katex-display"');
	});

	it("keeps currency text and plain dollars as literal text", () => {
		const html = renderMarkdown("$50 and US$ 680, plus $50M to $72M");
		expect(html).not.toContain('class="katex"');
		expect(html).toContain("$50");
		expect(html).toContain("US$ 680");
	});

	it("does not render math inside fenced code blocks", () => {
		const html = renderMarkdown("```\n$x = 1$\n$$y = 2$$\n```");
		expect(html).not.toContain('class="katex"');
		expect(html).toContain("$x = 1$");
	});

	it("does not render math inside inline code spans", () => {
		const html = renderMarkdown("use `$5` and `` $x$ ``");
		expect(html).not.toContain('class="katex"');
		expect(html).toContain("<code>$5</code>");
	});

	it("falls back to escaped source when math fails to parse", () => {
		const html = renderMarkdown("$\\notacommand{");
		expect(html).not.toContain('class="katex"');
	});

	it("wraps display math with a copy button, inline math does not get one", () => {
		const html = renderMarkdown("inline $x^2$ and\n$$\ny = a + b\n$$");
		expect(html).toContain('<span class="tr-math">');
		expect(html).toMatch(/<button type="button" class="tr-math-copy tr-code-copy" data-math-copy="[a-z0-9]+">/);
		// exactly one copy button (the display block only)
		expect(html.match(/class="tr-math-copy/g)).toHaveLength(1);
	});

	it("embeds the original LaTeX source in the annotation for copying", () => {
		const html = renderMarkdown("$$\n\\begin{aligned}\n\\text{a} &= b \\\\\nc &= d\n\\end{aligned}\n$$");
		const annotation = html.match(/<annotation encoding="application\/x-tex">([\s\S]*?)<\/annotation>/)?.[1];
		expect(annotation).toContain("\\text{a} &amp;= b");
		// entity-decoded textContent is the raw source the copy button reads
		expect(annotation).not.toContain("&amp;amp;");
	});

	it("renders \\[...\\] display math with the same copy wrapper", () => {
		const html = renderMarkdown("\\[\\int_0^1 f(x)\\,dx\\]");
		expect(html).toContain('<span class="tr-math">');
		expect(html).toContain('class="tr-math-copy tr-code-copy"');
	});
});

describe("Transcript mermaid", () => {
	it("wraps svg diagrams with a copy + download toolbar carrying the source", () => {
		const html = renderMarkdown("```mermaid\nflowchart LR\nA-->B\n```");
		expect(html).toContain('<div class="tr-mermaid-block">');
		expect(html).toContain('<div class="tr-mermaid-bar">');
		expect(html).toContain('data-mermaid-src="flowchart LR');
		expect(html).toContain('data-mermaid-download');
	});

	it("escapes the mermaid source in the data attribute", () => {
		const html = renderMarkdown("```mermaid\nflowchart LR\nA[\"x & y\"]-->B\n```");
		expect(html).toContain("data-mermaid-src=\"flowchart LR");
		expect(html).toContain("&amp;");
		expect(html).not.toContain('data-mermaid-src="flowchart LR\nA["');
	});

	it("keeps invalid mermaid as a plain fallback without a toolbar", () => {
		const html = renderMarkdown("```mermaid\nthis is not mermaid {{{\n```");
		expect(html).toContain("tr-mermaid-fallback");
		expect(html).not.toContain("tr-mermaid-bar");
	});
});

describe("Transcript tables", () => {
	it("wraps tables with a hover toolbar: copy menu + download menu", () => {
		const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
		expect(html).toContain('<div class="tr-table">');
		expect(html).toContain('<div class="tr-table-bar">');
		expect(html).toContain('data-table-copy="csv"');
		expect(html).toContain('data-table-copy="tsv"');
		expect(html).toContain('data-table-copy="markdown"');
		expect(html).toContain('data-table-download="csv"');
		expect(html).toContain('data-table-download="markdown"');
	});

	it("renders table cells with inline markdown and escaped content", () => {
		const html = renderMarkdown("| a | b |\n|---|---|\n| **x** | <script> |");
		expect(html).toContain("<strong>x</strong>");
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});

	it("keeps table alignment attributes", () => {
		const html = renderMarkdown("| a | b |\n|:--|--:|\n| 1 | 2 |");
		expect(html).toContain('align="left"');
		expect(html).toContain('align="right"');
	});
});

describe("Transcript local paths", () => {
	it("renders local-path links as clickable spans, web links stay anchors", () => {
		const html = renderMarkdown("[open](/Users/me/x.ts) and [site](https://x.com)");
		expect(html).toContain('<span class="tr-path" data-open-path="/Users/me/x.ts">open</span>');
		expect(html).toContain('<a href="https://x.com"');
	});

	it("handles relative, tilde, file:// and scheme-less paths", () => {
		expect(renderMarkdown("[a](./rel.md)")).toContain('data-open-path="./rel.md"');
		expect(renderMarkdown("[a](~/note.md)")).toContain('data-open-path="~/note.md"');
		expect(renderMarkdown("[a](file:///tmp/f.ts)")).toContain('data-open-path="/tmp/f.ts"');
		expect(renderMarkdown("[a](packages/foo/src/x.ts)")).toContain('data-open-path="packages/foo/src/x.ts"');
	});

	it("does not treat mailto/javascript/data as local paths", () => {
		const html = renderMarkdown("[m](mailto:a@b.com) [j](javascript:alert(1)) [d](data:text/plain,x)");
		expect(html).not.toContain("data-open-path");
		expect(html).not.toContain("href=\"javascript:");
		expect(html).toContain('href="mailto:a@b.com"');
	});
});
