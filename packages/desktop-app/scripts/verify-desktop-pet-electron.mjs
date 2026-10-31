import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

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
			await mainPage.waitForFunction(() => Boolean(document.querySelector(".gui-onboarding-backdrop")), { timeout: 30000 });
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
			return rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
		});
		if (!geometry) throw new Error("Pet hit area was not found");
		await petPage.mouse.move(geometry.x, geometry.y);
		await petPage.mouse.down();
		for (const offset of [12, 28, 44]) {
			await petPage.mouse.move(geometry.x + offset, geometry.y - offset / 4);
			await sleep(40);
		}
		const dragged = await gestureState(petPage);
		const dragEvents = await petPage.evaluate(() => window.__petPhase2Events);
		check(
			"real Electron orb drag uses continuous gestures without Petdex direction",
			dragged.gesture.length > 0 && !dragged.mirrored && !dragged.petdexDrag && !dragged.doubleSquash && dragged.mood && dragged.state,
			{ ...dragged, events: dragEvents },
		);
		await capture("pet-orb-drag-electron", petPage);
		for (const offset of [24, 0, -28]) {
			await petPage.mouse.move(geometry.x + offset, geometry.y - offset / 4);
			await sleep(40);
		}
		const reversed = await gestureState(petPage);
		check("real Electron orb reversal remains continuous and unmirrored", reversed.gesture.length > 0 && !reversed.mirrored && !reversed.petdexDrag, reversed);
		await petPage.mouse.up();
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
		for (let attempt = 0; attempt < 75; attempt++) {
			const pages = await browser.pages();
			bubblesPage = pages.find(page => page.url().includes("/bubbles.html"));
			if (bubblesPage && await bubblesPage.evaluate(() => Boolean(document.querySelector(".pet-bubble--session")))) break;
			bubblesPage = undefined;
			await sleep(200);
		}
		await mainPage.evaluate(`//!world=main\nclearInterval(window.__petPhase2Timer)`);
		if (!bubblesPage) throw new Error("Real bubbles window did not render its session card");
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
		await bubblesPage.click(".pet-bubbles--stacked > .pet-bubble .pet-bubble__body");
		await sleep(700);
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
			const fab = rect(document.querySelector(".pet-bubbles__fab"));
			const stack = rect(document.querySelector(".pet-bubbles"));
			const actions = Array.from(document.querySelectorAll(".pet-bubble button"))
				.filter(element => element.getClientRects().length > 0)
				.map(element => ({ className: element.className, ...rect(element) }));
			return {
				viewport: { width: innerWidth, height: innerHeight },
				scrollWidth: document.documentElement.scrollWidth,
				fab,
				stack,
				actions,
				ok: inside(fab) && inside(stack) && actions.every(inside) && document.documentElement.scrollWidth <= innerWidth,
			};
		});
		check("real expanded bubble controls stay inside the window", expandedGeometry.ok, expandedGeometry);

		await bubblesPage.click(".pet-bubble--session .pet-bubble__action--open + .pet-bubble__action");
		await sleep(200);
		const reply = await bubblesPage.evaluate(() => ({
			input: Boolean(document.querySelector(".pet-bubble__reply-input")),
			expanded: Boolean(document.querySelector(".pet-bubbles--expanded")),
		}));
		const opensAfterReply = await mainPage.evaluate(`//!world=main\nwindow.__petPhase2.opens`);
		check("real reply action neither collapses nor opens the card", reply.input && reply.expanded && opensAfterReply.length === 0, { ...reply, opensAfterReply });
		const materials = await bubblesPage.evaluate(() =>
			[".pet-bubbles__head", ".pet-bubbles__fab", ".pet-bubble__reply"].map(selector => {
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
			"real expanded header, fab and reply share glass and stay visible",
			materials.every(item => item.backgroundImage.includes("linear-gradient") && item.borderColor !== "rgba(0, 0, 0, 0)" && item.inside),
			materials,
		);
		await bubblesPage.keyboard.press("Escape");
		await bubblesPage.click(".pet-bubble--session .pet-bubble__action--open");
		await sleep(250);
		const opened = await mainPage.evaluate(`//!world=main\nwindow.__petPhase2.opens`);
		check("real open action invokes only the explicit session entry", opened.length === 1 && opened[0] === "phase2-session" && await bubblesPage.evaluate(() => Boolean(document.querySelector(".pet-bubbles--expanded"))), opened);

		await bubblesPage.click(".pet-bubble--session .pet-bubble__body");
		await sleep(500);
		const collapsed = await bubblesPage.evaluate(() => Boolean(document.querySelector(".pet-bubbles--stacked")));
		const opensAfterCollapse = await mainPage.evaluate(`//!world=main\nwindow.__petPhase2.opens`);
		check("real expanded body collapses without opening again", collapsed && opensAfterCollapse.length === 1, { collapsed, opensAfterCollapse });

		await bubblesPage.click(".pet-bubbles--stacked > .pet-bubble .pet-bubble__body");
		await sleep(600);
		await bubblesPage.click(".pet-bubble--question .pet-bubble__action--primary");
		await sleep(250);
		const approval = await bubblesPage.evaluate(() => ({
			question: Boolean(document.querySelector(".pet-bubble--question")),
			expanded: Boolean(document.querySelector(".pet-bubbles--expanded")),
		}));
		const commands = await mainPage.evaluate(`//!world=main\nwindow.__petPhase2.commands`);
		check("real approval confirms without activating the card body", !approval.question && approval.expanded && commands.some(command => command.type === "approve" && command.requestId === "phase2-approval" && command.approved === true), { ...approval, commands });

		await bubblesPage.click(".pet-bubble--session .pet-bubble__dismiss");
		await sleep(250);
		const dismissed = await bubblesPage.evaluate(() => document.querySelectorAll(".pet-bubble").length);
		check("real dismiss closes only its own card", dismissed === 1, dismissed);
		await bubblesPage.click(".pet-bubble--session .pet-bubble__dismiss");
		await bubblesPage.waitForFunction(() => document.querySelectorAll(".pet-bubble").length === 0, { timeout: 3000 });
		check("real working card dismiss clears the remaining card", true);

		await bubblesPage.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
		await mainPage.evaluate(`//!world=main
			window.electronAPI.petActivity({
				sessions: [window.__petPhase2Card],
				bubble: { kind: "subtask", text: "减少动态效果完整消息" }
			});
		`);
		await bubblesPage.waitForFunction(
			() => document.querySelector(".pet-bubble--subtask .pet-bubble__text")?.textContent === "减少动态效果完整消息",
			{ timeout: 3000 },
		);
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
			await bubblesPage.click(".pet-bubbles__fab");
			await bubblesPage.waitForFunction(() => Boolean(document.querySelector(".pet-bubbles--stacked")), { timeout: 3000 });
		}
		await bubblesPage.click(".pet-bubbles--stacked > .pet-bubble .pet-bubble__body");
		await sleep(120);
		const reducedMorph = await bubblesPage.evaluate(() => ({
			expanded: Boolean(document.querySelector(".pet-bubbles--expanded")),
			morphing: Boolean(document.querySelector(".pet-bubbles--morphing")),
			transition: document.querySelector(".pet-bubbles")?.style.transition ?? "",
		}));
		check("real reduced motion expands without a residual size morph", reducedMorph.expanded && !reducedMorph.morphing && !reducedMorph.transition, reducedMorph);

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
