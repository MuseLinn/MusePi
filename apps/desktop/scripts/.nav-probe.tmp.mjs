import * as fs from "node:fs";
import * as path from "node:path";
import puppeteer from "puppeteer-core";

const root = path.resolve(import.meta.dir, "../../..");
const web = path.join(root, "web");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".ttf": "font/ttf", ".json": "application/json" };
const server = Bun.serve({
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const file = path.join(web, decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
		if (!file.startsWith(web) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return new Response("not found", { status: 404 });
		return new Response(Bun.file(file), { headers: { "content-type": types[path.extname(file)] ?? "application/octet-stream" } });
	},
});

const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, headless: true });
const page = await browser.newPage();

for (const width of [1440, 1200, 1101, 1100]) {
	await page.setViewport({ width, height: 900 });
	await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "networkidle0", timeout: 60000 });
	await page.evaluate(() => document.fonts.ready);
	await page.evaluate(() => document.querySelector('[data-lang="en"]').click());
	await new Promise(resolve => setTimeout(resolve, 300));
	const facts = await page.evaluate(() => {
		const inner = document.querySelector(".mp-topbar-inner");
		const links = [...document.querySelectorAll(".mp-nav-link")];
		const nav = document.querySelector(".mp-nav");
		return {
			innerScroll: inner.scrollWidth,
			innerClient: inner.clientWidth,
			navScroll: nav.scrollWidth,
			navClient: nav.clientWidth,
			wrapped: links.filter(link => link.getClientRects().length > 1 || link.scrollHeight > link.clientHeight + 2).length,
			heights: links.map(link => Math.round(link.getBoundingClientRect().height)),
			labels: links.map(link => link.textContent.trim()),
		};
	});
	console.log(width, JSON.stringify(facts));
	await page.screenshot({ path: path.join(root, ".tmp", `nav-${width}-en.png`) });
}

await browser.close();
server.stop();