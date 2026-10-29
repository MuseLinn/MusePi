import { afterAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { BunPlugin } from "bun";

const puppeteer = require("puppeteer-core");
const { ensureChromiumExecutable } = require("../../coding-agent/src/tools/browser/launch");

const reactAliases: Record<string, string> = {
	react: path.resolve(import.meta.dir, "../node_modules/react/index.js"),
	"react/jsx-runtime": path.resolve(import.meta.dir, "../node_modules/react/jsx-runtime.js"),
	"react/jsx-dev-runtime": path.resolve(import.meta.dir, "../node_modules/react/jsx-dev-runtime.js"),
	"react-dom": path.resolve(import.meta.dir, "../node_modules/react-dom/index.js"),
	"react-dom/client": path.resolve(import.meta.dir, "../node_modules/react-dom/client.js"),
};
const reactAliasPlugin: BunPlugin = {
	name: "quote-cards-react-alias",
	setup(build) {
		build.onResolve({ filter: /^react(?:\/.*)?$/ }, args => {
			const aliasedPath = reactAliases[args.path];
			return aliasedPath ? { path: aliasedPath } : undefined;
		});
	},
};

const executablePath = await ensureChromiumExecutable();
if (!executablePath) throw new Error("No Chromium executable resolved");
const build = await Bun.build({
	entrypoints: [path.resolve(import.meta.dir, "quote-cards-browser.fixture.tsx")],
	target: "browser",
	format: "esm",
	define: { "process.env.NODE_ENV": '"development"' },
	plugins: [reactAliasPlugin],
});
if (!build.success) throw new AggregateError(build.logs, "QuoteCards browser fixture did not build");
const source = await build.outputs[0].text();
const browser = await puppeteer.launch({ executablePath, headless: true });
const page = await browser.newPage();
const pageErrors: string[] = [];
page.on("pageerror", (error: unknown) => pageErrors.push(error instanceof Error ? error.message : String(error)));
page.on("console", (message: { type(): string; text(): string }) => {
	if (message.type() === "error") pageErrors.push(message.text());
});
await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');
await page.addScriptTag({ content: source });

afterAll(async () => {
	await browser.close();
}, 60_000);

describe("QuoteCards in Chromium", () => {
	it("updates the annotation context and its model prompt when the user edits a comment", async () => {
		await page.waitForSelector(".gui-quote-comment", { timeout: 3000 }).catch((error: unknown) => {
			throw new Error(`${pageErrors.join("\n")}\n${error instanceof Error ? error.message : String(error)}`);
		});
		await page.focus(".gui-quote-comment");
		await page.keyboard.down("Control");
		await page.keyboard.press("a");
		await page.keyboard.up("Control");
		await page.type(".gui-quote-comment", "new comment");
		expect(await page.evaluate(() => document.activeElement === document.querySelector(".gui-quote-comment"))).toBe(
			true,
		);
		await page.click(".gui-quote-preview");
		await page.waitForSelector(".gui-quote-context-preview", { timeout: 3000 });
		const result = await page.evaluate(() => document.querySelector(".gui-quote-context-preview pre")?.textContent);
		expect(result).toContain("Comment: new comment");
	});
});
