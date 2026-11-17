import { describe, expect, test } from "bun:test";
import { parseUiBlock, uiBlockSignatures } from "./catalog";
import { isUiBlockLanguage, renderUiBlock, renderUiBlockFence } from "./render";

/** Blocks are OpenUI Lang: `name = Component(args)`, the first line `root = …`. */

describe("ui block languages", () => {
	test("accepts the fence names models reach for", () => {
		for (const lang of ["ui", "UI", " musepi-ui ", "openui", "openui-lang"]) {
			expect(isUiBlockLanguage(lang)).toBe(true);
		}
	});

	test("leaves every other fence alone", () => {
		for (const lang of ["", "ts", "json", "mermaid", "text"]) {
			expect(isUiBlockLanguage(lang)).toBe(false);
		}
	});
});

describe("parsing", () => {
	test("reads the root as a stack of its children", () => {
		const parsed = parseUiBlock('root = Stack([Badge("稳定"), Stat("延迟", 42)])');
		expect(parsed.errors).toEqual([]);
		expect(parsed.tree?.children.map(child => child.type)).toEqual(["Badge", "Stat"]);
	});

	test("containers keep their children, and a chart keeps its series as data", () => {
		const parsed = parseUiBlock('root = Stack([Card("t", [BarChart(["a", "b"], [Series("s", [1, 2])])])])');
		const card = parsed.tree?.children[0];
		expect(card?.children[0]?.type).toBe("BarChart");
		expect(card?.children[0]?.props.series).toBeDefined();
		expect(card?.children[0]?.children).toEqual([]);
	});

	test("a named argument gets one clear error, not the cascade it causes", () => {
		const parsed = parseUiBlock('root = Stack([Card(title: "x", [Text("y")])])');
		expect(parsed.errors).toHaveLength(1);
		expect(parsed.errors[0]).toContain("positional");
	});

	test("an empty program says what a block needs", () => {
		expect(parseUiBlock("").errors.join(" ")).toMatch(/root = Stack/);
	});

	test("signatures are generated from the catalog", () => {
		const signatures = uiBlockSignatures();
		expect(signatures).toContain("Text(markdown: string)");
		expect(signatures.some(line => line.startsWith("Table("))).toBe(true);
	});
});

describe("rendering", () => {
	test("draws a whole block", () => {
		const rendered = renderUiBlock('root = Stack([Badge("稳定"), Table(["阶段"], [["影子写"]])])');
		expect(rendered.nodes).toBe(3);
		expect(rendered.errors).toEqual([]);
		expect(rendered.html).toContain("稳定");
		expect(rendered.html).toContain("<table>");
	});

	test("text escapes markup and keeps only bold and code", () => {
		const rendered = renderUiBlock('root = Stack([Text("<img src=x onerror=\\"alert(1)\\"> **粗** `码`")])');
		expect(rendered.html).not.toContain("<img");
		expect(rendered.html).toContain("&lt;img");
		expect(rendered.html).toContain("<strong>粗</strong>");
		expect(rendered.html).toContain('<code class="tr-ui-code">码</code>');
	});

	test("tone is bounded to the catalog's five values", () => {
		expect(renderUiBlock('root = Stack([Badge("x", "chartreuse")])').html).not.toContain("chartreuse");
	});

	test("steps carry their status and direction", () => {
		const html = renderUiBlock(
			'root = Stack([Steps([{title: "构建", status: "done"}, {title: "灰度", status: "current"}, {title: "上线"}], "row")])',
		).html;
		expect(html).toContain('data-status="done"');
		expect(html).toContain('data-status="todo"');
		expect(html).toContain('data-direction="row"');
	});

	test("a whole bar chart shows shares and a total", () => {
		const html = renderUiBlock(
			'root = Stack([BarChart(["解析", "渲染", "通信"], [Series("耗时", [50, 30, 20])], "ms", true)])',
		).html;
		expect(html).toContain("50%");
		expect(html).toMatch(/tr-ui-chart-total[^>]*>[^<]*100/);
		expect(html).toContain("ms");
	});

	test("a line chart needs two labels and draws one polyline per series", () => {
		// One label cannot make a line, so the block draws nothing rather than an empty frame.
		expect(renderUiBlock('root = Stack([LineChart(["1"], [Series("a", [1])])])').nodes).toBe(0);
		const html = renderUiBlock(
			'root = Stack([LineChart(["1月", "2月"], [Series("a", [1, 4]), Series("b", [2, 3])])])',
		).html;
		expect(html.match(/<polyline/g) ?? []).toHaveLength(2);
		expect(html).toContain("1月");
	});

	test("details without children draws nothing instead of an empty fold", () => {
		expect(renderUiBlock('root = Stack([Details("方法", [])])').html).not.toContain("<details");
	});

	test("a row keeps its children as siblings", () => {
		const html = renderUiBlock('root = Stack([Row([Stat("延迟", 42), Stat("吞吐", 900)])])').html;
		expect(html.match(/class="tr-ui-stat"/g) ?? []).toHaveLength(2);
	});
});

describe("failure is visible", () => {
	test("a block that cannot parse shows the reasons and its source", () => {
		const html = renderUiBlockFence('root = Stack([Card(title: "x")])');
		expect(html).toContain("tr-ui--empty");
		expect(html).toContain("tr-ui-src");
		expect(html).toContain("tr-ui-errors");
	});

	test("a drawn block with a leftover error notes it underneath", () => {
		const html = renderUiBlockFence('root = Stack([Text("ok")])');
		expect(html).not.toContain("tr-ui-note");
	});

	test("the fence always wraps its output", () => {
		expect(renderUiBlockFence('root = Stack([Text("ok")])').startsWith('<div class="tr-ui">')).toBe(true);
	});
});

describe("streaming fences", () => {
	test("an open ui fence splits into the text before it and its partial source", async () => {
		const { splitOpenUiFence } = await import("./render");
		const split = splitOpenUiFence('先看结论。\n\n```ui\nroot = Stack([Text("还在生成")');
		expect(split?.head).toBe("先看结论。\n");
		expect(split?.source).toContain('root = Stack([Text("还在生成")');
	});

	test("a closed fence is not split", async () => {
		const { splitOpenUiFence } = await import("./render");
		expect(splitOpenUiFence("```ui\nroot = Stack([])\n```")).toBeNull();
	});

	test("a partial block draws what parsed and stays quiet about the truncation", () => {
		const html = renderUiBlockFence('root = Stack([Text("已经到达")]\n', false);
		expect(html).toContain("已经到达");
		expect(html).not.toContain("tr-ui-note");
	});
});

describe("reading blocks", () => {
	test("a List draws its items and numbers them when ordered", () => {
		const block = renderUiBlock('root = Stack([List(["alpha", "beta"], true), List(["gamma"])])');
		expect(block.errors).toEqual([]);
		expect(block.html).toContain('<ol class="tr-ui-list" data-ordered="true">');
		expect(block.html).toContain('<ul class="tr-ui-list" data-ordered="false">');
		expect(block.html).toContain("alpha");
	});

	test("a Quote keeps its source under the passage", () => {
		const block = renderUiBlock('root = Stack([Quote("要引用的话", "出处")])');
		expect(block.errors).toEqual([]);
		expect(block.html).toContain("tr-ui-quote");
		expect(block.html).toContain("tr-ui-quote-source");
		expect(block.html).toContain("要引用的话");
	});

	test("a Link opens in a new tab and never offers a script URL", () => {
		const ok = renderUiBlock('root = Stack([Link("文档", "https://example.test/a", "打开说明")])');
		expect(ok.errors).toEqual([]);
		expect(ok.html).toContain('href="https://example.test/a"');
		expect(ok.html).toContain('rel="noopener noreferrer"');
		const refused = renderUiBlock('root = Stack([Link("危险", "javascript:alert(1)")])');
		// The label still reads, but it is not a target.
		expect(refused.html).not.toContain("javascript:alert");
		expect(refused.html).toContain("tr-ui-link--blocked");
	});

	test("a Divider is a rule with or without a caption", () => {
		const plain = renderUiBlock("root = Stack([Divider()])");
		expect(plain.html).toContain('<hr class="tr-ui-divider"');
		const labelled = renderUiBlock('root = Stack([Divider("或")])');
		expect(labelled.html).toContain("tr-ui-divider");
		expect(labelled.html).toContain("或");
	});

	test("a Code block keeps its language and title in the head", () => {
		const block = renderUiBlock('root = Stack([Code("const x = 1;", "ts", "示例")])');
		expect(block.errors).toEqual([]);
		expect(block.html).toContain("tr-ui-code-block");
		expect(block.html).toContain("tr-ui-code-lang");
		expect(block.html).toContain("ts");
	});
});

describe("grid layout", () => {
	test("a Grid lays its tiles out in the requested columns", () => {
		const block = renderUiBlock('root = Stack([Grid([Stat("A", 1), Stat("B", 2), Stat("C", 3)], 3)])');
		expect(block.errors).toEqual([]);
		expect(block.html).toContain('class="tr-ui-grid"');
		expect(block.html).toContain("--tr-ui-grid-columns:3");
	});

	test("a Grid clamps its column count to what a reply can show", () => {
		const block = renderUiBlock('root = Stack([Grid([Stat("A", 1), Stat("B", 2)], 9)])');
		expect(block.html).toContain("--tr-ui-grid-columns:4");
	});
});
