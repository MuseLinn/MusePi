import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9224" });
const page = (await browser.pages()).find(p => p.url().includes("dist/index.html"));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const draft = () => page.evaluate(() => document.querySelector('[data-chat-input="true"] textarea')?.value ?? "<none>");
const click = m =>
	page.evaluate(mm => {
		const row = [...document.querySelectorAll(".tr-row")].find(r => r.className.includes("tr-row--user"));
		const b = [...row.querySelectorAll("button.tr-action")].find(x =>
			(x.getAttribute("aria-label") ?? "").includes(mm),
		);
		if (!b) return "no btn";
		b.click();
		return "clicked";
	}, m);
const poll = async label => {
	const seen = [];
	for (let i = 0; i < 10; i++) {
		await sleep(500);
		seen.push(await draft());
	}
	console.log(label, JSON.stringify(seen));
};

await page.reload({ waitUntil: "domcontentloaded" });
await sleep(12000);
await page.evaluate(() => document.querySelector(".gui-session-row")?.click());
for (let i = 0; i < 25; i++) {
	await sleep(1000);
	if ((await page.evaluate(() => document.querySelectorAll(".tr-row").length)) > 1) break;
}
const rows = await page.evaluate(() => document.querySelectorAll(".tr-row").length);
console.log("rows:", rows, "| draft now:", JSON.stringify(await draft()));

console.log("step1 撤回:", await click("撤回"));
await poll("  after 撤回  :");
console.log("step2 编辑:", await click("编辑"));
await poll("  after 编辑  :");

await browser.disconnect();
process.exit(0);
