import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { ensureChromiumExecutable } from "../../../packages/coding-agent/src/tools/browser/launch";

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
	// setContent replaces the DOM but leaves the pointer where the previous test
	// left it, which would hover the new card; every test starts unhovered.
	await page.mouse.move(0, 0);
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
	gap: number;
	buttons: Array<{ x: number; y: number; right: number; width: number }>;
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
			gap: Number.parseFloat(style.columnGap) || 0,
			buttons: Array.from(actions.querySelectorAll<HTMLElement>(".pet-bubble__action"), button => {
				const bounds = button.getBoundingClientRect();
				return { x: bounds.x, y: bounds.y, right: bounds.right, width: bounds.width };
			}),
			right: rect.right,
		};
	});
}

function expectFourVisibleButtons(actions: Awaited<ReturnType<typeof readActions>>): void {
	expect(actions.direction).toBe("row");
	expect(actions.opacity).toBe("1");
	expect(actions.pointerEvents).toBe("auto");
	// The row must fit its controls at their own widths plus the gaps between
	// them. The design owns button size and gap, so the minimum is derived from
	// the measured controls rather than pinned to one particular pair of values.
	const contentWidth =
		actions.buttons.reduce((total, button) => total + button.width, 0) + actions.gap * (actions.buttons.length - 1);
	expect(actions.width).toBeGreaterThanOrEqual(contentWidth - 0.5);
	expect(actions.scrollWidth).toBeLessThanOrEqual(actions.clientWidth);
	expect(new Set(actions.buttons.map(button => button.y)).size).toBe(1);
	for (const [index, button] of actions.buttons.entries()) {
		if (index > 0) expect(button.x).toBeGreaterThan(actions.buttons[index - 1]!.x);
		expect(button.right).toBeLessThanOrEqual(actions.right + 0.5);
	}
}

/** The reveal fades over 140ms; assertions read the settled row, not a frame
 *  of the transition (a freshly hovered card reports the starting opacity). */
async function waitForReveal(): Promise<void> {
	await page.waitForFunction(
		() =>
			(document.querySelector(".pet-bubble__actions")?.getAnimations() ?? []).every(
				animation => animation.playState !== "running",
			),
		{ timeout: 2000 },
	);
}

describe("pet bubble action layout", () => {
	it("reveals all four actions in one horizontal row on hover", async () => {
		await page.hover(".pet-bubble");
		await waitForReveal();
		expectFourVisibleButtons(await readActions());
	});

	it("reveals all four actions when keyboard focus enters the card", async () => {
		await page.focus(".pet-bubble__action");
		await waitForReveal();
		expectFourVisibleButtons(await readActions());
	});

	it("keeps the persistent unread actions wide enough for their contents", async () => {
		await page.evaluate(() => document.querySelector(".pet-bubble")!.classList.add("pet-bubble--unread"));
		await waitForReveal();
		expectFourVisibleButtons(await readActions());
	});

	it("keeps the collapsed row's controls inside the card", async () => {
		const actions = await readActions();
		const card = await page.evaluate(() => {
			const bounds = document.querySelector(".pet-bubble")!.getBoundingClientRect();
			return { left: bounds.left, right: bounds.right };
		});
		// Hidden, the row is a zero-width clip box; its controls still lay
		// themselves out and must not spill past the card or the window.
		expect(actions.width).toBe(0);
		expect(actions.opacity).toBe("0");
		expect(actions.buttons).toHaveLength(4);
		for (const button of actions.buttons) {
			expect(button.x).toBeGreaterThanOrEqual(card.left);
			expect(button.right).toBeLessThanOrEqual(card.right);
		}
	});

	it("reserves the revealed action row so hover cannot reflow the message", async () => {
		// A wrapping notification message is the case that used to grow the card:
		// the collapsed row's width decided the text column, so hovering squeezed
		// the copy into an extra line and the bottom-anchored window clipped it.
		const measure = () =>
			page.evaluate(() => {
				const card = document.querySelector<HTMLElement>(".pet-bubble")!;
				const text = document.querySelector<HTMLElement>(".pet-bubble__text")!;
				const actions = document.querySelector<HTMLElement>(".pet-bubble__actions")!;
				return {
					cardHeight: card.getBoundingClientRect().height,
					cardWidth: card.getBoundingClientRect().width,
					textWidth: text.getBoundingClientRect().width,
					textTop: text.getBoundingClientRect().top,
					actionsWidth: actions.getBoundingClientRect().width,
					buttonLeft: actions.querySelector<HTMLElement>(".pet-bubble__action")!.getBoundingClientRect().left,
					buttons: Array.from(actions.querySelectorAll<HTMLElement>(".pet-bubble__action"), button => ({
						width: button.getBoundingClientRect().width,
						x: button.getBoundingClientRect().x,
					})),
					gap: Number.parseFloat(getComputedStyle(actions).columnGap) || 0,
				};
			});
		await page.evaluate(() => {
			const card = document.querySelector<HTMLElement>(".pet-bubble")!;
			card.dataset.actions = "4";
			document.querySelector(".pet-bubble__text")!.textContent =
				"这是一段较长的事件气泡正文，用来确认悬停后文本列被压缩会不会多折行并改变卡片高度。";
			document.querySelector<HTMLElement>(".pet-bubble__actions")!.innerHTML = Array.from(
				{ length: 4 },
				(_, index) => `<button class="pet-bubble__action">${index + 1}</button>`,
			).join("");
		});
		const rest = await measure();
		await page.hover(".pet-bubble");
		await waitForReveal();
		const hover = await measure();
		expect(hover.cardHeight).toBeCloseTo(rest.cardHeight, 1);
		expect(hover.cardWidth).toBeCloseTo(rest.cardWidth, 1);
		expect(hover.textWidth).toBeCloseTo(rest.textWidth, 1);
		expect(hover.textTop).toBeCloseTo(rest.textTop, 1);
		// The reserved track must be exactly the revealed row (the design's own
		// button widths and gaps): a wider or narrower slot would still reflow.
		const rowWidth = hover.buttons.reduce((total, button) => total + button.width, 0);
		expect(hover.actionsWidth).toBeCloseTo(rowWidth + hover.gap * (hover.buttons.length - 1), 1);
		expect(hover.buttonLeft).toBeCloseTo(rest.buttonLeft, 1);
		expect(hover.buttons.map(button => button.x)).toEqual(rest.buttons.map(button => button.x));
	});
});

describe("pet bubble reply row", () => {
	it("grows the card with the reply row instead of overlaying it", async () => {
		const measured = await page.evaluate(() => {
			const card = document.querySelector<HTMLElement>(".pet-bubble")!;
			const before = card.getBoundingClientRect().height;
			const row = document.createElement("div");
			row.className = "pet-bubble__reply-wrap";
			const inner = document.createElement("div");
			inner.style.height = "40px";
			row.append(inner);
			card.append(row);
			const after = card.getBoundingClientRect().height;
			const style = getComputedStyle(row);
			return {
				before,
				after,
				gridColumn: `${style.gridColumnStart} / ${style.gridColumnEnd}`,
				position: style.position,
				rowWidth: row.getBoundingClientRect().width,
				cardWidth: card.getBoundingClientRect().width,
			};
		});
		// The row is a full-width, in-flow grid row: the card (and the native
		// window sized to it) follows the row's animated height.
		expect(measured.gridColumn).toBe("1 / -1");
		expect(measured.position).toBe("static");
		expect(measured.rowWidth).toBeGreaterThan(0);
		expect(measured.after - measured.before).toBeGreaterThanOrEqual(40);
	});

	it("does not animate the reply pill independently of the row", async () => {
		const animation = await page.evaluate(() => {
			const card = document.querySelector<HTMLElement>(".pet-bubble")!;
			const pill = document.createElement("div");
			pill.className = "pet-bubble__reply";
			pill.innerHTML = '<input class="pet-bubble__reply-input" /><button class="pet-bubble__reply-send"></button>';
			card.append(pill);
			const style = getComputedStyle(pill);
			return { animationName: style.animationName, display: style.display };
		});
		// The row's height is owned by the reveal wrapper; a second entrance
		// animation on the pill would play every time the row reopens.
		expect(animation.animationName).toBe("none");
		expect(animation.display).toBe("flex");
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
