/**
 * Live verification for the M1 transcript scrolling contract on the DESKTOP app.
 *
 * Escape-guard proved the driver pattern (isolated daemon + fake provider +
 * CDP); this is the scroll-anchor companion. It spawns the whole stack itself:
 *
 *   fake-openai-server (:8499, 8s SSE stream)
 *     → isolated daemon (`bun packages/coding-agent/src/cli.ts serve` on a
 *       pid-derived loopback port, PI_CONFIG_DIR / MUSEPI_DAEMON_DIR isolated)
 *     → desktop Electron (dist bundle, pid-derived --remote-debugging-port,
 *       same MUSEPI_DAEMON_DIR so the shell discovers OUR ws.port, never the
 *       user's real daemon)
 *
 * Asserts the desktop-side M1 contract on the OUTER scroller
 * (`.gui-transcript`; the anchor resolves it via closest()):
 *   1. `.tr-turn-head` renders (desktop model prop path)
 *   2. after page reload (session restore) the transcript lands on the
 *      bottom — stick-to-bottom on restore
 *   3. programmatic scroll-up releases follow → `.tr-back-bottom` appears
 *   4. clicking `.tr-back-bottom` returns to the bottom and hides the button
 *
 * The scratch session lives only in the throwaway PI_CONFIG_DIR; no real
 * session, credential, or quota is touched. Everything is killed in finally.
 *
 * Usage (repo root): bun packages/desktop-app/scripts/verify-desktop-scroll.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

// Per-run ports: a prior crashed run can leave a ZOMBIE listener behind
// (socket inherited by a dead pid — netstat still shows LISTENING, connect()
// accepts but no one answers; gui-implementation §8). A fixed port would
// either collide or silently probe the zombie, so derive ports from our pid.
const DAEMON_PORT = 8399 + (process.pid % 400);
const CDP_PORT = 9324 + (process.pid % 400);
const FAKE_PORT = 8499; // fixed inside fake-openai-server.mjs
const STREAM_SECONDS = 8;
const TURNS = 5;

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const desktopDir = path.join(repoRoot, "packages", "desktop-app");
const shotsDir = path.join(repoRoot, "docs", "review", "0.5.0-m1-transcript-design", "shots", "desktop");
const workRoot = path.join(repoRoot, ".desktop-build", "verify-scroll");
const dirs = {
	home: path.join(workRoot, "home"),
	// The daemon binds daemon.sock here; bun-on-Windows AF_UNIX fails past
	// ~108 chars (reproduced: repo-nested path len=109 fails, short tmpdir
	// path works), so the socket dir MUST live under the short system temp.
	socket: path.join(os.tmpdir(), `musepi-verify-scroll-${process.pid}`),
	userData: path.join(workRoot, "electron-user-data"),
	logs: path.join(workRoot, "logs"),
};
const bun = path.join(process.env.USERPROFILE ?? "", ".bun", "bin", "bun.exe");
const electronBin =
	process.platform === "win32"
		? path.join(desktopDir, "node_modules", "electron", "dist", "electron.exe")
		: path.join(desktopDir, "node_modules", ".bin", "electron");
const portFile = path.join(dirs.socket, "ws.port");
/** Non-zero exit without orphaning the spawned stack: throw, never
 *  process.exit — process.exit skips the finally that kills children. */
class Fatal extends Error {}
const fatal = msg => {
	throw new Fatal(msg);
};

/** The previous run may have died before its finally reaped children; a
 *  leftover repo Electron (or its log-handle) makes the fresh-state rm
 *  EBUSY. Restrict the sweep to Electron binaries inside THIS repo's
 *  node_modules (same matcher as dev-desktop.mjs) so unrelated apps
 *  (Kimi, the installed MusePi) are never touched. */
const REPO_ELECTRON =
	/harness-engineering[\\/]musepi-omp[\\/]node_modules[\\/]\.bun[\\/]electron@[^\\/]+[\\/]node_modules[\\/]electron[\\/]dist[\\/](?:Electron\.app\/Contents\/MacOS\/Electron|electron(?:\.exe)?)/;
function repoElectronPids() {
	const pids = [];
	if (process.platform !== "win32") return pids;
	try {
		const out = spawnSync(
			"powershell",
			[
				"-NoProfile",
				"-Command",
				"Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.ExecutablePath } | ForEach-Object { \"$($_.ProcessId)`t$($_.ExecutablePath)\" }",
			],
			{ encoding: "utf8" },
		).stdout;
		for (const line of out.split(/\r?\n/)) {
			const [pidStr, ...rest] = line.split("\t");
			if (rest.length === 0 || !REPO_ELECTRON.test(rest.join("\t"))) continue;
			const pid = Number.parseInt(pidStr, 10);
			if (Number.isFinite(pid)) pids.push(pid);
		}
	} catch {}
	return pids;
}
/** Hard-kill a pid tree. bun's process.kill(SIGKILL) does NOT terminate
 *  arbitrary Windows pids (observed: the 9224 Electron survived it);
 *  taskkill /F /T is the reliable hammer. */
function hardKill(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return;
	if (process.platform === "win32") {
		try {
			spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
			return;
		} catch {}
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {}
}
function killListenerOnPort(port) {
	try {
		const out = spawnSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true }).stdout ?? "";
		const line = out.split(/\r?\n/).find(l => l.includes(`:${port}`) && l.includes("LISTENING"));
		const pid = Number.parseInt((line ?? "").trim().split(/\s+/).pop() ?? "", 10);
		if (Number.isInteger(pid) && pid > 0) {
			console.warn(`rmFresh: killing leftover listener pid ${pid} on :${port}`);
			hardKill(pid);
		}
	} catch {}
}
async function rmFresh(dir) {
	for (let attempt = 0; ; attempt++) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
			return;
		} catch (err) {
			if (attempt === 3) {
				// Orphaned children from a run that died before its finally
				// still hold log-file handles — reap them by port, then sweep
				// any repo Electron the single-instance lock would trip on.
				for (const p of [DAEMON_PORT, CDP_PORT, FAKE_PORT]) killListenerOnPort(p);
				await sleep(800);
			}
			if (attempt === 6) {
				for (const pid of repoElectronPids()) {
					console.warn(`rmFresh: sweeping stale repo Electron pid ${pid}`);
					hardKill(pid);
				}
				await sleep(800);
			}
			if (attempt < 12) {
				await sleep(500);
				continue;
			}
			fatal(`cannot clear ${dir}: ${err instanceof Error ? err.message : err}`);
		}
	}
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

function portOpen(port) {
	return new Promise(res => {
		const s = net.connect({ host: "127.0.0.1", port, timeout: 500 });
		s.on("connect", () => { s.destroy(); res(true); });
		s.on("error", () => res(false));
		s.on("timeout", () => { s.destroy(); res(false); });
	});
}
async function waitFor(cond, timeoutMs, stepMs = 250) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await cond()) return true;
		await sleep(stepMs);
	}
	return false;
}
/** Spawn with output teed into workRoot/logs/<name>.log; returns the child. */
function spawnLogged(name, program, args, env, cwd) {
	const log = fs.openSync(path.join(dirs.logs, `${name}.log`), "w");
	const child = spawn(program, args, {
		cwd,
		env,
		stdio: ["ignore", log, log],
		windowsHide: true,
	});
	child.on("exit", (code, signal) => {
		fs.closeSync(log);
		console.log(`[spawn] ${name} exited code=${code} signal=${signal}`);
	});
	return child;
}
const tail = name => {
	try {
		const lines = fs.readFileSync(path.join(dirs.logs, `${name}.log`), "utf8").trim().split(/\r?\n/);
		return lines.slice(-12).join("\n");
	} catch {
		return "(no log)";
	}
};

fs.mkdirSync(shotsDir, { recursive: true });
// Fresh state: a stale ws.port or old home would silently cross-wire probes.
await rmFresh(workRoot);
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });

// Brand the daemon with the GUI's own version (what electron's daemon.cjs
// start() does via MUSEPI_VERSION): without it the daemon reports the OMP
// engine version, the boot version gate fires, and the GUI restarts the
// daemon itself — a grandchild orphan this script's finally cannot reap.
let guiVersion = "";
try {
	guiVersion = JSON.parse(fs.readFileSync(path.join(desktopDir, "package.json"), "utf8")).version ?? "";
} catch {}
const isoEnv = {
	...process.env,
	PATH: `${path.dirname(bun)}${path.delimiter}${process.env.PATH ?? ""}`,
	PI_CONFIG_DIR: dirs.home,
	MUSEPI_DAEMON_DIR: dirs.socket,
	MUSEPI_GUI_USER_DATA: dirs.userData,
	...(guiVersion ? { MUSEPI_VERSION: guiVersion } : {}),
};

// ── Preflight: our three ports must be free ──────────────────────────────
for (const [label, port] of [["daemon", DAEMON_PORT], ["cdp", CDP_PORT], ["fake", FAKE_PORT]]) {
	if (await portOpen(port)) {
		console.error(`preflight: port ${port} (${label}) already in use — refusing to drive an unknown instance.`);
		process.exit(1);
	}
}

let fake = null;
let daemon = null;
let electron = null;
let browser = null;

try {
	// ── 1. Fake provider ──────────────────────────────────────────────────
	fake = spawnLogged("fake", bun, [path.join(desktopDir, "scripts", "fake-openai-server.mjs")], {
		...isoEnv,
		FAKE_STREAM_SECONDS: String(STREAM_SECONDS),
	});
	// Port-open alone cannot distinguish a live bind from an inherited-socket
	// zombie; the log line proves OUR process really bound.
	const fakeBound = () => tail("fake").includes("fake openai endpoint on");
	if (!(await waitFor(fakeBound, 10_000))) {
		fatal("fake provider did not bind:\n" + tail("fake"));
	}

	// ── 2. models.yml in the isolated root ────────────────────────────────
	fs.mkdirSync(path.join(dirs.home, "agent"), { recursive: true });
	fs.writeFileSync(
		path.join(dirs.home, "agent", "models.yml"),
		[
			"providers:",
			"  fake:",
			`    baseUrl: http://127.0.0.1:${FAKE_PORT}/v1`,
			"    apiKey: sk-fake",
			"    api: openai-completions",
			"    models:",
			"      - id: fake-slow",
			"        name: Fake Slow",
			"        reasoning: false",
			"",
		].join("\n"),
	);

	// ── 3. Isolated daemon ────────────────────────────────────────────────
	daemon = spawnLogged(
		"daemon",
		bun,
		[path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts"), "serve", "--port", String(DAEMON_PORT)],
		isoEnv,
		repoRoot,
	);
	const daemonBound = () => tail("daemon").includes("musepi daemon listening");
	if (!(await waitFor(daemonBound, 25_000))) {
		fatal("daemon did not bind:\n" + tail("daemon"));
	}
	if (fs.readFileSync(path.join(dirs.logs, "daemon.log"), "utf8").includes("custom providers disabled")) {
		fatal("daemon rejected the fake provider (custom providers disabled):\n" + tail("daemon"));
	}
	console.log(`daemon up on :${DAEMON_PORT} (ws.port=${fs.readFileSync(portFile, "utf8").trim()})`);

	// ── 4. Desktop Electron on the dist bundle ────────────────────────────
	if (!fs.existsSync(electronBin)) {
		fatal(`electron binary not found: ${electronBin} (run a full desktop build first)`);
	}
	electron = spawnLogged(
		"electron",
		electronBin,
		[path.join("electron", "main.cjs"), "--remote-debugging-port=" + CDP_PORT],
		isoEnv,
		desktopDir,
	);
	const cdpUp = await waitFor(async () => {
		if (electron.exitCode !== null || electron.signalCode !== null) return false;
		try {
			// A zombie socket accepts TCP but never answers — bound the probe.
			const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, {
				signal: AbortSignal.timeout(1500),
			});
			if (!res.ok) return false;
			const j = await res.json();
			return typeof j?.webSocketDebuggerUrl === "string";
		} catch {
			return false;
		}
	}, 30_000);
	if (!cdpUp) {
		fatal(
			"CDP never came up; electron exited?" +
				` ${electron.exitCode}\n--- electron log tail ---\n${tail("electron")}` +
				`\n--- daemon log tail ---\n${tail("daemon")}`,
		);
	}

	browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP_PORT}` });
	const page = await (async () => {
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline) {
			const p = (await browser.pages()).find(p => p.url().includes("dist/index.html"));
			if (p) return p;
			await sleep(400);
		}
		throw new Error("GUI page (dist/index.html) not found");
	})();
	// tryUrl swallows every connect failure into `return false` — the page
	// console is the only place the real error surfaces.
	page.on("console", m => console.log("[page]", m.type(), m.text().slice(0, 220)));
	page.on("pageerror", e => console.log("[pageerror]", String(e).slice(0, 300)));
	await page.setViewport({ width: 960, height: 640 });
	const shot = name => page.screenshot({ path: path.join(shotsDir, `${name}.png`) });

	// The renderer boots from localStorage["musepi-gui-url"] ?? DEFAULT_URL
	// (app.tsx:301), and the default :8300 attempt never times out
	// (gui-implementation §8: connect() can hang forever → stuck splash).
	// Seed OUR daemon's URL before the app settles on the splash.
	// "musepi-gui-onboarding-done" (lib/onboarding.ts) dismisses the first-run
	// setup wizard — its later steps demand credentials the fake root cannot
	// satisfy (escape-guard LIMITATION), and its modal owns all input.
	await page.evaluate(
		({ url, doneKey }) => {
			localStorage.setItem("musepi-gui-url", url);
			localStorage.setItem(doneKey, String(Date.now()));
		},
		{ url: `ws://127.0.0.1:${DAEMON_PORT}`, doneKey: "musepi-gui-onboarding-done" },
	);
	await page.reload({ waitUntil: "domcontentloaded" });
	const booted = await waitFor(
		() => page.evaluate(() => !!document.querySelector('[data-chat-input="true"] textarea, .gui-transcript')),
		40_000,
		500,
	);
	console.log("renderer reached chat surface:", booted);
	if (!booted) {
		const diag = await page.evaluate(async port => {
			const body = document.body?.innerText?.replace(/\s+/g, " ").slice(0, 500) ?? "";
			const cls = [...document.querySelectorAll("[class]")].slice(0, 40).map(e => e.className).join(" ").slice(0, 400);
			let probe = null;
			try {
				probe = await window.electronAPI?.probeDaemonPort?.();
			} catch {}
			// Raw WS handshake to the daemon: separates "unreachable" from
			// "reachable but the RpcClient handshake fails".
			const wsProbe = await new Promise(res => {
				try {
					const ws = new WebSocket(`ws://127.0.0.1:${port}`);
					const to = setTimeout(() => res("timeout"), 5000);
					ws.onopen = () => {
						clearTimeout(to);
						ws.close();
						res("open");
					};
					ws.onerror = () => {
						clearTimeout(to);
						res("error");
					};
					ws.onmessage = m => {
						clearTimeout(to);
						res("msg:" + String(m.data).slice(0, 80));
					};
				} catch (e) {
					res("throw:" + (e instanceof Error ? e.message : e));
				}
			});
			return {
				url: location.href,
				guiUrl: localStorage.getItem("musepi-gui-url"),
				title: document.title,
				body,
				cls,
				probe,
				wsProbe,
			};
		}, DAEMON_PORT);
		await page.screenshot({ path: path.join(shotsDir, "boot-stuck.png") }).catch(() => {});
		fatal(
			"renderer stuck before the chat surface: " +
				JSON.stringify(diag) +
				`\n--- electron log tail ---\n${tail("electron")}` +
				`\n--- daemon exited=${daemon?.exitCode} signal=${daemon?.signalCode} ---\n${tail("daemon")}`,
		);
	}

	const working = () =>
		page.evaluate(() => {
			const t = document.querySelector(".gui-header")?.textContent ?? "";
			return /回复中|工作中|Replying|Working/.test(t);
		});
	const scrollerState = () =>
		page.evaluate(() => {
			const el = document.querySelector(".gui-transcript");
			if (!el) return null;
			return {
				scrollTop: el.scrollTop,
				max: el.scrollHeight - el.clientHeight,
				overflow: el.scrollHeight > el.clientHeight + 4,
			};
		});

	// ── 5. Onboarding modal (first-run temp root cannot finish setup) ─────
	const modalUp = () =>
		page.evaluate(() => !!document.querySelector('[aria-modal="true"], .gui-dialog-backdrop, .gui-obo, [class*=onboard]'));
	if (await modalUp()) {
		await page.evaluate(() => {
			const host = document.querySelector(".gui-obo, [class*=onboard], [aria-modal='true']");
			const b = host ? [...host.querySelectorAll("button")].find(x => /跳过|Skip/.test(x.textContent ?? "")) : null;
			b?.click();
		});
		await sleep(900);
	}
	if (await modalUp()) console.log("WARNING: onboarding modal still up — desktop assertions may be blocked (escape-guard parity)");

	// ── 6. Scratch session + N fake turns (builds overflowing history) ────
	console.log("create scratch session…");
	await page.evaluate(() => {
		const fresh = [...document.querySelectorAll("button")].find(b =>
			/新建任务|新建会话|New task|New session/.test(`${b.getAttribute("aria-label") ?? ""}${b.textContent ?? ""}`),
		);
		fresh?.click();
	});
	await sleep(5000);

	const sendPrompt = text =>
		page.evaluate(text => {
			const ta = document.querySelector('[data-chat-input="true"] textarea');
			if (!ta) return "no composer";
			Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, text);
			ta.dispatchEvent(new Event("input", { bubbles: true }));
			ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
			return "sent";
		}, text);

	let workingSeen = false;
	for (let i = 1; i <= TURNS; i++) {
		const sent = await sendPrompt(`第 ${i} 轮：回复 working 一百遍`);
		if (sent !== "sent") {
			console.log(`WARNING: prompt ${i} not sent (${sent}) — composer missing`);
			break;
		}
		const started = await waitFor(working, 30_000, 500);
		workingSeen ||= started;
		console.log(`turn ${i}: running=${started}`);
		if (!started) break;
		if (i < TURNS) {
			// wait for the turn to end before queueing the next one
			await waitFor(async () => !(await working()), (STREAM_SECONDS + 25) * 1000, 500);
			await sleep(800);
		}
	}
	if (!workingSeen) console.log("WARNING: no running turn observed — scroll assertions may be vacuous");

	// ── 7. Assertion 1: turn headers render on desktop ────────────────────
	const turnHeads = await page.evaluate(() => document.querySelectorAll(".tr-turn-head").length);
	check("1. .tr-turn-head renders in desktop", turnHeads > 0, `${turnHeads} headers`);
	await shot("d1-after-turns");

	// Ensure the transcript overflows so unpin/back-to-bottom are meaningful.
	let st = await scrollerState();
	for (let extra = TURNS; st && !st.overflow && extra < TURNS + 5; extra++) {
		console.log("transcript does not overflow yet — sending one more turn");
		await sendPrompt(`补充第 ${extra + 1} 轮：回复 working 一百遍`);
		await waitFor(working, 30_000, 500);
		await waitFor(async () => !(await working()), (STREAM_SECONDS + 25) * 1000, 500);
		st = await scrollerState();
	}
	check("2. transcript overflows (scrollable)", !!st?.overflow, st ? `max=${st.max}` : "no scroller");

	// ── 8. Assertion 2: reload (session restore) lands on the bottom ─────
	await page.reload({ waitUntil: "domcontentloaded" });
	const restored = await waitFor(
		() => page.evaluate(() => document.querySelectorAll(".tr-turn-head").length > 0),
		30_000,
		500,
	);
	await sleep(1800); // anchor settle + smooth landing
	st = await scrollerState();
	const nearBottom = st ? st.max - st.scrollTop < 48 : false;
	check("3. restore (reload) sticks to bottom", restored && nearBottom, st ? `scrollTop=${st.scrollTop} max=${st.max}` : "no scroller");
	await shot("d2-restored-bottom");

	// ── 9. Assertion 3: scroll up releases follow → back-to-bottom shows ──
	await page.evaluate(() => {
		document.querySelector(".gui-transcript")?.scrollTo({ top: 0, behavior: "instant" });
	});
	await sleep(600); // let the anchor machine classify the scroll
	const backBtnUp = await page.evaluate(() => {
		const b = document.querySelector(".tr-back-bottom");
		return !!b && b.getBoundingClientRect().height > 0;
	});
	check("4. scroll up reveals .tr-back-bottom", backBtnUp);
	await shot("d3-back-bottom");

	// ── 10. Assertion 4: click returns to bottom and hides the button ─────
	if (backBtnUp) {
		await page.evaluate(() => document.querySelector(".tr-back-bottom")?.click());
		await sleep(1200); // smooth scroll is programmatically adjudicated, allow settle
		st = await scrollerState();
		const backAtBottom = st ? st.max - st.scrollTop < 48 : false;
		const btnGone = await page.evaluate(() => {
			const b = document.querySelector(".tr-back-bottom");
			return !b || b.getBoundingClientRect().height === 0;
		});
		check("5. click .tr-back-bottom returns to bottom", backAtBottom, st ? `scrollTop=${st.scrollTop} max=${st.max}` : "no scroller");
		check("6. button hides after returning", btnGone);
		await shot("d4-returned");
	} else {
		check("5. click .tr-back-bottom returns to bottom", false, "button never appeared");
		check("6. button hides after returning", false, "button never appeared");
	}

	const failed = results.filter(r => !r.ok);
	console.log(`\n== desktop scroll verification: ${results.length - failed.length}/${results.length} passed ==`);
	for (const f of failed) console.log("  FAIL:", f.name);
	process.exitCode = failed.length === 0 ? 0 : 1;
} catch (err) {
	// Fatal carries an already-formatted message; anything else is a bug.
	console.error(err instanceof Fatal ? `\nFATAL: ${err.message}` : err);
	process.exitCode = 1;
} finally {
	try {
		browser && (await browser.disconnect());
	} catch {}
	for (const child of [electron, daemon, fake]) {
		if (!child || child.exitCode !== null) continue;
		hardKill(child.pid ?? -1);
	}
	// The GUI may have respawned the daemon as a grandchild (version gate);
	// it isn't in the child list above. Reap by port so no SQLite handle
	// outlives the run and the next rmFresh never sees EBUSY.
	await sleep(400);
	killListenerOnPort(DAEMON_PORT);
	killListenerOnPort(FAKE_PORT);
	// Give the OS a beat to reap; Electron children (gpu/renderer) follow the main.
	await sleep(500);
	try {
		fs.rmSync(dirs.socket, { recursive: true, force: true });
	} catch {}
}
