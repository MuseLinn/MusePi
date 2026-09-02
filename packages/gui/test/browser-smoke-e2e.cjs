/**
 * Built-in browser end-to-end smoke test.
 *
 * Drives the managed-browser's loopback CDP bridge (port 9230) that the
 * running GUI exposes. The bridge is always active when the GUI is running
 * (see managed-browser.cjs); this test connects, creates a tab, navigates,
 * reads DOM, and asserts the interaction contract works end-to-end.
 *
 * Prerequisites: MusePi GUI must be running (electron main process).
 * Run: node packages/gui/test/browser-smoke-e2e.cjs
 */
const puppeteer = require("puppeteer-core");

const CDP_URL = "http://127.0.0.1:9230";
const NAV_TIMEOUT = 15_000;
const TARGET_URL = "https://httpbin.org/html";

async function main() {
	let browser;
	try {
		browser = await puppeteer.connect({ browserURL: CDP_URL });
	} catch (err) {
		console.error("SKIP: managed-browser bridge not reachable on", CDP_URL);
		console.error("  (MusePi GUI must be running with the managed browser active)");
		process.exit(0);
	}

	const beforeCount = (await browser.pages()).length;
	console.log("=== before pages:", beforeCount);

	// 1. Create a tab via CDP (same path the agent uses via puppeteer.newPage).
	const page = await browser.newPage();
	const afterCount = (await browser.pages()).length;
	console.log("=== after createTab:", afterCount);
	if (afterCount <= beforeCount) throw new Error("createTab did not increase page count");

	// 2. Navigate to a real HTTP URL.
	await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });

	// 3. Read the DOM — verify the page rendered.
	const h1 = await page.evaluate(() => document.querySelector("h1")?.textContent);
	if (!h1) throw new Error("navigate: page body is empty or DOM inaccessible");
	console.log("=== navigate: h1 =", JSON.stringify(h1));

	// 4. Close the tab (managed-browser close may be slow; use a timeout).
	const closePromise = page.close().catch(() => {});
	await Promise.race([closePromise, new Promise(r => setTimeout(r, 3000))]);

	await browser.disconnect();
	console.log("E2E PASS: built-in browser interaction verified");
}

main().catch(e => {
	console.error("E2E FAIL:", e.message);
	process.exit(1);
});