/**
 * Tool card titles: built-in wire names resolve through i18n into their action
 * name ("运行命令") with the key argument beside it; a renderer shared by
 * several wire names keeps the title of the name that was actually called, and
 * unknown tools keep their raw wire name instead of inventing a localized
 * identity.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getLocaleSnapshot, setLocale, t } from "../src/i18n/index.js";
import { TOOL_RENDER_CARD_LABELS, TOOL_RENDER_CARD_TOOLS } from "../src/tool-render/card-tools";
import { resolveToolRenderer, toolCallTitle } from "../src/tool-render/registry";
import { ToolView } from "../src/tool-render/ToolView";

const INITIAL_LOCALE = getLocaleSnapshot();

describe("tool card titles", () => {
	beforeAll(() => setLocale("zh-CN"));
	afterAll(() => setLocale(INITIAL_LOCALE));

	it("localizes the built-in name and keeps the key argument in the head", () => {
		const html = renderToStaticMarkup(
			<ToolView name="bash" args={{ command: "npm test" }} result={{ content: [] }} />,
		);
		expect(html).toContain(t("tools.toolBash"));
		expect(html).not.toContain("已使用");
		expect(html).toContain(t("tools.argOpen"));
		expect(html).toContain("npm test");
		expect(html).toContain(t("tools.argClose"));
	});

	it("keeps the same title while running and lets the spinner carry state", () => {
		const html = renderToStaticMarkup(<ToolView name="bash" running args={{ command: "npm test" }} />);
		expect(html).toContain(t("tools.toolBash"));
		expect(html).not.toContain("正在使用");
		expect(html).toContain("tv-spin");
	});

	it("titles a shared renderer by the wire name that was called", () => {
		expect(resolveToolRenderer("puppeteer")).toBe(resolveToolRenderer("browser"));
		expect(toolCallTitle("puppeteer", resolveToolRenderer("puppeteer"))).toBe(t("tools.toolPuppeteer"));
		expect(toolCallTitle("js", resolveToolRenderer("js"))).toBe(t("tools.toolJs"));
		expect(toolCallTitle("python", resolveToolRenderer("python"))).toBe(t("tools.toolPython"));
		expect(toolCallTitle("puppeteer", resolveToolRenderer("puppeteer"))).not.toBe(
			toolCallTitle("browser", resolveToolRenderer("browser")),
		);
	});

	it("falls back to the raw wire name for unknown tools", () => {
		const renderer = resolveToolRenderer("mcp__fixture__ping");
		expect(toolCallTitle("mcp__fixture__ping", renderer)).toBe("mcp__fixture__ping");

		const html = renderToStaticMarkup(
			<ToolView name="mcp__fixture__ping" args={{ query: "health" }} result={{ content: [] }} />,
		);
		expect(html).toContain("mcp__fixture__ping");
		expect(html).toContain("health");
	});

	it("prefers an explicit renderer label (extension override) over the i18n name", () => {
		const renderer = { ...resolveToolRenderer("bash"), label: "我的 Shell" };
		expect(toolCallTitle("bash", renderer)).toBe("我的 Shell");
	});

	it("resolves a renderer-declared labelKey without any registry entry", () => {
		const renderer = { Summary: () => null, labelKey: "tools.toolAsk" };
		expect(toolCallTitle("plugin_tool", renderer)).toBe(t("tools.toolAsk"));
	});

	it("has a localized title for every card tool in both locales", () => {
		for (const name of TOOL_RENDER_CARD_TOOLS) {
			const key = TOOL_RENDER_CARD_LABELS[name];
			expect(key, `missing title key for ${name}`).toBeDefined();
			if (key === undefined) continue;
			expect(t(key), `untranslated title for ${name}`).not.toBe(name);
			expect(toolCallTitle(name, resolveToolRenderer(name))).toBe(t(key));
		}
		setLocale("en-US");
		try {
			for (const name of TOOL_RENDER_CARD_TOOLS) {
				const key = TOOL_RENDER_CARD_LABELS[name];
				if (key === undefined) continue;
				expect(t(key), `untranslated en title for ${name}`).not.toBe(name);
				expect(toolCallTitle(name, resolveToolRenderer(name))).toBe(t(key));
			}
		} finally {
			setLocale("zh-CN");
		}
	});

	it("titles a tool-registry call by the tools it loads", () => {
		expect(resolveToolRenderer("select_tools")).toBeDefined();
		const html = renderToStaticMarkup(
			<ToolView name="select_tools" args={{ names: ["mcp__a__b", "read", "grep", "bash"] }} />,
		);
		expect(html).toContain(t("tools.toolSelectTools"));
		expect(html).toContain("mcp__a__b");
		expect(html).toContain(t("tools.toolsWithCount", { count: "4" }));
	});

	it("keeps the select_tools load result readable in the body", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="select_tools"
				defaultOpen
				args={{ names: ["read"] }}
				result={{ content: [{ type: "text", text: "Loaded: read" }] }}
			/>,
		);
		expect(html).toContain("Loaded: read");
	});

	it("titles built-in tools that only have the generic body", () => {
		// security_scan has no dedicated renderer, so the head must still be
		// readable while the generic body keeps the raw args digest.
		const html = renderToStaticMarkup(
			<ToolView name="security_scan" args={{ path: "src" }} result={{ content: [] }} />,
		);
		expect(html).toContain(t("tools.toolSecurityScan"));
		expect(html).toContain("src");
		expect(toolCallTitle("checkpoint", resolveToolRenderer("checkpoint"))).toBe(t("tools.toolCheckpoint"));
	});

	it("tolerates malformed args instead of throwing", () => {
		const html = renderToStaticMarkup(<ToolView name="bash" args={null} result={{ content: [] }} />);
		expect(html).toContain(t("tools.toolBash"));
	});

	it("shows the first error line in the head of a failed call", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="bash"
				args={{ command: "bun check" }}
				result={{ content: [{ type: "text", text: "\nTS2307: cannot find module\nmore" }], isError: true }}
			/>,
		);
		const head = html.split("tv-body")[0]!;
		expect(head).toContain("bun check");
		expect(head).toContain("TS2307: cannot find module");
		expect(head).not.toContain("more");
	});

	it("renders the extension lifecycle card from the tool's JSON payload", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="extension_load"
				defaultOpen
				args={{ path: "C:\\ext\\gradient-wallpaper\\index.ts" }}
				result={{
					content: [
						{
							type: "text",
							text: JSON.stringify({ ok: true, addedTools: ["wallpaper"], errors: [], deferred: false }),
						},
					],
				}}
			/>,
		);
		expect(html).toContain(t("tools.toolExtensionLoad"));
		expect(html).toContain("gradient-wallpaper");
		expect(html).toContain(t("tools.extensionAddedTools"));
		expect(html).toContain("wallpaper");
	});

	it("dispatches a running write xd://<tool> call to its real tool before the result", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="write"
				running
				args={{ path: "xd://ext_define", content: JSON.stringify({ name: "gradient-wallpaper", purpose: "壁纸" }) }}
			/>,
		);
		expect(html).toContain(t("tools.toolExtDefine"));
		expect(html).toContain("gradient-wallpaper");
		expect(html).not.toContain("xd://");
		expect(html).not.toContain(t("tools.toolWrite"));
	});
});
