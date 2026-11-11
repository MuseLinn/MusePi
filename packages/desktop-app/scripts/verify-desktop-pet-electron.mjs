import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const outDir = process.env.MUSEPI_PET_SMOKE_OUT
	? path.resolve(process.env.MUSEPI_PET_SMOKE_OUT)
	: fs.mkdtempSync(path.join(os.tmpdir(), "musepi-pet-smoke-"));
const userDataDir = path.join(outDir, "user-data");
const require = createRequire(path.join(desktopDir, "package.json"));
const electronPath = require("electron");
const puppeteer = require("puppeteer-core");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const result = { checks: [], screenshots: [] };
const check = (name, ok, detail) => {
	result.checks.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};

fs.mkdirSync(outDir, { recursive: true });
fs.rmSync(userDataDir, { recursive: true, force: true });
const child = spawn(electronPath, [".", "--no-sandbox"], {
	cwd: desktopDir,
	env: {
		...process.env,
		ELECTRON_RUN_AS_NODE: undefined,
		// Electron allocates an available port and publishes it in DevToolsActivePort.
		MUSEPI_CDP_PORT: "0",
		MUSEPI_GUI_USER_DATA: userDataDir,
		// The daemon's config root is separate from Electron's user data: without
		// this the smoke's app-visible sessions come from the developer's real
		// ~/.musepi, so the scripted onboarding never matches its fixture.
		PI_CONFIG_DIR: path.join(userDataDir, "musepi"),
	},
	stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.on("data", chunk => {
	stdout = (stdout + chunk.toString()).slice(-8000);
});
child.stderr.on("data", chunk => {
	stderr = (stderr + chunk.toString()).slice(-8000);
});
let childExited = false;
child.on("exit", () => {
	childExited = true;
});

async function findCdpPort() {
	const activePortFile = path.join(userDataDir, "DevToolsActivePort");
	for (let attempt = 0; attempt < 100 && !childExited; attempt++) {
		try {
			const [firstLine] = fs.readFileSync(activePortFile, "utf8").split(/\r?\n/);
			const port = Number(firstLine);
			if (Number.isInteger(port) && port > 0) {
				const response = await fetch(`http://127.0.0.1:${port}/json/version`);
				if (response.ok) return port;
			}
		} catch {
			// Electron has not published a ready endpoint yet.
		}
		await sleep(200);
	}
	throw new Error(`Electron CDP did not start. ${stderr}${stdout}`);
}

async function capture(name, page) {
	const target = path.join(outDir, `${name}.png`);
	await page.screenshot({ path: target });
	const ok = fs.existsSync(target) && fs.statSync(target).size > 0;
	check(`Electron capture: ${name}`, ok, target);
	if (ok) result.screenshots.push(target);
}

async function stopElectron() {
	if (childExited) return;
	const exited = new Promise(resolve => child.once("exit", resolve));
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
	} else {
		child.kill("SIGTERM");
	}
	await Promise.race([exited, sleep(5000)]);
	if (!childExited) {
		child.kill("SIGKILL");
		await exited;
	}
}

async function gestureState(page) {
	return page.evaluate(() => ({
		gesture: document.querySelector(".gui-pet-svg__gesture")?.getAttribute("transform") ?? "",
		mirrored: document.querySelector(".pet-window__pet-flip--mirror") !== null,
		petdexDrag: document.querySelector(".gui-pet-svg--dragging") !== null,
		doubleSquash: document.querySelector(".pet-window__squash") !== null,
		mood: document.querySelector(".gui-pet-svg--rest") !== null,
		state: document.querySelector(".gui-pet-svg--idle") !== null,
	}));
}

function nativeWindowBounds() {
	if (process.platform !== "win32") throw new Error("Native pet window bounds currently require the Windows smoke harness");
	const script = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PetSmokeNative {
  public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@
$rows = @()
[void][PetSmokeNative]::EnumWindows({
  param($hwnd, $lParam)
  if ([PetSmokeNative]::IsWindowVisible($hwnd)) {
    $text = New-Object System.Text.StringBuilder 512
    [void][PetSmokeNative]::GetWindowText($hwnd, $text, $text.Capacity)
    $title = $text.ToString()
    $windowPid = 0
    [void][PetSmokeNative]::GetWindowThreadProcessId($hwnd, [ref]$windowPid)
    if (($title -eq "MusePi Pet" -or $title -eq "MusePi Pet Bubbles") -and $windowPid -eq ${child.pid}) {
      $rect = New-Object PetSmokeNative+RECT
      [void][PetSmokeNative]::GetWindowRect($hwnd, [ref]$rect)
      $script:rows += [PSCustomObject]@{ Title=$title; Left=$rect.Left; Top=$rect.Top; Right=$rect.Right; Bottom=$rect.Bottom }
    }
  }
  return $true
}, [IntPtr]::Zero)
$rows | ConvertTo-Json -Compress
`;
	const run = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
	if (run.status !== 0) throw new Error(`Native window query failed: ${run.stderr || run.stdout}`);
	const parsed = JSON.parse(run.stdout);
	const rows = Array.isArray(parsed) ? parsed : [parsed];
	return Object.fromEntries(
		rows.map(row => [row.Title, { left: row.Left, top: row.Top, right: row.Right, bottom: row.Bottom }]),
	);
}

async function createNativeWindowProbe(ownerPid) {
	const script = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PetMorphNative {
  public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@
[Console]::Out.WriteLine("READY")
while (($command = [Console]::In.ReadLine()) -ne "quit") {
  if ($command -ne "query") { continue }
  $rows = @()
  [void][PetMorphNative]::EnumWindows({
    param($hwnd, $lParam)
    if ([PetMorphNative]::IsWindowVisible($hwnd)) {
      $text = New-Object System.Text.StringBuilder 512
      [void][PetMorphNative]::GetWindowText($hwnd, $text, $text.Capacity)
      $title = $text.ToString()
      $windowPid = 0
      [void][PetMorphNative]::GetWindowThreadProcessId($hwnd, [ref]$windowPid)
      if (($title -eq "MusePi Pet" -or $title -eq "MusePi Pet Bubbles") -and $windowPid -eq ${ownerPid}) {
        $rect = New-Object PetMorphNative+RECT
        [void][PetMorphNative]::GetWindowRect($hwnd, [ref]$rect)
        $script:rows += [PSCustomObject]@{ Title=$title; Left=$rect.Left; Top=$rect.Top; Right=$rect.Right; Bottom=$rect.Bottom }
      }
    }
    return $true
  }, [IntPtr]::Zero)
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject @($rows) -Compress))
}
`;
	const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	const lines = [];
	const readers = [];
	let buffered = "";
	let stderr = "";
	child.stderr.on("data", chunk => {
		stderr += chunk.toString();
	});
	child.stdout.on("data", chunk => {
		buffered += chunk.toString();
		const parts = buffered.split(/\r?\n/);
		buffered = parts.pop() ?? "";
		for (const line of parts) {
			if (readers.length > 0) readers.shift()(line);
			else lines.push(line);
		}
	});
	const nextLine = () => {
		if (lines.length > 0) return Promise.resolve(lines.shift());
		return new Promise(resolve => readers.push(resolve));
	};
	if ((await nextLine()) !== "READY") throw new Error(`Native probe failed to start: ${stderr}`);
	return {
		async bounds() {
			child.stdin.write("query\n");
			const parsed = JSON.parse(await nextLine());
			return Object.fromEntries(
				parsed.map(row => [row.Title, { left: row.Left, top: row.Top, right: row.Right, bottom: row.Bottom }]),
			);
		},
		async close() {
			const exited = new Promise(resolve => child.once("exit", resolve));
			child.stdin.write("quit\n");
			await Promise.race([exited, sleep(2000)]);
			if (child.exitCode === null) child.kill();
		},
	};
}

async function traceNativeBubbleMorph(petPage, bubblesPage, action) {
	if (process.platform !== "win32") {
		await action();
		return [];
	}
	const probe = await createNativeWindowProbe(child.pid);
	const samples = [];
	const startedAt = Date.now();
	const pendingAction = action();
	try {
		do {
			const [nativeWindows, spriteTop, stack] = await Promise.all([
				probe.bounds(),
				petPage.evaluate(() => document.querySelector(".pet-window__pet")?.getBoundingClientRect().top ?? 0),
				bubblesPage.evaluate(() => {
					const element = document.querySelector(".pet-bubbles");
					return {
						morphing: Boolean(document.querySelector(".pet-bubbles--morphing")),
						mode: document.querySelector(".pet-bubbles--expanded") ? "expanded" : "stacked",
						stackHeight: element?.offsetHeight ?? 0,
						viewportHeight: innerHeight,
						animations: element?.getAnimations().map(animation => animation.playState) ?? [],
					};
				}),
			]);
			const bubble = nativeWindows["MusePi Pet Bubbles"];
			const pet = nativeWindows["MusePi Pet"];
			if (bubble && pet) {
				samples.push({
					at: Date.now() - startedAt,
					gap: pet.top + spriteTop - bubble.bottom,
					width: bubble.right - bubble.left,
					height: bubble.bottom - bubble.top,
					bubble,
					pet,
					spriteTop,
					...stack,
				});
			}
			await sleep(16);
		} while (Date.now() - startedAt < 700);
		await pendingAction;
		return samples;
	} finally {
		await probe.close();
	}
}

function positionNativeCursor(dipX, dipY, dpr, button = null) {
	if (process.platform !== "win32") return;
	const x = Math.round(dipX * dpr);
	const y = Math.round(dipY * dpr);
	const buttonScript = button === "down"
		? "[PetSmokeCursor]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)"
		: button === "up"
			? "[PetSmokeCursor]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)"
			: "";
	const script = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PetSmokeCursor {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
'@
[void][PetSmokeCursor]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
if (-not [PetSmokeCursor]::SetCursorPos(${x}, ${y})) { throw "SetCursorPos failed" }
${buttonScript}
`;
	const run = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
	if (run.status !== 0) throw new Error(`Native cursor positioning failed: ${run.stderr || run.stdout}`);
}

try {
	const port = await findCdpPort();
	const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
	try {
		let mainPage;
		for (let attempt = 0; attempt < 100; attempt++) {
			const pages = await browser.pages();
			mainPage = pages.find(page => page.url().includes("/index.html"));
			if (mainPage) break;
			await sleep(200);
		}
		if (!mainPage) throw new Error("Main MusePi window was not found");
		const rendererErrors = [];
		mainPage.on("pageerror", error => rendererErrors.push(String(error)));
		mainPage.on("console", message => {
			if (message.type() === "error") rendererErrors.push(message.text());
		});
		// The first-run overlay proves that the full React tree and its event
		// listener are mounted; the splash can outlive the daemon connection.
		try {
			await mainPage.waitForFunction(() => Boolean(document.querySelector('.gui-onboarding-backdrop, [role="dialog"][aria-modal="true"]')), { timeout: 30000 });
		} catch (error) {
			const state = await mainPage.evaluate(() => ({
				url: location.href,
				bodyText: document.body.innerText.slice(0, 1600),
				root: document.querySelector("#root")?.innerHTML.slice(0, 1600) ?? "",
				overlay: document.querySelector(".gui-onboarding")?.outerHTML.slice(0, 1600) ?? "",
			}));
			await capture("onboarding-initial-failure", mainPage);
			throw new Error(`${String(error)}; initial state=${JSON.stringify(state)}; rendererErrors=${JSON.stringify(rendererErrors)}`);
		}
		// Keep the same preload bridge, but unmount the real App so its recent-
		// session polling cannot overwrite the deterministic activity fixtures.
		await mainPage.goto(pathToFileURL(path.join(desktopDir, "dist", "pin.html")).href);
		await mainPage.evaluate(`//!world=main
			window.__petPhase2 = { opens: [], commands: [] };
			window.electronAPI.onPetOpenSession(id => window.__petPhase2.opens.push(id));
			window.electronAPI.onPetCommand(command => window.__petPhase2.commands.push(command));
			window.electronAPI.setPetVisible(true);
		`);
		await sleep(1000);
		await mainPage.evaluate(`//!world=main
			window.electronAPI.petActivity({
				theme: "dark",
				mood: "rest",
				petState: "idle",
				pet: { kind: "builtin", id: "musepi-note-bot" }
			});
		`);

		let petPage;
		let observedPetPage;
		for (let attempt = 0; attempt < 75; attempt++) {
			const pages = await browser.pages();
			petPage = pages.find(page => page.url().includes("/pet.html"));
			if (petPage) observedPetPage = petPage;
			if (petPage && await petPage.evaluate(() => Boolean(document.querySelector(".gui-pet-svg__gesture")))) break;
			petPage = undefined;
			await sleep(200);
		}
		if (!petPage) {
			const debug = observedPetPage
				? await observedPetPage.evaluate(() => ({ html: document.querySelector(".pet-window")?.outerHTML.slice(0, 1200) ?? document.body.innerHTML.slice(0, 1200) }))
				: { pages: (await browser.pages()).map(page => page.url()) };
			throw new Error(`Vector pet window did not render: ${JSON.stringify(debug)}`);
		}
		await petPage.evaluate(() => {
			window.__petPhase2Events = [];
			const pet = document.querySelector(".pet-window__pet");
			for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"]) {
				pet?.addEventListener(type, event => {
					window.__petPhase2Events.push({ type, clientX: event.clientX, clientY: event.clientY, screenX: window.screenX, screenY: window.screenY });
				});
			}
		});
		const geometry = await petPage.evaluate(() => {
			const rect = document.querySelector(".pet-window__pet")?.getBoundingClientRect();
			return rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, dpr: devicePixelRatio } : null;
		});
		if (!geometry) throw new Error("Pet hit area was not found");
		const petNativeBeforeDrag = process.platform === "win32" ? nativeWindowBounds()["MusePi Pet"] : null;
		const moveDragOffset = async offset => {
			if (petNativeBeforeDrag) {
				positionNativeCursor(
					petNativeBeforeDrag.left + geometry.x + offset,
					petNativeBeforeDrag.top + geometry.y - offset / 4,
					geometry.dpr,
				);
			} else {
				await petPage.mouse.move(geometry.x + offset, geometry.y - offset / 4);
			}
			await sleep(60);
		};
		if (petNativeBeforeDrag) {
			// CDP input does not move the OS cursor and mixing it with native
			// motion loses pointer capture. Use one native input stream for
			// Windows so the cursor anchor and pointer buttons stay consistent.
			const dragX = petNativeBeforeDrag.left + geometry.x;
			const dragY = petNativeBeforeDrag.top + geometry.y;
			positionNativeCursor(dragX, dragY, geometry.dpr);
			// The native click-through poll runs every 120ms. Let it enable the
			// pet hitbox before pressing, otherwise the down event reaches the desktop.
			await sleep(200);
			positionNativeCursor(dragX, dragY, geometry.dpr, "down");
		} else {
			await petPage.mouse.move(geometry.x, geometry.y);
			await petPage.mouse.down();
		}
		for (const offset of [12, 28, 44]) await moveDragOffset(offset);
		if (petNativeBeforeDrag) {
			const petNativeAfterDrag = nativeWindowBounds()["MusePi Pet"];
			const nativeDragDelta = {
				x: petNativeAfterDrag.left - petNativeBeforeDrag.left,
				y: petNativeAfterDrag.top - petNativeBeforeDrag.top,
			};
			// The first 12px move crosses the threshold and establishes the
			// anchor; only subsequent cursor travel moves the native window.
			const nativeExpectedDelta = { x: 44 - 12, y: -11 + 3 };
			check(
				"real native pet drag tracks the pointer in DIP without DPR scaling",
				Math.abs(nativeDragDelta.x - nativeExpectedDelta.x) <= 2 && Math.abs(nativeDragDelta.y - nativeExpectedDelta.y) <= 2,
				{ petNativeBeforeDrag, petNativeAfterDrag, nativeDragDelta, nativeExpectedDelta },
			);
		}
		const dragged = await gestureState(petPage);
		const dragEvents = await petPage.evaluate(() => window.__petPhase2Events);
		check(
			"real Electron orb drag uses continuous gestures without Petdex direction",
			dragged.gesture.length > 0 && !dragged.mirrored && !dragged.petdexDrag && !dragged.doubleSquash && dragged.mood && dragged.state,
			{ ...dragged, events: dragEvents },
		);
		await capture("pet-orb-drag-electron", petPage);
		for (const offset of [24, 0, -28]) await moveDragOffset(offset);
		const reversed = await gestureState(petPage);
		check("real Electron orb reversal remains continuous and unmirrored", reversed.gesture.length > 0 && !reversed.mirrored && !reversed.petdexDrag, reversed);
		if (petNativeBeforeDrag) {
			positionNativeCursor(
				petNativeBeforeDrag.left + geometry.x - 28,
				petNativeBeforeDrag.top + geometry.y + 7,
				geometry.dpr,
				"up",
			);
		} else {
			await petPage.mouse.up();
		}
		await petPage.waitForFunction(() => !(document.querySelector(".gui-pet-svg__gesture")?.getAttribute("transform") ?? "").includes("rotate("), { timeout: 4000 });
		const released = await gestureState(petPage);
		check("real Electron orb release settles without residual tilt", !released.gesture.includes("rotate(") && !released.mirrored, released);

			await mainPage.evaluate(`//!world=main
				window.electronAPI.petActivity({
					mood: "rest",
					petState: "idle",
					pet: {
						kind: "petdex",
						pkg: {
							id: "musepi",
							displayName: "MusePi",
							spritesheet: "./pets/musepi.webp",
							width: 2048,
							height: 2304,
							rows: [6, 4, 4, 0, 0, 4, 4, 4, 4],
							contentH: 201,
							smooth: true,
							importedAt: 0
						}
					}
				});
			`);
			await petPage.waitForFunction(() => Boolean(document.querySelector(".gui-petdex-sprite")), { timeout: 4000 });
			await sleep(400);
			const petdexFrame = await petPage.evaluate(() => {
				const sprite = document.querySelector(".gui-petdex-sprite");
				if (!sprite) return null;
				const style = getComputedStyle(sprite);
				const rect = sprite.getBoundingClientRect();
				const background = style.backgroundSize.split(" ").map(value => Number.parseFloat(value));
				return {
					artWidth: Number.parseFloat(style.width),
					artHeight: Number.parseFloat(style.height),
					backgroundWidth: background[0],
					backgroundHeight: background[1],
					renderedWidth: rect.width,
					renderedHeight: rect.height,
					builtinPresent: Boolean(document.querySelector(".gui-pet-svg")),
					mirrored: Boolean(document.querySelector(".pet-window__pet-flip--mirror")),
				};
			});
			check(
				"real Petdex state frame crops the full 8x9 sheet instead of squeezing it",
				petdexFrame &&
					Math.abs(petdexFrame.backgroundWidth - petdexFrame.artWidth * 8) < 0.1 &&
					Math.abs(petdexFrame.backgroundHeight - petdexFrame.artHeight * 9) < 0.1 &&
					!petdexFrame.builtinPresent &&
					!petdexFrame.mirrored,
				petdexFrame,
			);
			await capture("pet-petedex-state-electron", petPage);

			await mainPage.evaluate(`//!world=main
				window.electronAPI.petActivity({
					mood: "rest",
					petState: "idle",
					pet: { kind: "builtin", id: "musepi-note-bot" }
				});
			`);
			await petPage.waitForFunction(() => Boolean(document.querySelector(".gui-pet-svg__gesture")), { timeout: 4000 });
			await petPage.waitForFunction(() => (document.querySelector(".gui-pet-svg__gesture")?.getAttribute("transform") ?? "").length > 0, { timeout: 4000 });
			const restored = await gestureState(petPage);
			check(
				"real Petdex to orb switch restores only the vector renderer",
				restored.gesture.length > 0 && restored.state && !restored.mirrored && !restored.doubleSquash &&
					await petPage.evaluate(() => !document.querySelector(".gui-petdex-sprite")),
				restored,
			);

		await mainPage.evaluate(`//!world=main
			window.__petPhase2Card = {
				sessionId: "phase2-session",
				title: "桌宠原生验证",
				phase: "done",
				statusText: "已完成",
				replyPreview: "圆角、收起与独立打开入口。"
			};
			window.__petPhase2SecondCard = {
				sessionId: "phase2-background-session",
				title: "后台会话",
				phase: "working",
				statusText: "正在处理"
			};
			window.__petPhase2Push = () => window.electronAPI.petActivity({
				sessions: [window.__petPhase2Card, window.__petPhase2SecondCard],
				approval: { requestId: "phase2-approval", tool: "bash" }
			});
			window.__petPhase2Push();
			window.__petPhase2Timer = setInterval(window.__petPhase2Push, 150);
		`);
		let bubblesPage;
		let observedBubblesPage;
		const bubbleRendererErrors = [];
		for (let attempt = 0; attempt < 75; attempt++) {
			const pages = await browser.pages();
			bubblesPage = pages.find(page => page.url().includes("/bubbles.html"));
			if (bubblesPage && bubblesPage !== observedBubblesPage) {
				observedBubblesPage = bubblesPage;
				bubblesPage.on("pageerror", error => bubbleRendererErrors.push(String(error)));
				bubblesPage.on("console", message => {
					if (message.type() === "error") bubbleRendererErrors.push(message.text());
				});
			}
			if (bubblesPage && await bubblesPage.evaluate(() => Boolean(document.querySelector(".pet-bubbles--stacked > .pet-bubble")))) break;
			bubblesPage = undefined;
			await sleep(200);
		}
		await mainPage.evaluate(`//!world=main\nclearInterval(window.__petPhase2Timer)`);
		if (!bubblesPage) {
			const debug = observedBubblesPage
				? await observedBubblesPage.evaluate(() => ({
					bodyText: document.body.innerText.slice(0, 1200),
					root: document.querySelector("#root")?.innerHTML.slice(0, 1600) ?? "",
				}))
				: { pages: (await browser.pages()).map(page => page.url()) };
			if (observedBubblesPage) await capture("pet-bubbles-render-failure", observedBubblesPage);
			throw new Error(`Real bubbles window did not render its session card: ${JSON.stringify({ debug, bubbleRendererErrors, rendererErrors })}`);
		}
		await sleep(600);
		const stacked = await bubblesPage.evaluate(() => {
			const card = document.querySelector(".pet-bubble");
			const style = card ? getComputedStyle(card) : null;
			return {
				stacked: Boolean(document.querySelector(".pet-bubbles--stacked")),
				radius: style?.borderTopLeftRadius ?? "",
				more: document.querySelector(".pet-bubble__more")?.textContent ?? "",
				backgroundImage: style?.backgroundImage ?? "",
				borderColor: style?.borderTopColor ?? "",
				boxShadow: style?.boxShadow ?? "",
				cardSize: card ? { width: card.offsetWidth, height: card.offsetHeight } : null,
				layers: Array.from(document.querySelectorAll(".pet-bubbles__stack-layer")).map(element => ({
					className: element.className,
					hidden: element.getAttribute("aria-hidden"),
					pointerEvents: getComputedStyle(element).pointerEvents,
					width: element.offsetWidth,
					height: element.offsetHeight,
				})),
			};
		});
		check("real bubble stack uses 20px rounded cards", stacked.stacked && stacked.radius === "20px" && stacked.more.length > 0, stacked);
		check(
			"real collapsed stack renders inert near and far card backs",
			stacked.layers.length === 2 && stacked.layers.every(layer => layer.hidden === "true" && layer.pointerEvents === "none"),
			stacked.layers,
		);
		check(
			"real collapsed card backs match the priority card geometry",
			stacked.cardSize && stacked.layers.every(layer => layer.width === stacked.cardSize.width && layer.height === stacked.cardSize.height),
			{ cardSize: stacked.cardSize, layers: stacked.layers },
		);
		check(
			"real bubble card resolves the shared liquid-glass material",
			stacked.backgroundImage.includes("linear-gradient") && stacked.borderColor !== "rgba(0, 0, 0, 0)" && stacked.boxShadow !== "none",
			{ backgroundImage: stacked.backgroundImage, borderColor: stacked.borderColor, boxShadow: stacked.boxShadow },
		);
		check("real priority card uses the 320px reference width", stacked.cardSize?.width === 320, stacked.cardSize);
		if (process.platform === "win32") {
			await petPage.waitForFunction(() => {
				const pet = document.querySelector(".pet-window__pet");
				return !pet || pet.getAnimations().every(animation => animation.playState !== "running");
			}, { timeout: 3000 });
			// Let the final renderer rect report reach the native bubble layout.
			await sleep(100);
			const nativeWindows = nativeWindowBounds();
			const bubbleNativeBounds = nativeWindows["MusePi Pet Bubbles"];
			const petNativeBounds = nativeWindows["MusePi Pet"];
			const petSprite = await petPage.evaluate(() => ({
				top: document.querySelector(".pet-window__pet")?.getBoundingClientRect().top ?? 0,
				dpr: devicePixelRatio,
			}));
			// Win32 GetWindowRect and renderer client rects are both DIP here.
			// Multiplying only the DOM offset by DPR mixes coordinate systems.
			const nativeGap = petNativeBounds.top + petSprite.top - bubbleNativeBounds.bottom;
			const expectedGap = 8;
			check("real native windows keep an 8px bubble-to-sprite gap", Math.abs(nativeGap - expectedGap) <= 1, {
				bubbleNativeBounds,
				petNativeBounds,
				petSprite,
				nativeGap,
				expectedGap,
			});
		}
		check(
			"real stacked mode shows the shared arrow beside the pet",
			await petPage.evaluate(() => document.querySelector(".pet-window__badge")?.textContent === "⌃"),
		);
		await petPage.click(".pet-window__badge");
		await petPage.waitForFunction(() => Boolean(document.querySelector(".pet-window__badge--hidden")), { timeout: 3000 });
		const countMode = await petPage.evaluate(() => ({
			text: document.querySelector(".pet-window__badge")?.textContent ?? "",
			bubbleContent: Boolean(document.querySelector(".pet-bubbles")),
		}));
		const countBubbleContent = await bubblesPage.evaluate(() => Boolean(document.querySelector(".pet-bubbles")));
		check("real pet control advances stacked to count and hides cards", countMode.text === "3" && !countBubbleContent, {
			...countMode,
			bubbleContent: countBubbleContent,
		});
		await petPage.click(".pet-window__badge");
		await bubblesPage.waitForFunction(() => Boolean(document.querySelector(".pet-bubbles--stacked")), { timeout: 3000 });
		check("real pet control restores count to stacked without marking cards read", true);
		await capture("pet-bubbles-stacked-native", bubblesPage);
		await bubblesPage.evaluate(() => {
			window.__petPhase2MorphTransitions = [];
			const stack = document.querySelector(".pet-bubbles");
			if (!stack) return;
			new MutationObserver(() => {
				if (stack.classList.contains("pet-bubbles--morphing")) {
					window.__petPhase2MorphTransitions.push({
						transition: stack.style.transition,
						liquid: getComputedStyle(stack).getPropertyValue("--spring-liquid").trim(),
					});
				}
			}).observe(stack, { attributes: true, attributeFilter: ["class", "style"] });
		});
		const expandedMorphSamples = await traceNativeBubbleMorph(petPage, bubblesPage, () =>
			bubblesPage.click(".pet-bubbles--stacked > .pet-bubble"),
		);
		check(
			"real native bubble geometry tracks the renderer throughout expansion",
			process.platform !== "win32" ||
				(expandedMorphSamples.some(sample => sample.morphing) &&
					expandedMorphSamples.every(sample => Math.abs(sample.gap - 8) <= 1) &&
					expandedMorphSamples.every(sample => Math.abs(sample.width - expandedMorphSamples[0].width) <= 1) &&
					new Set(expandedMorphSamples.map(sample => sample.height)).size >= 3 &&
					Math.abs(expandedMorphSamples.at(-1).viewportHeight - expandedMorphSamples.at(-1).stackHeight - 24) <= 2),
			expandedMorphSamples,
		);
		check("real stacked card expands from its body", await bubblesPage.evaluate(() => Boolean(document.querySelector(".pet-bubbles--expanded"))));
		const morph = await bubblesPage.evaluate(() => window.__petPhase2MorphTransitions);
		const normalizeCss = value => value.replaceAll(" ", "").replace(/(^|[(,])0\./g, "$1.");
		check(
			"real stack morph uses the shared liquid spring",
			morph.some(sample => sample.liquid && sample.transition.includes("width 320ms") && normalizeCss(sample.transition).includes(normalizeCss(sample.liquid))),
			morph,
		);
		await capture("pet-bubbles-expanded-native", bubblesPage);
		const expandedGeometry = await bubblesPage.evaluate(() => {
			const rect = element => {
				if (!element) return null;
				const bounds = element.getBoundingClientRect();
				return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom };
			};
			const inside = bounds => Boolean(bounds) && bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight;
			const clear = rect(document.querySelector(".pet-bubbles__clear"));
			const stack = rect(document.querySelector(".pet-bubbles"));
			const actions = Array.from(document.querySelectorAll(".pet-bubble button"))
				.filter(element => element.getClientRects().length > 0)
				.map(element => ({ className: element.className, ...rect(element) }));
			const unreadActions = document.querySelector(".pet-bubble--unread .pet-bubble__actions");
			return {
				viewport: { width: innerWidth, height: innerHeight },
				scrollWidth: document.documentElement.scrollWidth,
				clear,
				stack,
				actions,
				fabPresent: Boolean(document.querySelector(".pet-bubbles__fab")),
				unreadActionsWidth: unreadActions?.getBoundingClientRect().width ?? 0,
				ok: inside(clear) && inside(stack) && actions.every(inside) && document.documentElement.scrollWidth <= innerWidth,
			};
		});
		check("real expanded bubble controls stay inside the window", expandedGeometry.ok, expandedGeometry);
		check(
			"real expanded mode removes the duplicate fab and exposes unread actions",
			!expandedGeometry.fabPresent && Math.abs(expandedGeometry.unreadActionsWidth - 80) < 0.01,
			expandedGeometry,
		);
		const horizontalActionSamples = await traceNativeBubbleMorph(petPage, bubblesPage, () =>
			bubblesPage.hover(".pet-bubble--working"),
		);
		check(
			"real horizontal actions do not jitter native bubble width or pet gap",
			process.platform !== "win32" ||
				(horizontalActionSamples.length > 0 &&
					horizontalActionSamples.every(sample => Math.abs(sample.gap - 8) <= 1) &&
					horizontalActionSamples.every(sample => Math.abs(sample.width - horizontalActionSamples[0].width) <= 1) &&
					horizontalActionSamples.every(sample => Math.abs(sample.height - horizontalActionSamples[0].height) <= 1)),
			horizontalActionSamples,
		);
		await bubblesPage.hover(".pet-bubble--session");
		await bubblesPage.waitForFunction(
			() => getComputedStyle(document.querySelector(".pet-bubble--session .pet-bubble__dismiss")).opacity === "1",
			{ timeout: 1500 },
		);
		check("real dismiss control appears on card hover", true);

		await bubblesPage.click(".pet-bubble--session .pet-bubble__action--open + .pet-bubble__action");
		await sleep(200);
		// The reply row is mounted while closed so its height can animate; the
		// click must OPEN the row (zero → content height), not merely leave it
		// in the DOM.
		const reply = await bubblesPage.evaluate(() => {
			const row = document.querySelector(".pet-bubble__reply-wrap--open");
			return {
				openRow: Boolean(row),
				rowHeight: row ? row.getBoundingClientRect().height : 0,
				expanded: Boolean(document.querySelector(".pet-bubbles--expanded")),
			};
		});
		const opensAfterReply = await mainPage.evaluate(`//!world=main\nwindow.__petPhase2.opens`);
		check("real reply action neither collapses nor opens the card", reply.openRow && reply.rowHeight > 0 && reply.expanded && opensAfterReply.length === 0, { ...reply, opensAfterReply });
		const materials = await bubblesPage.evaluate(() =>
			[".pet-bubbles__clear", ".pet-bubble__reply"].map(selector => {
				const element = document.querySelector(selector);
				const style = element ? getComputedStyle(element) : null;
				const bounds = element?.getBoundingClientRect();
				return {
					selector,
					backgroundImage: style?.backgroundImage ?? "",
					borderColor: style?.borderTopColor ?? "",
					inside: Boolean(bounds) && bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight,
				};
			}),
		);
		check(
			"real expanded clear control and reply share glass and stay visible",
			materials.every(item => item.backgroundImage.includes("linear-gradient") && item.borderColor !== "rgba(0, 0, 0, 0)" && item.inside),
			materials,
		);
		await bubblesPage.keyboard.press("Escape");
		await bubblesPage.click(".pet-bubble--session .pet-bubble__body");
		await sleep(250);
		const opened = await mainPage.evaluate(`//!world=main\nwindow.__petPhase2.opens`);
		check(
			"real expanded body opens its session and keeps the list expanded",
			opened.length === 1 && opened[0] === "phase2-session" && await bubblesPage.evaluate(() => Boolean(document.querySelector(".pet-bubbles--expanded"))),
			opened,
		);
		const collapsedMorphSamples = await traceNativeBubbleMorph(petPage, bubblesPage, () =>
			petPage.evaluate(() => document.querySelector(".pet-window__badge")?.click()),
		);
		check(
			"real native bubble geometry tracks the renderer throughout collapse",
			process.platform !== "win32" ||
				(collapsedMorphSamples.some(sample => sample.morphing) &&
					collapsedMorphSamples.every(sample => Math.abs(sample.gap - 8) <= 1) &&
					collapsedMorphSamples.every(sample => Math.abs(sample.width - collapsedMorphSamples[0].width) <= 1) &&
					new Set(collapsedMorphSamples.map(sample => sample.height)).size >= 3 &&
					Math.abs(collapsedMorphSamples.at(-1).viewportHeight - collapsedMorphSamples.at(-1).stackHeight - 24) <= 2),
			collapsedMorphSamples,
		);
		await bubblesPage.waitForFunction(() => Boolean(document.querySelector(".pet-bubbles--stacked")), { timeout: 3000 });
		const opensAfterCollapse = await mainPage.evaluate(`//!world=main\nwindow.__petPhase2.opens`);
		check("real pet control collapses expanded to stacked without opening again", opensAfterCollapse.length === 1, opensAfterCollapse);

		await bubblesPage.click(".pet-bubbles--stacked > .pet-bubble");
		await sleep(600);
		await bubblesPage.hover(".pet-bubble--question .pet-bubble__action--primary");
		await sleep(180);
		await bubblesPage.click(".pet-bubble--question .pet-bubble__action--primary");
		await sleep(250);
		const approval = await bubblesPage.evaluate(() => ({
			question: Boolean(document.querySelector(".pet-bubble--question")),
			expanded: Boolean(document.querySelector(".pet-bubbles--expanded")),
		}));
		const commands = await mainPage.evaluate(`//!world=main\nwindow.__petPhase2.commands`);
		check("real approval confirms without activating the card body", !approval.question && approval.expanded && commands.some(command => command.type === "approve" && command.requestId === "phase2-approval" && command.approved === true), { ...approval, commands });

		await bubblesPage.hover(".pet-bubble--session .pet-bubble__dismiss");
		await sleep(180);
		await bubblesPage.click(".pet-bubble--session .pet-bubble__dismiss");
		await sleep(250);
		const dismissed = await bubblesPage.evaluate(() => document.querySelectorAll(".pet-bubble").length);
		check("real dismiss closes only its own card", dismissed === 1, dismissed);
		await bubblesPage.hover(".pet-bubble--session .pet-bubble__dismiss");
		await sleep(180);
		await bubblesPage.click(".pet-bubble--session .pet-bubble__dismiss");
		await bubblesPage.waitForFunction(() => document.querySelectorAll(".pet-bubble").length === 0, { timeout: 3000 });
		check("real working card dismiss clears the remaining card", true);

		await mainPage.evaluate(`//!world=main
			window.__petPriorityWorking = { ...window.__petPhase2SecondCard, activityKey: "working-1" };
			window.__petPriorityDone = { ...window.__petPhase2Card, activityKey: "done-1" };
			window.electronAPI.petActivity({ sessions: [window.__petPriorityWorking] });
		`);
		await bubblesPage.waitForFunction(() => document.querySelector(".pet-bubble--working"), { timeout: 3000 });
		await mainPage.evaluate(`//!world=main
			window.electronAPI.petActivity({ sessions: [window.__petPriorityWorking, window.__petPriorityDone] });
		`);
		await bubblesPage.waitForFunction(() => document.querySelector(".pet-bubble--done"), { timeout: 3000 });
		const priorityTitle = () => bubblesPage.evaluate(() => document.querySelector(".pet-bubbles > .pet-bubble .pet-bubble__title")?.textContent ?? "");
		check("real new completion promotes ahead of a working card", await priorityTitle() === "桌宠原生验证", await priorityTitle());
		await mainPage.evaluate(`//!world=main
			window.electronAPI.petActivity({ sessions: [window.__petPriorityDone, window.__petPriorityWorking] });
		`);
		await sleep(150);
		check("real repeated snapshots do not steal notification priority", await priorityTitle() === "桌宠原生验证", await priorityTitle());
		await mainPage.evaluate(`//!world=main
			window.__petPriorityWorking = { ...window.__petPriorityWorking, phase: "error", activityKey: "working-2" };
			window.electronAPI.petActivity({ sessions: [window.__petPriorityDone, window.__petPriorityWorking] });
		`);
		await bubblesPage.waitForFunction(() => document.querySelector(".pet-bubble--error"), { timeout: 3000 });
		check("real new error activity takes priority", await priorityTitle() === "后台会话", await priorityTitle());

		// Native mode clicks are covered above. Drive the control directly here
		// to isolate notification state from native window movement and hitbox polling.
		await petPage.evaluate(() => document.querySelector(".pet-window__badge")?.click());
		await bubblesPage.waitForFunction(() => Boolean(document.querySelector(".pet-bubbles--stacked")), { timeout: 3000 });
		await petPage.evaluate(() => document.querySelector(".pet-window__badge")?.click());
		await petPage.waitForFunction(() => Boolean(document.querySelector(".pet-window__badge--hidden")), { timeout: 3000 });
		check(
			"real count mode keeps the pet control and hidden cards in sync",
			await petPage.evaluate(() => document.querySelector(".pet-window__badge")?.textContent === "2") &&
				(await bubblesPage.evaluate(() => !document.querySelector(".pet-bubbles"))),
		);
		await mainPage.evaluate(`//!world=main
			window.electronAPI.petActivity({ sessions: [window.__petPriorityDone, window.__petPriorityWorking] });
		`);
		await sleep(200);
		check(
			"real unchanged activity stays in count mode",
			await bubblesPage.evaluate(() => !document.querySelector(".pet-bubbles")),
		);
		await mainPage.evaluate(`//!world=main
			window.__petPriorityDone = { ...window.__petPriorityDone, activityKey: "done-2" };
			window.electronAPI.petActivity({
				sessions: [window.__petPriorityDone, window.__petPriorityWorking],
				approval: { requestId: "clear-approval", tool: "bash" }
			});
		`);
		await bubblesPage.waitForFunction(() => Boolean(document.querySelector(".pet-bubbles--stacked")), { timeout: 3000 });
		check(
			"real new activity and approval restore stacked mode",
			await bubblesPage.evaluate(() => Boolean(document.querySelector(".pet-bubbles--stacked > .pet-bubble--question"))),
		);

		await bubblesPage.click(".pet-bubbles--stacked > .pet-bubble");
		await bubblesPage.waitForFunction(() => Boolean(document.querySelector(".pet-bubbles--expanded")), { timeout: 3000 });
		const commandsBeforeClear = await mainPage.evaluate(`//!world=main\nwindow.__petPhase2.commands`);
		await bubblesPage.click(".pet-bubbles__clear");
		await bubblesPage.waitForFunction(() => !document.querySelector(".pet-bubbles"), { timeout: 3000 });
		const commandsAfterClear = await mainPage.evaluate(`//!world=main\nwindow.__petPhase2.commands`);
		check(
			"real clear-all has no read or approval side effects",
			JSON.stringify(commandsAfterClear) === JSON.stringify(commandsBeforeClear),
			{ commandsBeforeClear, commandsAfterClear },
		);
		await mainPage.evaluate(`//!world=main
			window.electronAPI.petActivity({
				sessions: [window.__petPriorityDone, window.__petPriorityWorking],
				approval: { requestId: "clear-approval", tool: "bash" }
			});
		`);
		await sleep(200);
		check(
			"real cleared activity and request stay dismissed on repeated polls",
			await bubblesPage.evaluate(() => !document.querySelector(".pet-bubbles")),
		);
		await mainPage.evaluate(`//!world=main
			window.__petPriorityDone = { ...window.__petPriorityDone, activityKey: "done-3" };
			window.electronAPI.petActivity({
				sessions: [window.__petPriorityDone, window.__petPriorityWorking],
				approval: { requestId: "clear-approval-2", tool: "bash" }
			});
		`);
		await bubblesPage.waitForFunction(() => Boolean(document.querySelector(".pet-bubbles--stacked")), { timeout: 3000 });
		await bubblesPage.click(".pet-bubbles--stacked > .pet-bubble");
		await bubblesPage.waitForFunction(() => document.querySelectorAll(".pet-bubbles--expanded .pet-bubble").length === 2, { timeout: 3000 });
		check("real new activity revision and request id can notify again", true);
		await bubblesPage.click(".pet-bubbles__clear");
		await bubblesPage.waitForFunction(() => !document.querySelector(".pet-bubbles"), { timeout: 3000 });

		await mainPage.evaluate(`//!world=main
			window.electronAPI.petActivity({
				sessions: [{ ...window.__petPriorityDone, activityKey: "acknowledge-1" }]
			});
		`);
		await bubblesPage.waitForFunction(() => Boolean(document.querySelector(".pet-bubble--done")), { timeout: 3000 });
		await bubblesPage.click(".pet-bubble--done .pet-bubble__action--primary");
		await bubblesPage.waitForFunction(() => !document.querySelector(".pet-bubbles"), { timeout: 3000 });
		const acknowledgeCommands = await mainPage.evaluate(`//!world=main\nwindow.__petPhase2.commands`);
		check(
			"real acknowledge marks the session read through the main window",
			acknowledgeCommands.some(command => command.type === "mark-read" && command.sessionId === "phase2-session"),
			acknowledgeCommands,
		);

		await bubblesPage.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
		await mainPage.evaluate(`//!world=main
			window.electronAPI.petActivity({
				sessions: [{ ...window.__petPhase2Card, activityKey: "phase2-reduced-motion" }],
				bubble: { kind: "subtask", text: "减少动态效果完整消息" }
			});
		`);
		// This card was dismissed under its legacy activity key above. Use a new
		// revision so it participates in the stack alongside the subtask.
		await bubblesPage.waitForFunction(() => document.querySelectorAll(".pet-bubbles--stacked > .pet-bubble").length === 1, { timeout: 3000 });
		// Informational subtasks do not displace a higher-priority session card.
		// Expand the stack before checking this bubble's reduced-motion rendering.
		await bubblesPage.click(".pet-bubbles--stacked > .pet-bubble");
		await bubblesPage.waitForFunction(() => Boolean(document.querySelector(".pet-bubbles--expanded")), { timeout: 3000 });
		try {
			await bubblesPage.waitForFunction(
				() => document.querySelector(".pet-bubble--subtask .pet-bubble__text")?.textContent === "减少动态效果完整消息",
				{ timeout: 3000 },
			);
		} catch (error) {
			const state = await bubblesPage.evaluate(() => ({
				bodyText: document.body.innerText,
				root: document.querySelector("#root")?.innerHTML ?? "",
				reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
			}));
			await capture("pet-reduced-motion-failure", bubblesPage);
			throw new Error(`${String(error)}; reduced-motion state=${JSON.stringify(state)}; bubbleRendererErrors=${JSON.stringify(bubbleRendererErrors)}`);
		}
		const reducedText = await bubblesPage.evaluate(() => ({
			matches: matchMedia("(prefers-reduced-motion: reduce)").matches,
			text: document.querySelector(".pet-bubble--subtask .pet-bubble__text")?.textContent ?? "",
			animation: getComputedStyle(document.querySelector(".pet-bubble--subtask")).animationName,
		}));
		check(
			"real reduced motion shows complete bubble text without entrance animation",
			reducedText.matches && reducedText.text === "减少动态效果完整消息" && reducedText.animation === "none",
			reducedText,
		);
		if (await bubblesPage.evaluate(() => Boolean(document.querySelector(".pet-bubbles--expanded")))) {
			await petPage.click(".pet-window__badge");
			await bubblesPage.waitForFunction(() => Boolean(document.querySelector(".pet-bubbles--stacked")), { timeout: 3000 });
		}
		await bubblesPage.click(".pet-bubbles--stacked > .pet-bubble");
		await sleep(120);
		const reducedMorph = await bubblesPage.evaluate(() => ({
			expanded: Boolean(document.querySelector(".pet-bubbles--expanded")),
			morphing: Boolean(document.querySelector(".pet-bubbles--morphing")),
			transition: document.querySelector(".pet-bubbles")?.style.transition ?? "",
		}));
		check("real reduced motion expands without a residual size morph", reducedMorph.expanded && !reducedMorph.morphing && !reducedMorph.transition, reducedMorph);

		await mainPage.goto(pathToFileURL(path.join(desktopDir, "dist", "index.html")).href);
		await mainPage.waitForFunction(() => Boolean(document.querySelector('.gui-onboarding-backdrop, [role="dialog"][aria-modal="true"]')), { timeout: 30000 });
		await mainPage.bringToFront();
		await mainPage.evaluate(`//!world=main
			const lastStep = document.querySelectorAll(".gui-onboarding-dot").length - 1;
			if (lastStep < 0) throw new Error("Onboarding step indicators were not found");
			window.dispatchEvent(new CustomEvent("musepi-open-onboarding", { detail: { step: lastStep } }));
		`);
		try {
				await mainPage.waitForFunction(() => document.querySelectorAll(".gui-obo-branch-head").length >= 2, { timeout: 3000 });
			} catch (error) {
				const state = await mainPage.evaluate(() => ({
					url: location.href,
					bodyText: document.body.innerText.slice(0, 1200),
					overlay: document.querySelector(".gui-onboarding")?.outerHTML.slice(0, 1200) ?? "",
					branchCount: document.querySelectorAll(".gui-obo-branch-head").length,
				}));
				await capture("onboarding-open-failure", mainPage);
				throw new Error(`${String(error)}; onboarding state=${JSON.stringify(state)}`);
			}
		await mainPage.evaluate(() => document.querySelectorAll(".gui-obo-branch-head")[1]?.click());
		await mainPage.waitForFunction(() => Boolean(document.querySelector(".gui-obo-pet-grid")), { timeout: 3000 });
		await mainPage.evaluate(() => document.querySelector(".gui-obo-pet-grid [role=radio]")?.click());
		await mainPage.evaluate(() => document.querySelectorAll(".gui-obo-pers-section")[0]?.querySelectorAll(".gui-obo-seg")[1]?.click());
		await mainPage.waitForFunction(() => Boolean(document.querySelector(".gui-obo-pers-desktop")), { timeout: 3000 });
		const onboarding = await mainPage.evaluate(() => {
			const preview = document.querySelector(".gui-obo-pers-desktop");
			const bubble = preview?.querySelector(".gui-obo-pers-desktop-bubble");
			return {
				vectorOption: document.querySelector(".gui-obo-pet-grid [role=radio]")?.getAttribute("aria-checked") === "true",
				vectorPreview: Boolean(preview?.querySelector(".gui-obo-pers-desktop-pet .gui-pet svg")),
				bubble: Boolean(bubble),
				glass: bubble ? getComputedStyle(bubble).backgroundImage.includes("linear-gradient") : false,
			};
		});
		check("real onboarding desktop preview follows the selected vector pet and glass bubble", onboarding.vectorOption && onboarding.vectorPreview && onboarding.bubble && onboarding.glass, onboarding);
		const onboardingShot = path.join(outDir, "onboarding-personalize-desktop.png");
		await mainPage.screenshot({ path: onboardingShot });
		const onboardingShotOk = fs.existsSync(onboardingShot) && fs.statSync(onboardingShot).size > 0;
		check("real onboarding desktop preview screenshot", onboardingShotOk, onboardingShot);
		if (onboardingShotOk) result.screenshots.push(onboardingShot);
	} finally {
		await browser.disconnect();
	}
} catch (error) {
	check("Electron phase-2 smoke completed", false, String(error?.stack ?? error));
	process.exitCode = 1;
} finally {
	await stopElectron();
	fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
	console.log(`Electron smoke artifacts: ${outDir}`);
	if (result.checks.some(item => !item.ok)) process.exitCode = 1;
}
