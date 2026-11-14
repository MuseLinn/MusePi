/**
 * Live verification for the desktop pet rework (0.5.0 桌宠批次).
 *
 * Two layers:
 *
 * A. Static main-process contract (grep): the single-click panel IPC is
 *    gone (pet-toggle-panel / onPetPanelToggle / toggleBubblePanel), the
 *    pet window focus IPC (pet-click) remains, and the main window now
 *    pushes the active-pet descriptor with pet activity (petdex fix).
 *
 * B. Render checks in a headed browser (system Edge via puppeteer-core)
 *    against the BUILT dist/pet.html over file://, with an electronAPI
 *    stub capturing the preload listeners. The Electron pet window itself
 *    cannot be CDP-screenshot on Windows: transparent + unfocused means
 *    the compositor never allocates it a surface and
 *    Page.captureScreenshot hangs (verified live, incl. the
 *    anti-backgrounding flags). file:// + stub exercises the exact same
 *    renderer code the window runs.
 *
 *    1. gold BEFORE/AFTER: override the six --gui-pet-{shell,gold}-* vars
 *       with the pre-rework derivation (HEAD formulas) vs the shipped
 *       champagne ramp — same render path, only the palette differs
 *    2. bubbles (in their OWN window since the 2026-09-21 split —
 *       dist/bubbles.html): activity push → collapsed stack → hover action
 *       bar → expanded list with ∨ fab + 清除全部, plus the split-window
 *       geometry reports (content size / visible / hitbox)
 *    3. interaction on click: pointerdown → startled class; click →
 *       greeting class (single click no longer opens a panel)
 *    4. old pet panel DOM is gone
 *
 * Usage (repo root): bun apps/desktop/scripts/verify-desktop-companion.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import chroma from "chroma-js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const desktopDir = path.join(repoRoot, "apps", "desktop");
const shotsDir = path.join(repoRoot, "docs", "review", "0.5.0-m1-transcript-design", "shots", "desktop");
const distPetHtml = path.join(desktopDir, "dist", "pet.html");
const edgeBin = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

if (!fs.existsSync(distPetHtml)) {
	console.error(`dist/pet.html not found — run a full desktop build first`);
	process.exit(1);
}
if (!fs.existsSync(edgeBin)) {
	console.error(`system Edge not found at ${edgeBin}`);
	process.exit(1);
}

// ── A. Static main-process contract ──────────────────────────────────────
const mainCjs = fs.readFileSync(path.join(desktopDir, "electron", "main.cjs"), "utf8");
const preloadCjs = fs.readFileSync(path.join(desktopDir, "electron", "preload.cjs"), "utf8");
const appTsx = fs.readFileSync(path.join(desktopDir, "src", "app.tsx"), "utf8");

check("pet-toggle-panel IPC removed (main.cjs)", !mainCjs.includes('ipcMain.handle("pet-toggle-panel"'));
check("onPetPanelToggle / toggleBubblePanel removed (preload.cjs)", !preloadCjs.includes("onPetPanelToggle") && !preloadCjs.includes("toggleBubblePanel"));
check("single click → focus main window (pet-click IPC kept)", mainCjs.includes('"pet-click"') && preloadCjs.includes("focusMainWindow"));
check("pet-click handler focuses the main window (no panel branch)", /ipcMain\.handle\("pet-click"[^]*?focusMainFromPet\(\)/.test(mainCjs));
check(
	"petdex fix: active-pet descriptor pushed with pet activity",
	appTsx.includes("pet: activePet()"),
);
// Bubbles-window split (2026-09-21): the bubbles render in their own
// window (bubbles.html) sized by the main process via the renderer's
// content-size / visible / hitbox reports.
const petMainTsx = fs.readFileSync(path.join(desktopDir, "src", "pet-main.tsx"), "utf8");
check("pet window no longer hosts the bubbles (pet-main.tsx)", !petMainTsx.includes("pet-bubbles"));
check("bubbles window wired (main.cjs layoutBubblesWindow + set-content-size IPC)", mainCjs.includes("layoutBubblesWindow") && mainCjs.includes('"bubbles-set-content-size"'));
check("bubbles window wired (preload setBubblesContentSize/Visible/Hitbox)", ["setBubblesContentSize", "setBubblesVisible", "setBubblesHitbox"].every(m => preloadCjs.includes(m)));
check("bubbles.html built", fs.existsSync(path.join(desktopDir, "dist", "bubbles.html")));

// ── B. Render checks in headed Edge ──────────────────────────────────────
/** Pre-rework (HEAD) gold derivation — the "屎黄" baseline. */
function oldGoldVars(accent, theme) {
	const a = chroma(accent.trim());
	const h = a.get("oklch.h");
	const l0 = a.get("oklch.l");
	const c0 = Math.max(0.055, a.get("oklch.c"));
	const fmt = (l, c) => `oklch(${(Math.round(l * 1000) / 1000).toFixed(3)} ${(Math.round(c * 1000) / 1000).toFixed(4)} ${Math.round(h)})`;
	if (theme === "dark") {
		return {
			"--gui-pet-shell-a": fmt(Math.min(0.9, l0 + 0.12), Math.min(0.14, c0 * 1.1 + 0.02)),
			"--gui-pet-shell-b": fmt(l0, c0),
			"--gui-pet-shell-c": fmt(l0 * 0.55, c0 * 0.85),
			"--gui-pet-gold-a": fmt(Math.min(0.93, l0 + 0.15), Math.min(0.12, c0 * 0.58)),
			"--gui-pet-gold-b": fmt(l0, Math.min(0.16, c0 * 1.12)),
			"--gui-pet-gold-c": fmt(Math.max(0.42, l0 * 0.62), c0 * 0.74),
		};
	}
	return {
		"--gui-pet-shell-a": fmt(Math.min(0.94, l0 + 0.33), Math.min(0.14, c0 * 1.1 + 0.02)),
		"--gui-pet-shell-b": fmt(Math.min(0.82, l0 + 0.12), c0),
		"--gui-pet-shell-c": fmt(Math.max(0.42, l0 - 0.07), c0 * 0.85),
		"--gui-pet-gold-a": fmt(Math.min(0.9, l0 + 0.22), Math.min(0.12, c0 * 0.62)),
		"--gui-pet-gold-b": fmt(l0, Math.min(0.16, c0 * 1.1)),
		"--gui-pet-gold-c": fmt(Math.max(0.3, l0 - 0.18), c0 * 0.8),
	};
}

fs.mkdirSync(shotsDir, { recursive: true });

const browser = await puppeteer.launch({
	executablePath: edgeBin,
	headless: false,
	args: ["--window-size=520,420", "--window-position=80,80", "--allow-file-access-from-files"],
});
try {
	const page = await browser.newPage();
	await page.setViewport({ width: 480, height: 400 });
	page.on("pageerror", e => console.log("[pageerror]", String(e).slice(0, 300)));
	page.on("console", m => {
		const t = m.text();
		if (t.includes("[pet]") || m.type() === "error") console.log("[console]", m.type(), t.slice(0, 240));
	});
	page.on("requestfailed", r => console.log("[reqfail]", r.url().slice(-90), r.failure()?.errorText));

	// Stub the preload bridge BEFORE the renderer boots: capture the
	// activity listener so the test can push payloads exactly like the main
	// window. Shared by the pet page and the bubbles page (evaluateOnNew-
	// Document is per-page).
	const stubBridge = () => {
		const listeners = { activity: [], approvalResolved: [], gaze: [], hover: [] };
		const calls = { petReply: [], petApprove: [], petMarkRead: [], petMarkAllRead: [], petOpenSession: [], focusMainWindow: 0, setPetContentSize: [], setBubblesContentSize: [], setBubblesVisible: [], setBubblesHitbox: [] };
		(window).__petStub = { listeners, calls };
		(window).electronAPI = {
			onPetActivity: cb => {
				listeners.activity.push(cb);
				return () => {
					const i = listeners.activity.indexOf(cb);
					if (i >= 0) listeners.activity.splice(i, 1);
				};
			},
			onPetGaze: cb => {
				listeners.gaze.push(cb);
				return () => {};
			},
			onPetHover: cb => {
				listeners.hover.push(cb);
				return () => {};
			},
			onPetApprovalResolved: cb => {
				listeners.approvalResolved.push(cb);
				return () => {};
			},
			requestPetState: () => Promise.resolve(),
			setPetHitbox: () => Promise.resolve(),
			setPetRect: () => Promise.resolve(),
			setPetContentSize: s => {
				calls.setPetContentSize.push(s);
				return Promise.resolve();
			},
			setBubblesContentSize: s => {
				calls.setBubblesContentSize.push(s);
				return Promise.resolve();
			},
			setBubblesVisible: v => {
				calls.setBubblesVisible.push(v);
				return Promise.resolve();
			},
			setBubblesHitbox: r => {
				calls.setBubblesHitbox.push(r);
				return Promise.resolve();
			},
			petReply: (text, sessionId) => {
				calls.petReply.push({ text, sessionId });
				return Promise.resolve();
			},
			petApprove: (requestId, approved) => {
				calls.petApprove.push({ requestId, approved });
				return Promise.resolve();
			},
			petMarkRead: sessionId => {
				calls.petMarkRead.push(sessionId);
				return Promise.resolve();
			},
			petMarkAllRead: () => {
				calls.petMarkAllRead.push(1);
				return Promise.resolve();
			},
			petOpenSession: sessionId => {
				calls.petOpenSession.push(sessionId);
				return Promise.resolve();
			},
			focusMainWindow: () => {
				calls.focusMainWindow++;
				return Promise.resolve();
			},
		};
	};
	await page.evaluateOnNewDocument(`//!world=main\n(${stubBridge.toString()})()`);

	await page.goto(`file:///${distPetHtml.replace(/\\/g, "/")}`, { waitUntil: "load" });
	await page.waitForSelector(".pet-window", { timeout: 10_000 });
	await sleep(1200);

	const pushActivity = (pg, payload) =>
		pg.evaluate(p => {
			//!world=main
			const stub = (window).__petStub;
			for (const cb of stub.listeners.activity) cb(p);
		}, payload);
	const pushGaze = (pg, x, y) =>
		pg.evaluate((x, y) => {
			//!world=main
			const stub = (window).__petStub;
			for (const cb of stub.listeners.gaze) cb({ x, y, at: performance.now() });
		}, x, y);

	// Dark scheme + working mood, like a live session. Push the accent
	// explicitly — applyPetPalette only runs on a theme/accent payload, and
	// without it the six --gui-pet-* vars stay unset (SVG fallbacks).
	await pushActivity(page, { theme: "dark", mood: "working", petState: "working", pet: { kind: "builtin", id: "musepi-note-bot" } });
	await pushActivity(page, { accent: "oklch(0.7507 0.1295 79.85)" });
	await sleep(400);
	const paletteDbg = await page.evaluate(() => ({
		inlineAccent: document.documentElement.style.getPropertyValue("--accent"),
		inlineGoldB: document.documentElement.style.getPropertyValue("--gui-pet-gold-b"),
		computedGoldB: getComputedStyle(document.documentElement).getPropertyValue("--gui-pet-gold-b").trim(),
	}));
	console.log("palette debug:", JSON.stringify(paletteDbg));
	const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
	const theme = await page.evaluate(() => document.documentElement.dataset.theme ?? "dark");
	console.log(`pet scheme: theme=${theme} accent=${accent || "(fallback)"}`);
	const accentForOld = accent || "oklch(0.72 0.15 85)";

	const shot = async name => {
		await sleep(150);
		await page.screenshot({ path: path.join(shotsDir, `${name}.png`), captureBeyondViewport: false });
	};
	const shotPg = async (pg, name) => {
		await sleep(150);
		await pg.screenshot({ path: path.join(shotsDir, `${name}.png`), captureBeyondViewport: false });
	};
	const headRoll = () =>
		page.evaluate(() => {
			const rigs = [...document.querySelectorAll(".gui-pet-svg__body g")];
			const transform = rigs.map(el => el.getAttribute("transform") ?? "").find(value => value.startsWith("translate(20 24)") && value.includes("rotate(")) ?? "";
			const rolls = [...transform.matchAll(/rotate\((-?[\d.]+) -?[\d.]+ -?[\d.]+\)/g)];
			return Number(rolls.at(-1)?.[1] ?? 0);
		});

	// A stationary pointer stops producing IPC. Use the idle face so the
	// measured eyes and head are visible rather than dissolved into work dots.
	await pushActivity(page, { mood: "rest", petState: "idle" });
	await sleep(500);
	await pushGaze(page, 1, 0);
	await sleep(700);
	const engagedRoll = await headRoll();
	await shot("pet-gaze-engaged");
	await sleep(3600);
	const centredRoll = await headRoll();
	await shot("pet-gaze-centred");
	check(
		"stationary gaze smoothly recentres head attention",
		Math.abs(engagedRoll) > 0.3 && Math.abs(centredRoll) < 0.2,
		`engaged=${engagedRoll} centred=${centredRoll}`,
	);
	// Pointer state must not replace the orb's authored session direction.
	await page.evaluate(() => {
		//!world=main
		for (const cb of window.__petStub.listeners.hover) cb(true);
	});
	await sleep(250);
	const hoverDirection = await page.evaluate(() => ({
		mood: document.querySelector(".gui-pet-svg--rest") !== null,
		state: document.querySelector(".gui-pet-svg--idle") !== null,
		mirrored: document.querySelector(".pet-window__pet-flip--mirror") !== null,
	}));
	check("orb hover preserves its session direction", hoverDirection.mood && hoverDirection.state && !hoverDirection.mirrored, JSON.stringify(hoverDirection));
	await page.evaluate(() => {
		//!world=main
		for (const cb of window.__petStub.listeners.hover) cb(false);
	});

	const dragBox = await page.evaluate(() => {
		const r = document.querySelector(".pet-window__pet")?.getBoundingClientRect();
		return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
	});
	if (dragBox) {
		await page.mouse.move(dragBox.x, dragBox.y);
		await page.mouse.down();
		await page.mouse.move(dragBox.x + 48, dragBox.y - 12, { steps: 4 });
		await sleep(250);
		const dragDirection = await page.evaluate(() => ({
			mood: document.querySelector(".gui-pet-svg--rest") !== null,
			state: document.querySelector(".gui-pet-svg--idle") !== null,
			petdexDrag: document.querySelector(".gui-pet-svg--dragging") !== null,
			mirrored: document.querySelector(".pet-window__pet-flip--mirror") !== null,
			gesture: document.querySelector(".gui-pet-svg__gesture")?.getAttribute("transform") ?? "",
		}));
		check("orb drag never selects the Petdex walking row or mirrors", dragDirection.mood && dragDirection.state && !dragDirection.petdexDrag && !dragDirection.mirrored && dragDirection.gesture.length > 0, JSON.stringify(dragDirection));
		await shot("pet-orb-drag");
		await page.mouse.move(dragBox.x - 48, dragBox.y - 12, { steps: 4 });
		await sleep(32);
		const reversed = await page.evaluate(() => ({
			mirrored: document.querySelector(".pet-window__pet-flip--mirror") !== null,
			gesture: document.querySelector(".gui-pet-svg__gesture")?.getAttribute("transform") ?? "",
		}));
		check("orb reversal stays on the continuous gesture rig", !reversed.mirrored && reversed.gesture.length > 0, JSON.stringify(reversed));
		await page.mouse.up();
		await sleep(1100);
		const released = await page.evaluate(() => document.querySelector(".gui-pet-svg__gesture")?.getAttribute("transform") ?? "");
		check("orb release settles without residual tilt", !released.includes("rotate("), released);
	} else {
		check("orb drag never selects the Petdex walking row or mirrors", false, "pet not found");
	}
	await pushActivity(page, { mood: "working", petState: "working" });

	// ── 1. Gold BEFORE (HEAD formulas) / AFTER (shipped) ─────────────────
	// Snapshot the SHIPPED palette first — the app derives these vars into
	// the same inline style we are about to override, so "restore" means
	// re-applying the captured values, not clearing the properties.
	const shippedGold = await page.evaluate(() =>
		Object.fromEntries(
			["shell-a", "shell-b", "shell-c", "gold-a", "gold-b", "gold-c"].map(k => [
				`--gui-pet-${k}`,
				getComputedStyle(document.documentElement).getPropertyValue(`--gui-pet-${k}`).trim(),
			]),
		),
	);
	const oldVars = oldGoldVars(accentForOld, theme === "light" ? "light" : "dark");
	await page.evaluate(vars => {
		const s = document.documentElement.style;
		for (const [k, v] of Object.entries(vars)) s.setProperty(k, v);
	}, oldVars);
	await sleep(350);
	await shot("pet-gold-before");
	const oldApplied = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--gui-pet-gold-b").trim());
	check("old gold override applied", oldApplied === oldVars["--gui-pet-gold-b"], oldApplied);
	await page.evaluate(vars => {
		const s = document.documentElement.style;
		for (const [k, v] of Object.entries(vars)) s.setProperty(k, v);
	}, shippedGold);
	await sleep(350);
	const newGold = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--gui-pet-gold-b").trim());
	check(
		"champagne gold restored after override removal",
		newGold.length > 0 && newGold === shippedGold["--gui-pet-gold-b"] && newGold !== oldApplied,
		`now=${newGold} shipped=${shippedGold["--gui-pet-gold-b"]}`,
	);
	await shot("pet-gold-after");

	// ── 2. Bubbles: stack → hover actions → expanded (bubbles.html window) ──
	// Since the 2026-09-21 split the bubbles render in their OWN window —
	// load dist/bubbles.html with the same bridge stub and drive it exactly
	// like the main window drives the real one.
	const distBubblesHtml = path.join(desktopDir, "dist", "bubbles.html");
	const bubblesPage = await browser.newPage();
	await bubblesPage.setViewport({ width: 480, height: 400 });
	await bubblesPage.evaluateOnNewDocument(`//!world=main\n(${stubBridge.toString()})()`);
	await bubblesPage.goto(`file:///${distBubblesHtml.replace(/\\/g, "/")}`, { waitUntil: "load" });
	await bubblesPage.waitForSelector("#root", { timeout: 10_000 });
	await sleep(600);
	const rootScope = await bubblesPage.evaluate(() => ({
		bubblesRoot: document.documentElement.classList.contains("bubbles-root"),
		stackStatic: getComputedStyle(document.querySelector(".pet-bubbles") ?? document.body).position,
	}));
	check("bubbles window renders with bubbles-root re-scope", rootScope.bubblesRoot, JSON.stringify(rootScope));
	await pushActivity(bubblesPage, { theme: "dark" });
	await pushActivity(bubblesPage, {
		sessions: [{ sessionId: "verify-s1", title: "构建桌面客户端", phase: "done", statusText: "已完成", replyPreview: "构建完成，0 错误。" }],
	});
	await sleep(300);
	await pushActivity(bubblesPage, { approval: { requestId: "verify-r1", tool: "bash" } });
	await sleep(600);
	const stackInfo = await bubblesPage.evaluate(() => {
		const top = document.querySelector(".pet-bubbles--stacked .pet-bubble");
		const more = document.querySelector(".pet-bubble__more");
		return {
			top: !!top,
			moreText: more?.textContent?.trim() ?? null,
		};
	});
	check(
		"bubbles pushed (completed + approval question)",
		stackInfo.top && /[1-9]/.test(stackInfo.moreText ?? ""),
		JSON.stringify(stackInfo),
	);
	const bubbleRadius = await bubblesPage.evaluate(() => {
		const card = document.querySelector(".pet-bubble");
		return card ? getComputedStyle(card).borderTopLeftRadius : "missing";
	});
	check("bubble cards keep their own 20px radius", bubbleRadius === "20px", bubbleRadius);
	// Window split contract: the renderer reports content size + visible +
	// hitbox to the main process (which owns the window geometry).
	const splitReports = await bubblesPage.evaluate(() => {
		//!world=main
		const calls = (window).__petStub.calls;
		const last = calls.setBubblesContentSize.at(-1) ?? { width: 0, height: 0 };
		return {
			sized: last.width > 0 && last.height > 0,
			last,
			visible: calls.setBubblesVisible.at(-1) === true,
			hitboxCalls: calls.setBubblesHitbox,
			hitbox: (calls.setBubblesHitbox.at(-1) ?? null) !== null,
		};
	});
	check(
		"split-window reports (content size + visible + hitbox)",
		splitReports.sized && splitReports.visible && splitReports.hitbox,
		JSON.stringify(splitReports),
	);
	await shotPg(bubblesPage, "pet-bubbles-stacked");

	// Hover the top bubble → action bar shows (pure CSS :hover).
	const bubbleBox = await bubblesPage.evaluate(() => {
		const el = document.querySelector(".pet-bubble");
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
	});
	if (bubbleBox) await bubblesPage.mouse.move(bubbleBox.x, bubbleBox.y);
	await sleep(300);
	const actionsVisible = await bubblesPage.evaluate(() => {
		const bar = document.querySelector(".pet-bubble__actions");
		if (!bar) return "no-bar";
		const cs = getComputedStyle(bar);
		const r = bar.getBoundingClientRect();
		return cs.visibility !== "hidden" && cs.display !== "none" && r.height > 0 ? "visible" : `${cs.visibility}/${cs.display}/h=${r.height}`;
	});
	check("hover reveals the bubble action bar", actionsVisible === "visible", String(actionsVisible));
	await shotPg(bubblesPage, "pet-bubble-hover");

	// Click the stacked card → expanded list with fab + clear-all.
	await bubblesPage.evaluate(() => document.querySelector(".pet-bubbles--stacked > .pet-bubble")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	await sleep(800); // size morph
	const expandedState = await bubblesPage.evaluate(() => ({
		expanded: !!document.querySelector(".pet-bubbles--expanded"),
		fab: !!document.querySelector(".pet-bubbles__fab"),
		clearAll: !!document.querySelector(".pet-bubbles__clear"),
		count: document.querySelectorAll(".pet-bubbles--expanded .pet-bubble").length,
	}));
	check("expanded list with ∨ fab and 清除全部", expandedState.expanded && expandedState.fab && expandedState.clearAll, JSON.stringify(expandedState));
	await shotPg(bubblesPage, "pet-bubbles-expanded");

	// Reply and open actions must not activate the card body's collapse.
	await bubblesPage.click(".pet-bubbles--expanded .pet-bubble--done .pet-bubble__action--open + .pet-bubble__action");
	await sleep(300);
	const inputThere = await bubblesPage.evaluate(() => !!document.querySelector(".pet-bubble__reply-input"));
	check("reply action opens the inline input", inputThere);
	await bubblesPage.type(".pet-bubble__reply-input", "好的，继续");
	await bubblesPage.keyboard.press("Enter");
	await sleep(250);
	const replyCall = await bubblesPage.evaluate(`//!world=main\nwindow.__petStub.calls.petReply`);
	check("inline reply sends via petReply bridge", replyCall.length === 1 && replyCall[0]?.text === "好的，继续", JSON.stringify(replyCall));
	await bubblesPage.click(".pet-bubbles--expanded .pet-bubble--done .pet-bubble__action--open");
	await sleep(200);
	const openState = await bubblesPage.evaluate(() => ({
		//!world=main
		calls: window.__petStub.calls.petOpenSession,
		expanded: !!document.querySelector(".pet-bubbles--expanded"),
	}));
	check("open action keeps the list expanded and opens its session", openState.expanded && openState.calls.at(-1) === "verify-s1", JSON.stringify(openState));
	await bubblesPage.click(".pet-bubbles--expanded .pet-bubble--done .pet-bubble__body");
	await sleep(500);
	const collapsed = await bubblesPage.evaluate(() => ({
		//!world=main
		stacked: !!document.querySelector(".pet-bubbles--stacked"),
		openCalls: window.__petStub.calls.petOpenSession.length,
	}));
	check("expanded card body collapses without opening the session", collapsed.stacked && collapsed.openCalls === 1, JSON.stringify(collapsed));

	// ── 3. Interaction on click ──────────────────────────────────────────
	await page.mouse.move(10, 10); // move off bubbles
	await sleep(200);
	const petBox = await page.evaluate(() => {
		const el = document.querySelector(".pet-window__pet");
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
	});
	if (petBox) {
		// The builtin uses its own interaction spring, not the Petdex wrapper squash.
		await page.mouse.move(petBox.x, petBox.y);
		await page.mouse.down();
		await sleep(120);
		const startled = await page.evaluate(() => ({
			face: !!document.querySelector(".gui-pet-svg--startled"),
			doubleSquash: !!document.querySelector(".pet-window__squash"),
		}));
		check("pointerdown triggers one builtin startled reaction", startled.face && !startled.doubleSquash, JSON.stringify(startled));
		await page.mouse.up();
		await sleep(380);
		const greeting = await page.evaluate(() => ({
			face: !!document.querySelector(".gui-pet-svg--greeting"),
			doubleSquash: !!document.querySelector(".pet-window__squash"),
		}));
		await sleep(300);
		const focusCalls = await page.evaluate(`//!world=main\nwindow.__petStub.calls.focusMainWindow`);
		check(
			"single click triggers greeting without a second squash",
			greeting.face && !greeting.doubleSquash && focusCalls >= 1,
			`${JSON.stringify(greeting)} focusCalls=${focusCalls}`,
		);
	} else {
		check("pointerdown triggers one builtin startled reaction", false, "pet not found");
		check("single click triggers greeting without a second squash", false, "pet not found");
	}

	// ── 4. Panel gone ────────────────────────────────────────────────────
	const panelGone = await page.evaluate(() => !document.querySelector(".pet-panel, [class*='pet-panel']"));
	check("old pet panel DOM is gone", panelGone);

	const fails = results.filter(r => !r.ok).length;
	console.log(`\n${results.length - fails}/${results.length} checks passed`);
	if (fails > 0) process.exitCode = 1;
} finally {
	await browser.close().catch(() => {});
}
