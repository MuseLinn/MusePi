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

	test("a Link with a message becomes one gesture that opens and answers", () => {
		const block = renderUiBlock(
			'root = Stack([Link("授权页", "https://example.test/login", "登录后继续", "已登录，继续")])',
		);
		expect(block.errors).toEqual([]);
		expect(block.html).toContain("data-ui-link-send");
		expect(block.html).toContain('data-ui-href="https://example.test/login"');
		expect(block.html).toContain('data-ui-message="已登录，继续"');
		// A refused scheme stays refused even when a message rides along.
		const refused = renderUiBlock('root = Stack([Link("x", "javascript:alert(1)", "", "go")])');
		expect(refused.html).toContain("tr-ui-link--blocked");
		expect(refused.html).not.toContain("data-ui-link-send");
	});

	test("an Icon draws from the fixed set and an unknown name draws nothing", () => {
		const known = renderUiBlock('root = Stack([Icon("git-branch", "分支")])');
		expect(known.errors).toEqual([]);
		expect(known.html).toContain('class="tr-ui-icon"');
		expect(known.html).toContain('aria-label="分支"');
		// Decoration by default: with no label it is hidden from assistive tech.
		expect(renderUiBlock('root = Stack([Text("a"), Icon("check")])').html).toContain('aria-hidden="true"');
		expect(renderUiBlock('root = Stack([Text("a"), Icon("no-such-icon")])').html).not.toContain("tr-ui-icon");
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

describe("table alignment", () => {
	test("a column of numbers aligns right and a column of text does not", () => {
		const block = renderUiBlock('root = Stack([Table(["项目", "成本"], [["影子写", 120], ["双读", 80]])])');
		expect(block.errors).toEqual([]);
		// Header and cells of the numeric column both carry the marker.
		expect(block.html).toContain('<th data-align="right">成本</th>');
		expect(block.html).toContain('<td data-align="right">120</td>');
		expect(block.html).toContain("<th>项目</th>");
		expect(block.html).not.toContain('<td data-align="right">影子写</td>');
	});

	test("a column that mixes numbers and text stays left aligned", () => {
		const block = renderUiBlock('root = Stack([Table(["值"], [[120], ["n/a"]])])');
		expect(block.html).not.toContain('data-align="right"');
	});

	test("an empty column is not treated as numeric", () => {
		const block = renderUiBlock('root = Stack([Table(["值"], [[]])])');
		expect(block.html).not.toContain('data-align="right"');
	});
});

describe("progress detail", () => {
	test("never reads 100% before the work is done", () => {
		// 29 of 100 must not round up, and 39 of 40 must floor to 97.
		const near = renderUiBlock('root = Stack([Progress("构建", 39, 40)])');
		expect(near.html).toContain("97%");
		expect(near.html).not.toContain("100%");
		expect(near.html).not.toContain('data-done="true"');
	});

	test("spells out the count when the max is not 100", () => {
		const block = renderUiBlock('root = Stack([Progress("构建", 29, 40)])');
		expect(block.html).toContain("tr-ui-progress-count");
		expect(block.html).toContain("29 / 40");
		const plain = renderUiBlock('root = Stack([Progress("构建", 42)])');
		expect(plain.html).not.toContain("tr-ui-progress-count");
		expect(plain.html).toContain("42%");
	});

	test("a finished bar shows 100% with the success state and announces the range", () => {
		const block = renderUiBlock('root = Stack([Progress("构建", 40, 40)])');
		expect(block.html).toContain('data-done="true"');
		expect(block.html).toContain("100%");
		expect(block.html).toContain('role="progressbar"');
		expect(block.html).toContain('aria-valuemax="40"');
	});
});

describe("key value leader", () => {
	test("each pair is one row with a leader between label and value", () => {
		const block = renderUiBlock(
			'root = Stack([KeyValue([{label: "分支", value: "main"}, {label: "提交", value: "abc123"}])])',
		);
		expect(block.errors).toEqual([]);
		expect(block.html).toContain("tr-ui-kv-row");
		expect(block.html).toContain("tr-ui-kv-leader");
		expect(block.html).toContain("abc123");
	});
});

describe("choices and buttons key their own answers", () => {
	test("two button rows outside a card do not answer into one slot", () => {
		const block = renderUiBlock('root = Stack([Row([Button("浅色"), Button("深色")]), Row([Button("简约")])])');
		expect(block.errors).toEqual([]);
		const names = [...block.html.matchAll(/data-ui-name="([^"]*)"/g)].map(match => match[1] ?? "");
		// Every button needs its own slot, and none may be the empty `field:`.
		expect(names).toEqual(["field::浅色", "field::深色", "field::简约"]);
	});

	test("a button's own name keys it when the reply supplies one", () => {
		const block = renderUiBlock('root = Stack([Row([Button("浅色", "secondary", "light", "主题")])])');
		expect(block.html).toContain('data-ui-name="field:主题:light"');
	});

	test("buttons inside a card still share the card's title as one decision", () => {
		const block = renderUiBlock('root = Stack([Card("主题", [Button("浅色"), Button("深色")])])');
		// The card's own note field is a separate control, not a button answer.
		const names = [...block.html.matchAll(/<button[^>]*data-ui-name="([^"]*)"/g)].map(match => match[1] ?? "");
		expect(names).toEqual(["card:主题", "card:主题"]);
	});

	test("a row layout draws pills, and a description drops it back to a list", () => {
		const row = renderUiBlock('root = Stack([Choice("t", ["浅色", "深色"], "主题", false, "row")])');
		expect(row.errors).toEqual([]);
		expect(row.html).toContain('data-layout="row"');

		const list = renderUiBlock('root = Stack([Choice("t", ["浅色"])])');
		expect(list.html).toContain('data-layout="list"');

		// A description needs its own line, so the row shape cannot hold it.
		const described = renderUiBlock(
			'root = Stack([Choice("t", [{label: "浅色", description: "白天"}, "深色"], "主题", false, "row")])',
		);
		expect(described.html).toContain('data-layout="list"');
	});
});

describe("tabs", () => {
	test("draws a strip and one panel per page, opening the first", () => {
		const block = renderUiBlock('root = Stack([Tabs([Tab("概览", [Text("一")]), Tab("明细", [Text("二")])])])');
		expect(block.errors).toEqual([]);
		expect(block.html).toContain('role="tablist"');
		expect(block.html.match(/role="tab"/g) ?? []).toHaveLength(2);
		expect(block.html.match(/role="tabpanel"/g) ?? []).toHaveLength(2);
		expect(block.html).toContain('data-ui-open="概览"');
		// Only the first page is open on the first draw.
		expect(block.html.match(/<div class="tr-ui-tab-panel"[^>]*data-open="false" hidden/g) ?? []).toHaveLength(1);
	});

	test("two groups on one block are keyed separately by their labels", () => {
		const block = renderUiBlock('root = Stack([Tabs([Tab("A", [Text("1")])]), Tabs([Tab("B", [Text("2")])])])');
		expect(block.html).toContain('data-ui-tabs="A"');
		expect(block.html).toContain('data-ui-tabs="B"');
	});

	test("a Tabs group with no pages draws nothing", () => {
		expect(renderUiBlock("root = Stack([Tabs([])])").nodes).toBe(0);
	});
});

describe("card notes", () => {
	test("a decision card draws its own note field; a display card does not", () => {
		const asking = renderUiBlock('root = Stack([Card("部署窗口", [Button("今晚"), Button("明天")])])');
		expect(asking.errors).toEqual([]);
		expect(asking.html).toContain('data-ui-kind="card-note"');
		expect(asking.html).toContain('data-ui-card="部署窗口"');

		const plain = renderUiBlock('root = Stack([Card("结论", [Text("就这样")])])');
		expect(plain.html).not.toContain("card-note");
	});

	test("an untitled card has nothing to key a note by and draws none", () => {
		const block = renderUiBlock('root = Stack([Card("", [Button("A")])])');
		expect(block.html).not.toContain("card-note");
	});
});

describe("card table styling reaches through the chat's table wrapper", () => {
	/**
	 * `Markdown.decorateTables` wraps every rendered `<table>` in
	 * `.tr-table > .tr-table-scroll` (horizontal scroll plus the copy toolbar).
	 * A `> table` rule aimed at a card therefore matches nothing — the first
	 * version of this styling was dead code for exactly that reason, so the
	 * stylesheet must reach through the wrapper instead of assuming a direct
	 * child.
	 */
	test("the stylesheet reaches a card's table through the decorator's nesting", async () => {
		const css = await Bun.file(new URL("./ui-blocks.css", import.meta.url)).text();
		// Measured twice the hard way: the table's parent is the SCROLL container
		// (`.tr-table > .tr-table-scroll > table`), so both `> table` on the card
		// and `.tr-table > table` matched nothing and left the 1px frame on.
		expect(css).not.toMatch(/\.tr-ui-card\s*>\s*table/);
		expect(css).not.toMatch(/\.tr-ui-card\s+\.tr-table\s*>\s*table\s*[,{]/);
		expect(css).toMatch(/\.tr-ui-card\s+\.tr-table-scroll\s*>\s*table/);
	});

	test("the decorator really nests table inside the scroll container", async () => {
		const markdown = await Bun.file(new URL("../components/transcript/Markdown.tsx", import.meta.url)).text();
		// The assertion above is only correct while this stays true.
		expect(markdown).toContain('class="tr-table-scroll"><table>');
	});
});
