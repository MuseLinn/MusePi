import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { ensureChromiumExecutable } from "../../coding-agent/src/tools/browser/launch";

const CSS = fs.readFileSync(path.resolve(import.meta.dir, "../src/styles/pet-window.css"), "utf8");
const executablePath = await ensureChromiumExecutable();
if (!executablePath) throw new Error("No Chromium executable resolved");
const browser: Browser = await puppeteer.launch({ executablePath, headless: true });
const page: Page = await browser.newPage();

beforeEach(async () => {
	await page.setContent(`
		<style>
			:root {
				--color-accent: rgb(20, 120, 220);
				--color-danger: rgb(200, 20, 20);
				--glass-border: rgba(255, 255, 255, 0.2);
			}
			${CSS}
		</style>
		<div class="pet-bubbles">
			<div class="pet-bubble">
				<span class="pet-bubble__kind">Completed</span>
				<div class="pet-bubble__text">Finished</div>
				<div class="pet-bubble__body">Session</div>
				<div class="pet-bubble__actions">
					${Array.from({ length: 4 }, (_, index) => `<button class="pet-bubble__action">${index + 1}</button>`).join("")}
				</div>
			</div>
		</div>`);
});

afterAll(async () => {
	await browser.close();
}, 60_000);

async function readActions(): Promise<{
	direction: string;
	opacity: string;
	pointerEvents: string;
	width: number;
	clientWidth: number;
	scrollWidth: number;
	buttons: Array<{ x: number; y: number; right: number }>;
	right: number;
}> {
	return page.evaluate(() => {
		const actions = document.querySelector<HTMLElement>(".pet-bubble__actions")!;
		const style = getComputedStyle(actions);
		const rect = actions.getBoundingClientRect();
		return {
			direction: style.flexDirection,
			opacity: style.opacity,
			pointerEvents: style.pointerEvents,
			width: rect.width,
			clientWidth: actions.clientWidth,
			scrollWidth: actions.scrollWidth,
			buttons: Array.from(actions.querySelectorAll<HTMLElement>(".pet-bubble__action"), button => {
				const bounds = button.getBoundingClientRect();
				return { x: bounds.x, y: bounds.y, right: bounds.right };
			}),
			right: rect.right,
		};
	});
}

function expectFourVisibleButtons(actions: Awaited<ReturnType<typeof readActions>>): void {
	expect(actions.direction).toBe("row");
	expect(actions.opacity).toBe("1");
	expect(actions.pointerEvents).toBe("auto");
	expect(actions.width).toBeGreaterThanOrEqual(108);
	expect(actions.scrollWidth).toBeLessThanOrEqual(actions.clientWidth);
	expect(new Set(actions.buttons.map(button => button.y)).size).toBe(1);
	for (const [index, button] of actions.buttons.entries()) {
		if (index > 0) expect(button.x).toBeGreaterThan(actions.buttons[index - 1]!.x);
		expect(button.right).toBeLessThanOrEqual(actions.right + 0.5);
	}
}

describe("pet bubble action layout", () => {
	it("reveals all four actions in one horizontal row on hover", async () => {
		await page.hover(".pet-bubble");
		expectFourVisibleButtons(await readActions());
	});

	it("reveals all four actions when keyboard focus enters the card", async () => {
		await page.focus(".pet-bubble__action");
		expectFourVisibleButtons(await readActions());
	});

	it("keeps the persistent unread actions wide enough for their contents", async () => {
		await page.evaluate(() => document.querySelector(".pet-bubble")!.classList.add("pet-bubble--unread"));
		expectFourVisibleButtons(await readActions());
	});
});

describe("pet bubble kind styling", () => {
	it("does not paint a left accent stripe or reserve padding for one", async () => {
		const styles = await page.evaluate(() => {
			const card = document.querySelector(".pet-bubble")!;
			const paddingLeft = (selector: string) => getComputedStyle(document.querySelector(selector)!).paddingLeft;
			return {
				pseudoContent: getComputedStyle(card, "::before").content,
				kind: paddingLeft(".pet-bubble__kind"),
				text: paddingLeft(".pet-bubble__text"),
				body: paddingLeft(".pet-bubble__body"),
			};
		});
		expect(styles).toEqual({ pseudoContent: "none", kind: "0px", text: "0px", body: "0px" });
	});

	it("retains distinct error and question borders without the stripe", async () => {
		const colors = await page.evaluate(() => {
			const card = document.querySelector(".pet-bubble")!;
			const borderColor = () => getComputedStyle(card).borderTopColor;
			const ordinary = borderColor();
			card.classList.add("pet-bubble--error");
			const error = borderColor();
			card.classList.replace("pet-bubble--error", "pet-bubble--question");
			const question = borderColor();
			return { ordinary, error, question };
		});
		expect(colors.error).not.toBe(colors.ordinary);
		expect(colors.question).not.toBe(colors.ordinary);
	});
});
