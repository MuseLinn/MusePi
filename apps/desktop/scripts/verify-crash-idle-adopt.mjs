/**
 * Live verification: a crashed daemon must not pin the desktop GUI in a run
 * state (24a1c86d `adoptIdleState` + 5-second pending check; 8f9b131f names
 * the tool calls a crash left unanswered).
 *
 * Spawns the real stack in a throwaway single instance:
 *
 *   fake OpenAI endpoint (answers the first turn with ONE `bash` tool call)
 *     → desktop Electron on a fresh `MUSEPI_GUI_USER_DATA` / `PI_CONFIG_DIR` /
 *       `MUSEPI_DAEMON_DIR`; the shell spawns its own daemon exactly as the
 *       installed app does on first boot
 *
 * Once the turn is inside the tool execution, the daemon is killed with
 * `taskkill /F /T` — no `system.shutdown`, i.e. the crash the fix targets —
 * and the GUI is observed WITHOUT restarting the app:
 *
 *   1. the stop capsule leaves within seconds; the composer returns to send
 *      (both measured)
 *   2. no phantom run afterwards: no header "working", no live tool spinner,
 *      including through the next 5-second pending check
 *   3. the unanswered call is named: `.tv-interrupted` in the transcript and
 *      the `.gui-pending-calls` resume banner (tool name + command)
 *   4. the auto-reconnect respawns a DIFFERENT daemon and restores the session
 *      with exactly one copy of the turn — no stacked statuses
 *
 * Usage (repo root): bun apps/desktop/scripts/verify-crash-idle-adopt.mjs
 * `MUSEPI_CRASH_VERIFY_OUT=<dir>` keeps logs, screenshots and report.json.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { repoElectronPids } from "./repo-electron.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const desktopDir = path.resolve(scriptDir, "..");
const require = createRequire(path.join(desktopDir, "package.json"));
const electronPath = require("electron");
const puppeteer = require("puppeteer-core");

// The shell's default port is shared with the developer's real daemon, so the
// run is pinned to its own port: `MUSEPI_GUI_DAEMON_PORT` feeds both the
// renderer's DEFAULT_PORT (app.tsx) and the main process's pre-spawn, which is
// also where a dead daemon is respawned. The CDP port follows the pid; the fake
// provider's port is fixed by its own module.
const DAEMON_PORT = 8699 + (process.pid % 300);
const CDP_PORT = 9524 + (process.pid % 300);
// 8499 is the fake provider's historical fixed port and can be held by another
// checkout's probe; this run gets its own and passes it to the server. Deriving
// it from the daemon port keeps the two apart: independent pid formulas can
// (and did) land on the same number, and the fake would then own the port the
// shell needs for its daemon.
const FAKE_PORT = DAEMON_PORT + 500;
const TOOL_SLEEP_SECONDS = 45;
/** The stop capsule must clear within this budget (the pinned-state regression). */
const IDLE_TARGET_MS = 10_000;
/** A replacement daemon's cold boot varies with the machine (15–90 s seen in
 *  this checkout); the composer can only return after it binds. This is the
 *  timeout for that wait, not part of the fix's contract. */
const DAEMON_RESPAWN_TIMEOUT_MS = 180_000;
/** After the replacement daemon binds, the composer must return quickly. */
const SEND_AFTER_RESPAWN_TIMEOUT_MS = 45_000;
/** Observe no phantom run for longer than the 5-second pending check. */
const QUIET_WINDOW_MS = 7_500;

if (FAKE_PORT === DAEMON_PORT || FAKE_PORT === CDP_PORT || DAEMON_PORT === CDP_PORT) {
	throw new Error(`derived ports collide: daemon=${DAEMON_PORT} fake=${FAKE_PORT} cdp=${CDP_PORT}`);
}

const workRoot = process.env.MUSEPI_CRASH_VERIFY_OUT
	? path.resolve(process.env.MUSEPI_CRASH_VERIFY_OUT)
	: path.join(repoRoot, ".desktop-build", "verify-crash-adopt");
const dirs = {
	home: path.join(workRoot, "home"),
	// AF_UNIX sockets fail past ~108 chars on Windows; keep the socket dir short.
	socket: path.join(os.tmpdir(), `musepi-crash-verify-${process.pid}`),
	userData: path.join(workRoot, "electron-user-data"),
	logs: path.join(workRoot, "logs"),
	shots: path.join(workRoot, "shots"),
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
const check = (name, ok, detail) => {
	results.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ""}`);
};

class Fatal extends Error {}
const fatal = message => {
	throw new Fatal(message);
};

const bunExecutable =
	process.env.BUN_EXECUTABLE ??
	(path.basename(process.execPath).startsWith("bun") ? process.execPath : "bun");

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

function listenerPidOnPort(port) {
	try {
		const out = spawnSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true }).stdout ?? "";
		const line = out.split(/\r?\n/).find(l => l.includes(`:${port}`) && l.includes("LISTENING"));
		const pid = Number.parseInt((line ?? "").trim().split(/\s+/).pop() ?? "", 10);
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

function portOpen(port) {
	return new Promise(resolve => {
		const socket = net.connect({ host: "127.0.0.1", port, timeout: 500 });
		socket.on("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.on("error", () => resolve(false));
		socket.on("timeout", () => {
			socket.destroy();
			resolve(false);
		});
	});
}

async function waitFor(condition, timeoutMs, stepMs = 250) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return true;
		await sleep(stepMs);
	}
	return false;
}

function spawnLogged(name, program, args, env, cwd) {
	const log = fs.openSync(path.join(dirs.logs, `${name}.log`), "w");
	const child = spawn(program, args, {
		cwd,
		env,
		stdio: ["ignore", log, log],
		windowsHide: true,
	});
	child.on("exit", (code, signal) => {
		try {
			fs.closeSync(log);
		} catch {}
		console.log(`[spawn] ${name} exited code=${code} signal=${signal}`);
	});
	return child;
}

const tail = (name, lines = 16) => {
	try {
		const text = fs.readFileSync(path.join(dirs.logs, `${name}.log`), "utf8").trim().split(/\r?\n/);
		return text.slice(-lines).join("\n");
	} catch {
		return "(no log)";
	}
};

/** The `musepi serve` launch that Electron recorded for OUR profile. */
function registryEntries() {
	try {
		return fs
			.readdirSync(path.join(dirs.socket, "managed"))
			.filter(name => name.endsWith(".json"))
			.map(name => {
				try {
					return JSON.parse(fs.readFileSync(path.join(dirs.socket, "managed", name), "utf8"));
				} catch {
					return null;
				}
			})
			.filter(entry => entry && Number.isInteger(entry.pid));
	} catch {
		return [];
	}
}

function daemonPidFor(ownerPid) {
	const entries = registryEntries().filter(entry => entry.ownerPid === ownerPid);
	return entries.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0]?.pid ?? null;
}

/** Raw JSON-RPC client: the harness reads daemon truth without the GUI. */
async function openRpc(port) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}`);
	const pending = new Map();
	let nextId = 1;
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("rpc open timeout")), 5_000);
		ws.onopen = () => {
			clearTimeout(timer);
			resolve();
		};
		ws.onerror = () => {
			clearTimeout(timer);
			reject(new Error("rpc open failed"));
		};
	});
	ws.onmessage = event => {
		let message = null;
		try {
			message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
		} catch {
			return;
		}
		const entry = message?.id !== undefined ? pending.get(message.id) : undefined;
		if (!entry) return;
		pending.delete(message.id);
		clearTimeout(entry.timer);
		if (message.error) entry.reject(new Error(String(message.error.message ?? "rpc error")));
		else entry.resolve(message.result);
	};
	return {
		request(method, params, timeoutMs = 8_000) {
			const id = nextId++;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`rpc timeout: ${method}`));
				}, timeoutMs);
				pending.set(id, { resolve, reject, timer });
				ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
			});
		},
		close() {
			try {
				ws.close();
			} catch {}
		},
	};
}

/** One DOM reading of everything the contract can be judged on. */
const probeUi = page =>
	page.evaluate(() => {
		const transcript = document.querySelector(".gui-transcript");
		const headerText = document.querySelector(".gui-header")?.textContent ?? "";
		const composer = document.querySelector(
			'[data-chat-input="true"] .cm-content, [data-chat-input="true"] .musepi-composer-editor',
		);
		const stopCapsule = document.querySelector(".gui-composer-send--working");
		const sendButton = document.querySelector(".gui-composer-send:not(.gui-composer-send--working)");
		const banner = document.querySelector(".gui-pending-calls");
		const interrupted = [...document.querySelectorAll(".tv-interrupted")].map(el => el.textContent?.trim() ?? "");
		const spinners = [...document.querySelectorAll(".tv-spin")].map(el => el.getAttribute("aria-label") ?? "");
		return {
			splash: !composer,
			composer: Boolean(composer),
			transcript: Boolean(transcript),
			stopCapsule: Boolean(stopCapsule),
			sendButton: Boolean(sendButton),
			headerWorking: /回复中|工作中|Replying|Working/.test(headerText),
			banner: banner ? (banner.textContent?.trim() ?? "") : null,
			bannerCount: document.querySelectorAll(".gui-pending-calls").length,
			interrupted,
			spinners,
			toolCards: document.querySelectorAll(".tv-card").length,
			foldStates: [...document.querySelectorAll(".tr-round-fold")].map(el => el.getAttribute("aria-expanded")),
			runStates: [...document.querySelectorAll(".tr-run-summary")].map(el => el.getAttribute("aria-expanded")),
			// Count committed user rows, not raw text: the sticky header repeats the
			// current user message on screen and is not a second turn.
			promptRows: [...document.querySelectorAll(".tr-row--user")].filter(el =>
				/CRASH-PROBE-[A-Za-z0-9]+/.test(el.textContent ?? ""),
			).length,
		};
	});

/** Open closed round folds / tool-run summaries so rows inside them render.
 *  A closed fold renders the reply text only, so the in-card state (and the
 *  live spinner) is only observable after this. */
const expandActivity = async page => {
	for (let pass = 0; pass < 3; pass++) {
		const opened = await page
			.evaluate(() => {
				const closed = [
					...document.querySelectorAll(
						'.tr-round-fold[aria-expanded="false"], .tr-run-summary[aria-expanded="false"]',
					),
				];
				for (const button of closed) button.click();
				return closed.length;
			})
			.catch(() => 0);
		if (opened === 0) break;
		await sleep(500);
	}
};

const promptToken = `CRASH-PROBE-${process.pid}`;
const crashCommand =
	process.platform !== "win32" ||
	[
		process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Git", "bin", "bash.exe"),
		process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"),
		process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
	].some(candidate => candidate && fs.existsSync(candidate))
		? `sleep ${TOOL_SLEEP_SECONDS}`
		: `powershell -NoProfile -Command "Start-Sleep -Seconds ${TOOL_SLEEP_SECONDS}"`;

/** A previous run that died before its finally can still hold log/user-data
 *  handles; retry the clear, then sweep only THIS checkout's Electron. */
async function rmFresh(dir) {
	for (let attempt = 0; ; attempt++) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
			return;
		} catch (error) {
			if (attempt === 3) {
				for (const pid of repoElectronPids()) hardKill(pid);
				hardKill(listenerPidOnPort(DAEMON_PORT) ?? -1);
				await sleep(800);
			}
			if (attempt >= 10) fatal(`cannot clear ${dir}: ${error instanceof Error ? error.message : error}`);
			await sleep(500);
		}
	}
}

// ── Fresh state ───────────────────────────────────────────────────────────
await rmFresh(workRoot);
for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
await rmFresh(dirs.socket);
fs.mkdirSync(dirs.socket, { recursive: true });

let guiVersion = "";
try {
	guiVersion = JSON.parse(fs.readFileSync(path.join(desktopDir, "package.json"), "utf8")).version ?? "";
} catch {}
const isoEnv = {
	...process.env,
	PATH: `${path.dirname(bunExecutable)}${path.delimiter}${process.env.PATH ?? ""}`,
	PI_CONFIG_DIR: dirs.home,
	MUSEPI_DAEMON_DIR: dirs.socket,
	MUSEPI_GUI_USER_DATA: dirs.userData,
	MUSEPI_GUI_DAEMON_PORT: String(DAEMON_PORT),
	...(guiVersion ? { MUSEPI_VERSION: guiVersion } : {}),
};

let fake = null;
let electron = null;
let browser = null;
let rpc = null;
const killedPid = { value: null };
const newPid = { value: null };
const pageLog = [];
const timing = {};

try {
	// ── Preflight: the one fixed port must be free ────────────────────────
	for (const [label, port] of [
		["daemon (shell default)", DAEMON_PORT],
		["cdp", CDP_PORT],
		["fake provider", FAKE_PORT],
	]) {
		if (await portOpen(port)) {
			fatal(
				`port ${port} (${label}) is already in use — refuse to drive an unknown instance; ` +
					"the crash check needs a clean single-instance profile",
			);
		}
	}

	// ── 1. Fake provider: one bash tool call, then a short reply ───────────
	fake = spawnLogged("fake", bunExecutable, [path.join(desktopDir, "scripts", "fake-openai-server.mjs")], {
		...isoEnv,
		FAKE_TOOL_COMMAND: crashCommand,
		FAKE_PORT: String(FAKE_PORT),
	});
	if (!(await waitFor(() => tail("fake").includes("fake openai endpoint on"), 15_000))) {
		fatal("fake provider did not bind:\n" + tail("fake"));
	}

	// ── 2. Isolated model config ───────────────────────────────────────────
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

	// ── 3. Desktop Electron; its own boot path spawns the daemon ───────────
	if (!fs.existsSync(electronPath)) fatal(`electron binary not found: ${electronPath}`);
	electron = spawnLogged(
		"electron",
		electronPath,
		[path.join("electron", "main.cjs"), `--remote-debugging-port=${CDP_PORT}`],
		isoEnv,
		desktopDir,
	);
	const cdpUp = await waitFor(async () => {
		if (electron.exitCode !== null || electron.signalCode !== null) return false;
		try {
			const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
			if (!res.ok) return false;
			const body = await res.json();
			return typeof body?.webSocketDebuggerUrl === "string";
		} catch {
			return false;
		}
	}, 40_000);
	if (!cdpUp) {
		fatal(`CDP never came up. electron exited=${electron.exitCode}\n${tail("electron")}`);
	}

	browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP_PORT}` });
	const page = await (async () => {
		const deadline = Date.now() + 25_000;
		while (Date.now() < deadline) {
			const found = (await browser.pages()).find(p => p.url().includes("dist/index.html"));
			if (found) return found;
			await sleep(300);
		}
		throw new Error("GUI page (dist/index.html) not found");
	})();
	page.on("console", message => {
		const line = `[page ${Date.now()}] ${message.type()} ${message.text().slice(0, 240)}`;
		pageLog.push(line);
		if (pageLog.length > 400) pageLog.shift();
		console.log(line);
	});
	page.on("pageerror", error => {
		const line = `[pageerror ${Date.now()}] ${String(error).slice(0, 300)}`;
		pageLog.push(line);
		console.log(line);
	});
	await page.setViewport({ width: 1100, height: 760 });
	// A stuck pointer/key interaction must fail the check, not hang the run.
	page.setDefaultTimeout(15_000);
	const shot = name => page.screenshot({ path: path.join(dirs.shots, `${name}.png`) });

	// The first run opens the setup wizard, whose modal owns input and cannot
	// finish against a credential-less scratch root: mark it done, then let the
	// app boot against its default port so the SHELL spawns the daemon.
	await page.evaluate(() => localStorage.setItem("musepi-gui-onboarding-done", String(Date.now())));
	await page.reload({ waitUntil: "domcontentloaded" });
	const booted = await waitFor(
		() =>
			page.evaluate(
				() =>
					!!document.querySelector(".gui-welcome-card, .gui-chat-column") ||
					!!document.querySelector(".gui-transcript"),
			),
		90_000,
		500,
	);
	if (!booted) {
		await shot("boot-stuck");
		fatal("renderer never reached its shell\n" + tail("electron"));
	}

	const daemonReady = await waitFor(async () => {
		const portText = (() => {
			try {
				return Number.parseInt(fs.readFileSync(path.join(dirs.socket, "ws.port"), "utf8").trim(), 10);
			} catch {
				return null;
			}
		})();
		return portText === DAEMON_PORT && (await portOpen(DAEMON_PORT));
	}, 60_000);
	if (!daemonReady) {
		fatal(`the shell never brought a daemon up on :${DAEMON_PORT}\n${tail("electron")}`);
	}
	rpc = await openRpc(DAEMON_PORT);
	const initialRows = await rpc.request("session.list");
	check("0. shell spawned its own isolated daemon", Array.isArray(initialRows), `sessions=${initialRows?.length ?? "?"}`);

	// Dismiss the first-run wizard if it is still mounted. Only `.gui-obo` is
	// treated as a wizard: the pause overlay is always mounted and carries
	// `aria-modal`, so a generic test clicks into a surface nobody can see.
	const wizardUp = () =>
		page.evaluate(() => {
			const host = document.querySelector(".gui-obo");
			if (!host) return false;
			const rect = host.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0;
		});
	if (await wizardUp()) {
		await page.evaluate(() => {
			const host = document.querySelector(".gui-obo");
			const skip = host ? [...host.querySelectorAll("button")].find(b => /跳过|Skip/.test(b.textContent ?? "")) : null;
			skip?.click();
		});
		await sleep(800);
	}

	// ── 4. Scratch session + the tool-call turn ────────────────────────────
	// The welcome composer is the real create-and-send entry: `startNewTask`
	// only resets to the welcome scene, so the turn is submitted from the hero
	// editor exactly as a user would. The editor is CodeMirror (a
	// `contenteditable`), not a textarea, so it needs real key events.
	const knownIds = new Set((initialRows ?? []).map(row => row.id));
	const welcomeEditor = ".gui-welcome-form .cm-content";
	const welcomeText = () =>
		page.evaluate(selector => (document.querySelector(selector)?.textContent ?? "").trim(), welcomeEditor);
	if (
		!(await waitFor(
			() => page.evaluate(selector => !!document.querySelector(selector), welcomeEditor),
			20_000,
			200,
		))
	) {
		await shot("no-welcome-editor");
		fatal("the welcome editor never mounted");
	}
	await page.focus(welcomeEditor);
	await page.keyboard.type(`${promptToken} run the long command`);
	let typedWelcome = await welcomeText();
	if (!typedWelcome.includes(promptToken)) {
		// Focus alone can lose the race against a scene transition; a real click
		// on the editor is the fallback, then type again.
		await page.click(welcomeEditor);
		await page.keyboard.type(`${promptToken} run the long command`);
		typedWelcome = await welcomeText();
	}
	check("1a. prompt text reached the welcome composer", typedWelcome.includes(promptToken), typedWelcome.slice(0, 80));
	await page.keyboard.press("Enter");
	let sessionId = null;
	await waitFor(async () => {
		const rows = await rpc.request("session.list").catch(() => null);
		const row = (rows ?? []).find(candidate => !knownIds.has(candidate.id));
		if (row) sessionId = row.id;
		return sessionId !== null;
	}, 30_000, 400);
	check("1. first prompt created a scratch session", sessionId !== null, sessionId);
	if (!sessionId) {
		await shot("no-session");
		fatal("the welcome composer's submit never created a session");
	}
	console.log(`scratch session: ${sessionId}`);
	if (
		!(await waitFor(
			() => page.evaluate(() => !!document.querySelector('[data-chat-input="true"] .cm-content')),
			25_000,
			300,
		))
	) {
		await shot("no-composer");
		fatal("the session composer never mounted after creating the session");
	}

	const running = await waitFor(async () => (await probeUi(page).catch(() => null))?.stopCapsule === true, 30_000, 250);
	check("2. turn running (stop capsule shown)", running);
	if (!running) {
		await shot("never-running");
		fatal("the turn never entered the running state — cannot stage the crash");
	}

	// The daemon records `tool_execution_start` before the tool runs; seeing the
	// call in `session.pendingToolCalls` while the turn is live proves the crash
	// lands inside a real execution, not between the reply and the tool.
	let livePending = null;
	await waitFor(async () => {
		const response = await rpc
			.request("session.pendingToolCalls", { sessionId })
			.catch(() => null);
		livePending = response?.calls?.[0] ?? null;
		return livePending?.toolName === "bash";
	}, 30_000, 400);
	await expandActivity(page);
	await waitFor(async () => ((await probeUi(page).catch(() => null))?.spinners.length ?? 0) > 0, 5_000, 200);
	const beforeKill = await probeUi(page).catch(() => null);
	if (!beforeKill) fatal("could not read the GUI state before the crash");
	check("3. tool execution started (persisted pending call)", livePending?.toolName === "bash", livePending);
	check("3b. live tool spinner present before the crash", beforeKill.spinners.length > 0, beforeKill.spinners);
	await shot("1-before-kill");

	// ── 5. Crash the daemon, no shutdown handshake ─────────────────────────
	const daemonPid = daemonPidFor(electron.pid) ?? listenerPidOnPort(DAEMON_PORT);
	if (!daemonPid) {
		await shot("no-daemon-pid");
		fatal("cannot resolve the daemon pid (managed registry and listener both empty)");
	}
	killedPid.value = daemonPid;
	console.log(`killing daemon pid ${daemonPid} with taskkill /F /T`);
	const killT0 = Date.now();
	hardKill(daemonPid);
	const died = await waitFor(async () => !(await portOpen(DAEMON_PORT)), 8_000, 150);
	timing.killToPortClosedMs = Date.now() - killT0;
	check("4. daemon died without a shutdown handshake", died, timing);

	// ── 6. Measure the GUI without restarting it ───────────────────────────
	let capsuleClearedMs = null;
	let sendVisibleMs = null;
	let workingAgain = false;
	let splashSeen = false;
	let daemonRespawned = false;
	// What the window looked like at the exact sample where the capsule left.
	// The drop handler sets `booting` in the same tick, so the capsule can go
	// away because the whole shell was replaced by the splash — this sample is
	// what separates that from a stop→send render.
	const capsuleClearView = { splash: null, composer: null, sendButton: null };
	const probe = async () => {
		const snapshot = await probeUi(page).catch(() => null);
		if (!snapshot) return;
		const at = Date.now() - killT0;
		if (snapshot.splash) splashSeen = true;
		if (capsuleClearedMs === null && !snapshot.stopCapsule) {
			capsuleClearedMs = at;
			capsuleClearView.splash = snapshot.splash;
			capsuleClearView.composer = snapshot.composer;
			capsuleClearView.sendButton = snapshot.sendButton;
		}
		if (capsuleClearedMs !== null && snapshot.stopCapsule) workingAgain = true;
		// Only accepted once the replacement daemon is confirmed: the assertion
		// is "the reconnected GUI comes back in send state", not any transient.
		if (
			daemonRespawned &&
			sendVisibleMs === null &&
			snapshot.composer &&
			snapshot.sendButton &&
			!snapshot.stopCapsule
		) {
			sendVisibleMs = at;
		}
	};
	// The store settles the run flag at the close; sample long enough to catch an
	// early re-render flash, not to wait out the daemon respawn (step 7 does).
	const earlyDeadline = killT0 + 30_000;
	let capsuleSettledAt = null;
	while (Date.now() < earlyDeadline) {
		await probe();
		if (capsuleClearedMs !== null && capsuleSettledAt === null) capsuleSettledAt = Date.now();
		if (capsuleSettledAt !== null && Date.now() - capsuleSettledAt > 2_000) break;
		await sleep(120);
	}
	await shot("2-after-kill");
	check(
		"5. stop capsule clears within seconds (adoptIdleState, not pinned)",
		capsuleClearedMs !== null && capsuleClearedMs <= IDLE_TARGET_MS,
		`${capsuleClearedMs}ms (at that sample: splash=${capsuleClearView.splash}, composer=${capsuleClearView.composer})`,
	);
	timing.capsuleClearSplash = capsuleClearView.splash;
	timing.capsuleClearComposer = capsuleClearView.composer;

	// ── 7. Auto-reconnect: a DIFFERENT daemon takes over ───────────────────
	let recoveredPid = null;
	await waitFor(() => {
		recoveredPid = daemonPidFor(electron.pid);
		return recoveredPid !== null && recoveredPid !== daemonPid;
	}, DAEMON_RESPAWN_TIMEOUT_MS, 500);
	timing.daemonRespawnMs = Date.now() - killT0;
	newPid.value = recoveredPid;
	check(
		"7. auto-reconnect respawned a different daemon (no app restart)",
		recoveredPid !== null && recoveredPid !== daemonPid,
		{ killed: daemonPid, respawned: recoveredPid, afterMs: timing.daemonRespawnMs },
	);
	if (!recoveredPid) {
		await shot("no-respawn");
		fatal("no replacement daemon appeared; the GUI could not recover in place");
	}
	if (!(await waitFor(() => portOpen(DAEMON_PORT), 30_000, 300))) fatal("replacement daemon never bound");
	daemonRespawned = true;
	rpc.close();
	rpc = await openRpc(DAEMON_PORT);

	// ── 8. Daemon truth after the crash ────────────────────────────────────
	let crashedRows = null;
	await waitFor(async () => {
		crashedRows = await rpc.request("session.list").catch(() => null);
		return (crashedRows ?? []).some(row => row.id === sessionId);
	}, 30_000, 500);
	const crashedRow = (crashedRows ?? []).find(row => row.id === sessionId);
	check("8. crashed session still present on the new daemon", Boolean(crashedRow), crashedRow?.title);
	check("9. daemon reports the crashed session idle", crashedRow?.working === false, crashedRow?.working);

	// Read this before the GUI opens the session: the reopen triggers its own
	// snapshot/resume, and a second scan can queue behind it.
	let crashedPending = null;
	let pendingError = null;
	// A freshly respawned daemon may still be activating the session's plugin
	// surface; the first snapshot can take tens of seconds, so give the scan a
	// budget beyond the default 8-second RPC ceiling.
	await waitFor(async () => {
		try {
			crashedPending = await rpc.request("session.pendingToolCalls", { sessionId }, 45_000);
			pendingError = null;
			return crashedPending?.calls?.[0]?.toolName === "bash";
		} catch (error) {
			pendingError = String(error);
			return false;
		}
	}, 120_000, 1_000);
	check(
		"10. daemon still names the unanswered tool call",
		crashedPending?.calls?.[0]?.toolName === "bash",
		crashedPending?.calls ?? pendingError,
	);

	// The reconnect restores the session through boot(); a fast replacement
	// daemon can race that reopen and leave the welcome scene with a one-shot
	// "session.open: not connected". Record which happened; when the reopen was
	// lost, open the row the way a user would so the crash state can be judged.
	const shellBack = await waitFor(
		() =>
			page.evaluate(
				() =>
					!!document.querySelector(
						".gui-welcome-form, .gui-chat-column, .gui-transcript, .gui-pane-side",
					),
			),
		40_000,
		300,
	);
	const autoReopened =
		shellBack &&
		(await page.evaluate(() => !!document.querySelector(".gui-chat-column, .gui-transcript")));
	timing.autoReopen = autoReopened;
	if (!autoReopened) {
		// The pause overlay is always mounted inside an aria-modal shell; only a
		// rendered dialog (nonzero box, visible) may block the row click.
		timing.reopenDialog = await page.evaluate(() => {
			const dialogs = [...document.querySelectorAll('[aria-modal="true"], .gui-dialog-backdrop')];
			const visible = dialogs.find(element => {
				const rect = element.getBoundingClientRect();
				const style = getComputedStyle(element);
				return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.opacity !== "0";
			});
			if (!visible) return null;
			const close = [...visible.querySelectorAll("button")].find(button =>
				/关闭|知道了|取消|Close|Dismiss/i.test(button.textContent ?? ""),
			);
			close?.click();
			return (visible.textContent ?? "").trim().slice(0, 160);
		});
		if (timing.reopenDialog) console.log(`reconnect left a dialog up: ${timing.reopenDialog}`);
		await page.keyboard.press("Escape");
		await sleep(400);
		const clicked = await page.evaluate(title => {
			const rows = [...document.querySelectorAll(".gui-session-row")];
			const row = title ? rows.find(candidate => (candidate.textContent ?? "").includes(title)) : rows[0];
			if (!row) return false;
			row.click();
			return true;
		}, crashedRow?.title ?? "");
		timing.reopenedByRowClick = clicked;
		await waitFor(
			() => page.evaluate(() => !!document.querySelector(".gui-chat-column, .gui-transcript")),
			20_000,
			300,
		);
	}

	// The composer returns once the boot path finishes; the daemon's own boot is
	// what took the time above, so this window only covers the reconnect render.
	const sendDeadline = Date.now() + SEND_AFTER_RESPAWN_TIMEOUT_MS;
	while (sendVisibleMs === null && Date.now() < sendDeadline) {
		await probe();
		await sleep(150);
	}
	timing.capsuleClearedMs = capsuleClearedMs;
	timing.sendVisibleMs = sendVisibleMs;
	timing.splashSeen = splashSeen;
	check(
		"6. composer in send state after the replacement daemon was confirmed",
		sendVisibleMs !== null,
		`${sendVisibleMs}ms since the kill (splash seen: ${splashSeen}, auto-reopen: ${autoReopened})`,
	);

	// ── 9. GUI restore: interrupted marker, resume banner, no duplicates ───
	// The in-card note lives inside the round's 活动 fold; a closed fold renders
	// the reply text only, so open the fold (and the tool-run summary inside it)
	// the way a reader would before judging the marker.
	await waitFor(() => page.evaluate(() => document.querySelectorAll(".tr-round-fold").length > 0), 60_000, 500);
	await expandActivity(page);
	let settled = null;
	await waitFor(async () => {
		const snapshot = await probeUi(page).catch(() => null);
		if (!snapshot) return false;
		settled = snapshot;
		return (
			snapshot.composer &&
			snapshot.promptRows >= 1 &&
			snapshot.interrupted.length > 0 &&
			snapshot.banner !== null
		);
	}, 60_000, 500);
	timing.guiRestoredMs = Date.now() - killT0;
	if (!settled) settled = await probeUi(page).catch(() => null);
	if (!settled) fatal("the GUI never offered a readable state after the crash");
	check(
		"11. transcript names the interrupted call (activity fold open)",
		settled.interrupted.some(text => /调用已中断|interrupted/i.test(text)),
		settled.interrupted,
	);
	check(
		"12. resume banner names the tool call and its command",
		settled.banner !== null && /bash/.test(settled.banner) && /sleep|Start-Sleep/.test(settled.banner),
		settled.banner,
	);
	check("13. no live tool spinner after settle", settled.spinners.length === 0, settled.spinners);
	check("14. header shows no running state after settle", settled.headerWorking === false);
	check("15. composer still in send state after settle", settled.composer && settled.sendButton && !settled.stopCapsule);
	check("16. exactly one copy of the turn (no stacked statuses)", settled.promptRows === 1, settled.promptRows);
	check("17. exactly one resume banner", settled.bannerCount === 1, settled.bannerCount);

	// ── 10. Quiet window: the 5-second pending check must not resurrect it ──
	const quietT0 = Date.now();
	let phantomSamples = 0;
	let bannerSamples = 0;
	let spinnerSamples = 0;
	let promptSamples = [];
	while (Date.now() - quietT0 < QUIET_WINDOW_MS) {
		const snapshot = await probeUi(page).catch(() => null);
		if (!snapshot) {
			await sleep(500);
			continue;
		}
		if (snapshot.stopCapsule || snapshot.headerWorking) phantomSamples++;
		bannerSamples = Math.max(bannerSamples, snapshot.bannerCount);
		spinnerSamples = Math.max(spinnerSamples, snapshot.spinners.length);
		promptSamples.push(snapshot.promptRows);
		await sleep(500);
	}
	timing.quietWindowMs = Date.now() - quietT0;
	check("18. no phantom running across the 5s pending check", phantomSamples === 0, `${phantomSamples} samples`);
	check("19. no live spinner across the check", spinnerSamples === 0, spinnerSamples);
	check("20. no banner duplication across the check", bannerSamples === 1, bannerSamples);
	check("21. no turn duplication across the check", promptSamples.every(count => count === 1), promptSamples);
	check("22. no re-render working flash recorded", workingAgain === false);
	await shot("3-after-recovery");

	const failed = results.filter(entry => !entry.ok);
	console.log(`\n== crash idle-adopt verification: ${results.length - failed.length}/${results.length} passed ==`);
	console.log(`timing: ${JSON.stringify(timing)}`);
	fs.writeFileSync(
		path.join(workRoot, "report.json"),
		JSON.stringify(
			{
				passed: failed.length === 0,
				checks: results,
				timing,
				tool: crashCommand,
				sessionId,
				daemons: { killed: daemonPid, respawned: recoveredPid },
				screenshots: fs.readdirSync(dirs.shots).map(name => path.join(dirs.shots, name)),
			},
			null,
			2,
		),
	);
	console.log(`artifacts: ${workRoot}`);
	process.exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
	console.error(error instanceof Fatal ? `\nFATAL: ${error.message}` : error);
	console.error(`--- electron log tail ---\n${tail("electron")}`);
	console.error(`--- fake log tail ---\n${tail("fake")}`);
	if (pageLog.length > 0) console.error(`--- page log tail ---\n${pageLog.slice(-15).join("\n")}`);
	try {
		fs.writeFileSync(path.join(workRoot, "failure.log"), `${pageLog.join("\n")}\n${tail("electron", 60)}`);
	} catch {}
	process.exitCode = 1;
} finally {
	try {
		rpc?.close();
	} catch {}
	try {
		browser && (await browser.disconnect());
	} catch {}
	// The GUI reaps its own daemon on quit; kill the shell first, then every
	// daemon this profile ever started, then the fake provider.
	if (electron && electron.exitCode === null) hardKill(electron.pid ?? -1);
	await sleep(400);
	hardKill(killedPid.value ?? -1);
	hardKill(newPid.value ?? -1);
	for (const entry of registryEntries()) hardKill(entry.pid);
	hardKill(listenerPidOnPort(DAEMON_PORT) ?? -1);
	if (fake && fake.exitCode === null) hardKill(fake.pid ?? -1);
	await sleep(400);
	try {
		fs.rmSync(dirs.socket, { recursive: true, force: true });
	} catch {}
}