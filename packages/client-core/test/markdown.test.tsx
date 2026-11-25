import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, markdownCodeBlock, renderStreamingMarkdown } from "../src/components/transcript/Markdown";
import {
	diagramBlockSource,
	mermaidFallbackHtml,
	namesDiagramType,
	renderDiagramSync,
} from "../src/components/transcript/mermaid";
import { t } from "../src/i18n/index.js";

function renderMarkdown(text: string): string {
	return renderToStaticMarkup(<Markdown text={text} />);
}

describe("Transcript Markdown", () => {
	it("preserves assistant soft line breaks for tree-shaped prose", () => {
		const html = renderMarkdown(
			"요청 요지\n├── 현재 collab guest는 텍스트 prompt는 보낼 수 있음\n└── 빠진 것은 guest → host 방향의 이미지 업로드/첨부 입력 경로임",
		);

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
		const html = renderMarkdown(
			'<advisory severity="info" guidance="weigh, don&apos;t blindly obey">\nKeep this advice.\n</advisory>',
		);

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
		const html = renderMarkdown(
			"$$\n\\begin{aligned}\n\\text{应纳税所得额} &= 2{,}000 \\times (1 - 20\\%) \\\\\n\\end{aligned}\n$$",
		);
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
		const text = "```\n$x = 1$\n$$y = 2$$\n```";
		const html = renderStreamingMarkdown(text, false, null, {}).html;
		const hash = /data-code-block="([^"]+)"/.exec(html)?.[1];
		// The block draws the raw source: math extensions never see fence text.
		const payload = markdownCodeBlock(hash!);
		expect(payload?.code).toContain("$x = 1$");
		expect(payload?.code).toContain("$$y = 2$$");
		expect(html).not.toContain('class="katex"');
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

	it("wraps display math with a copy control, inline math does not get one", () => {
		const display = renderMarkdown("inline $x^2$ and\n$$\ny = a + b\n$$");
		expect(display).toContain('<span class="tr-math">');
		expect(display).toContain("katex-display");
		// Exactly one copy control: display math only.
		expect(display.match(/tr-math-copy/g)).toHaveLength(1);
	});

	it("embeds the original LaTeX source in the annotation for copying", () => {
		const html = renderMarkdown("$$\n\\begin{aligned}\n\\text{a} &= b \\\\\nc &= d\n\\end{aligned}\n$$");
		const annotation = html.match(/<annotation encoding="application\/x-tex">([\s\S]*?)<\/annotation>/)?.[1];
		expect(annotation).toContain("\\text{a} &amp;= b");
		// entity-decoded textContent is the raw source the copy button reads
		expect(annotation).not.toContain("&amp;amp;");
	});

	it("renders \\[...\\] display math through the same wrapper", () => {
		const html = renderMarkdown("\\[\\int_0^1 f(x)\\,dx\\]");
		expect(html).toContain('<span class="tr-math">');
	});

	it("hands a fenced block to its React block with its language and source", () => {
		const text = "```ts\nconst x = 1;\n```";
		const html = renderStreamingMarkdown(text, false, null, {}).html;
		const hash = /data-code-block="([^"]+)"/.exec(html)?.[1];
		expect(hash).toBeTruthy();
		const payload = markdownCodeBlock(hash!);
		expect(payload?.lang).toBe("ts");
		expect(payload?.label).toBe("TypeScript");
		expect(payload?.code).toContain("const x = 1;");
		// The block draws the header and <pre><code>; the renderer leaves only a
		// placeholder, which is what keeps the finished block across a tick.
		expect(html).not.toContain("<pre>");
	});

	it("labels an unlabelled fence with the localized plain-text label", () => {
		const text = "```\nplain\n```";
		const html = renderStreamingMarkdown(text, false, null, {}).html;
		const hash = /data-code-block="([^"]+)"/.exec(html)?.[1];
		expect(markdownCodeBlock(hash!)?.label).toBe(t("settings.plainText"));
	});
});

describe("Transcript mermaid", () => {
	it("hands a diagram to its block with the fenced source", () => {
		const text = "```mermaid\nflowchart LR\nA-->B\n```";
		const html = renderStreamingMarkdown(text, false, null, {}).html;
		const hash = /data-diagram-block="([^"]+)"/.exec(html)?.[1];
		expect(hash).toBeTruthy();
		const stored = diagramBlockSource(hash!);
		expect(stored?.source).toContain("flowchart LR");
		expect(stored?.mode).toBe("svg");
	});

	it("draws the diagram synchronously when the sync renderer covers it", () => {
		const sync = renderDiagramSync("flowchart LR\nA-->B");
		expect(sync.usable).toBe(true);
		expect(sync.svg).toContain("<svg");
	});

	it("recognizes a fence that names no diagram type", () => {
		// A mermaid fence full of prose is a plain code block, not a diagram
		// that failed to draw.
		expect(namesDiagramType("this is not mermaid {{{")).toBe(false);
		expect(namesDiagramType("gantt" + "\n" + "title A")).toBe(true);
	});

	it("keeps an unrenderable diagram as a plain fallback", () => {
		const fallback = mermaidFallbackHtml("x --> y");
		expect(fallback).toContain("tr-mermaid-fallback");
		expect(fallback).toContain("language-mermaid");
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
		expect(html).not.toContain('href="javascript:');
		expect(html).toContain('href="mailto:a@b.com"');
	});
});
