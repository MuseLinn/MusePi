/**
 * Live probe for the per-message action buttons (撤回 / 编辑 / 重试).
 *
 * Answers "does the click do anything" from the renderer's own behaviour:
 * which session.* RPCs it sends, whether the composer draft changed, and
 * whether the jump-back dock appeared. Polling RPCs (collab.status /
 * channels.*) are filtered out — they drown the signal.
 *
 * Usage: bun packages/desktop-app/scripts/verify-message-actions.mjs
 */
import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9224" });
const page = (await browser.pages()).find(p => p.url().includes("dist/index.html"));
if (!page) throw new Error("GUI page not found");
const sleep = ms => new Promise(r => setTimeout(r, ms));
/** RPCs that mean an action landed; everything periodic is ignored. */
const INTERESTING = /"method":"(session\.\w+|notes\.\w+)"/g;

// Reload first: a previous run's WebSocket wrapper survives in the page and
// would keep recording every method, drowning the session.* signal.
await page.reload({ waitUntil: "domcontentloaded" });
await sleep(12000);

await page.evaluate(() => {
	window.__rpc = [];
	const orig = WebSocket.prototype.send;
	WebSocket.prototype.send = function (data) {
		try {
			const s = typeof data === "string" ? data : new TextDecoder().decode(data);
			for (const m of s.matchAll(/"method":"(session\.\w+)"/g)) window.__rpc.push(m[1]);
		} catch {}
		return orig.call(this, data);
	};
});

const mark = () => page.evaluate(() => window.__rpc.length);
const since = async from => (await page.evaluate(() => window.__rpc)).slice(from);
const draft = () => page.evaluate(() => document.querySelector('[data-chat-input="true"] textarea')?.value ?? "");
const dockShown = () => page.evaluate(() => !!document.querySelector(".gui-revert-dock"));

const audit = () =>
	page.evaluate(() =>
		[...document.querySelectorAll(".tr-row")].map((r, i) => {
			const btns = [...r.querySelectorAll(".tr-actions button.tr-action")];
			return {
				i,
				kind: (r.className.match(/tr-row--(\w+)/) ?? [])[1] ?? "?",
				text: (r.querySelector(".tr-body")?.textContent ?? "").trim().slice(0, 30),
				labels: btns.map(b => b.getAttribute("aria-label") ?? "?"),
			};
		}),
	);

const clickIn = (rowIndex, match) =>
	page.evaluate(
		({ rowIndex, match }) => {
			const row = [...document.querySelectorAll(".tr-row")][rowIndex];
			if (!row) return "no row";
			const btns = [...row.querySelectorAll(".tr-actions button.tr-action")];
			const hit = btns.find(b => match.split("|").some(m => (b.getAttribute("aria-label") ?? "").includes(m)));
			if (!hit) return `no match "${match}" among [${btns.map(b => b.getAttribute("aria-label")).join(", ")}]`;
			hit.click();
			return "clicked";
		},
		{ rowIndex, match },
	);

// Reach the composer.
for (let i = 0; i < 12; i++) {
	const ok = await page.evaluate(() => {
		[...document.querySelectorAll("button")].find(b => /跳过|Skip/.test(b.textContent ?? ""))?.click();
		return !!document.querySelector('[data-chat-input="true"] textarea');
	});
	if (ok) break;
	await sleep(1000);
}
await page.evaluate(() => {
	[...document.querySelectorAll("button")]
		.find(b => /新建任务|新建会话/.test(`${b.getAttribute("aria-label") ?? ""}${b.textContent ?? ""}`))
		?.click();
});
await sleep(5000);
await page.evaluate(() => {
	const ta = document.querySelector('[data-chat-input="true"] textarea');
	if (!ta) return;
	Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, "探针消息 A");
	ta.dispatchEvent(new Event("input", { bubbles: true }));
	ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
});
// Wait for the reply to SETTLE (an assistant entry row with action buttons).
let rows = [];
for (let i = 0; i < 30; i++) {
	await sleep(1000);
	rows = await audit();
	if (rows.some(r => r.kind === "assistant" && r.labels.some(l => /重试|retry/i.test(l)))) break;
}
console.log("ROWS");
for (const r of rows) console.log(` ${r.i} ${r.kind} "${r.text}" :: ${r.labels.join(" / ")}`);

const userIdx = rows.findIndex(r => r.kind === "user");
const asstIdx = rows.findIndex(r => r.kind === "assistant" && r.labels.some(l => /重试|retry/i.test(l)));
console.log(`indices: user=${userIdx} assistant(has retry)=${asstIdx}`);

// ── 1. 撤回: the contract is "move the leaf only, do NOT backfill the draft" ─
{
	const from = await mark();
	const d0 = await draft();
	const clicked = await clickIn(userIdx, "撤回");
	await sleep(2500);
	console.log(
		`1. 撤回 → ${clicked} | rpc: [${(await since(from)).join(",")}] | draft "${d0}"→"${await draft()}" | dock: ${await dockShown()}`,
	);
}

// ── 2. 编辑: must backfill the composer with the message text ───────────────
{
	const from = await mark();
	const d0 = await draft();
	const clicked = await clickIn(userIdx, "编辑");
	await sleep(2500);
	console.log(
		`2. 编辑 → ${clicked} | rpc: [${(await since(from)).join(",")}] | draft "${d0}"→"${await draft()}" | dock: ${await dockShown()}`,
	);
}

// ── 3. 重试: must branch to the user message and re-send ────────────────────
// Runs LAST, and the probe re-opens the session first: 撤回/编辑 move the leaf
// onto the user message, and the transcript then renders only the path
// root→leaf — the assistant branch (and its 重试 button) is correctly off-path,
// so it cannot be clicked from that state.
{
	// Reloading drops the WebSocket wrapper with the old document — re-install
	// it, or mark/since read a stale (or absent) array.
	await page.reload({ waitUntil: "domcontentloaded" });
	await sleep(12000);
	await page.evaluate(() => {
		window.__rpc = [];
		const orig = WebSocket.prototype.send;
		WebSocket.prototype.send = function (data) {
			try {
				const s = typeof data === "string" ? data : new TextDecoder().decode(data);
				for (const m of s.matchAll(/"method":"(session\.\w+)"/g)) window.__rpc.push(m[1]);
			} catch {}
			return orig.call(this, data);
		};
	});
	await page.evaluate(() => document.querySelector(".gui-session-row")?.click());
	for (let i = 0; i < 25; i++) {
		await sleep(1000);
		if (await page.evaluate(() => document.querySelectorAll(".tr-row").length) > 1) break;
	}
	rows = await audit();
	const idx = rows.findIndex(r => r.kind === "assistant" && r.labels.some(l => /重试|retry/i.test(l)));
	const from = await mark();
	const draft0 = await draft();
	const clicked = await clickIn(idx, "重试|retry|重新生成");
	await sleep(3000);
	console.log(
		`3. 重试 → ${clicked} | rpc: [${(await since(from)).join(",")}] | draft "${draft0}"→"${await draft()}"`,
	);
}

await browser.disconnect();
process.exit(0);
