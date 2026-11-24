import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { ensureChromiumExecutable } from "../../../packages/coding-agent/src/tools/browser/launch";

/**
 * Segmented-control press geometry (puppeteer, real cascade).
 *
 * The thumb carries its segment offset in `transform`. The first press
 * attempt rode the standalone `scale` property instead, and CSS composes
 * individual transforms BEFORE `transform`, scaling about the element's
 * UNtranslated centre: every segment after the first was pulled left by
 * (1 − scale) × index × width, so only segment 0 pressed straight down.
 *
 * That is a geometric fact — the painted centre — so it is asserted against
 * the real `:active` state held through CDP `CSS.forcePseudoState` rather
 * than by reading the stylesheet.
 */

const TOKENS = path.resolve(import.meta.dir, "../../../packages/client-core/src/styles/tokens.css");

const MARKUP = `<div class="gui-seg gui-seg--armed" role="radiogroup" style="--seg-count: 3; --seg-index: 0" id="seg">
	<span class="gui-seg-thumb" aria-hidden="true"></span>
	<button type="button" class="gui-seg-item" role="radio" aria-checked="true"><span class="gui-seg-item-label">One</span></button>
	<button type="button" class="gui-seg-item" role="radio" aria-checked="false"><span class="gui-seg-item-label">Two</span></button>
	<button type="button" class="gui-seg-item" role="radio" aria-checked="false"><span class="gui-seg-item-label">Three</span></button>
</div>`;

let browser: Browser;
let page: Page;

beforeAll(async () => {
	const executablePath = await ensureChromiumExecutable();
	if (!executablePath) throw new Error("No Chromium executable resolved");
	browser = await puppeteer.launch({ executablePath, headless: true });
	page = await browser.newPage();
	await page.setViewport({ width: 900, height: 400 });
	await page.setContent(`
		<style>
			:root {
				--color-surface-raised: rgb(40, 40, 40);
				--color-text: rgb(235, 235, 235);
				--color-text-muted: rgb(160, 160, 160);
				--color-text-faint: rgb(120, 120, 120);
				--color-accent-bd: rgb(80, 110, 160);
				--radius-lg: 8px;
				--spring-liquid: cubic-bezier(0.34, 1.56, 0.64, 1);
			}
			body { margin: 0; padding: 40px; background: #111; }
			#seg { width: 300px; }
			${fs.readFileSync(TOKENS, "utf8")}
		</style>
		${MARKUP}
	`);
});

afterAll(async () => {
	await browser?.close();
});

describe("the segmented thumb presses in place", () => {
	/** Read the painted box of the thumb for a given segment index. */
	const read = (index: number) =>
		page.evaluate(async (segIndex: number) => {
			const seg = document.querySelector<HTMLElement>("#seg");
			if (!seg) throw new Error("no segmented control");
			seg.style.setProperty("--seg-index", String(segIndex));
			await new Promise(requestAnimationFrame);
			const thumb = seg.querySelector<HTMLElement>(".gui-seg-thumb");
			if (!thumb) throw new Error("no thumb");
			const rect = thumb.getBoundingClientRect();
			return { centre: rect.left + rect.width / 2, width: rect.width };
		}, index);

	const settle = () =>
		page.evaluate(() =>
			Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))).then(() => {}),
		);

	test("every segment keeps its centre and shrinks on press", async () => {
		const client = await page.createCDPSession();
		await client.send("DOM.enable");
		await client.send("CSS.enable");
		const { root } = (await client.send("DOM.getDocument")) as { root: { nodeId: number } };
		const { nodeId } = (await client.send("DOM.querySelector", {
			nodeId: root.nodeId,
			selector: "#seg",
		})) as { nodeId: number };
		expect(nodeId).toBeGreaterThan(0);

		const setPressed = async (pressed: boolean): Promise<void> => {
			await client.send("CSS.forcePseudoState", {
				nodeId,
				forcedPseudoClasses: pressed ? ["active"] : [],
			});
			await settle();
		};

		try {
			for (const index of [0, 1, 2]) {
				await setPressed(false);
				// Moving the index runs the 340ms slide; read the settled box.
				await read(index);
				await settle();
				const rest = await read(index);

				await setPressed(true);
				// The transform is instant on press (`transition: none`), so the
				// next frame already holds the settled box.
				await page.evaluate(() => new Promise(requestAnimationFrame));
				const pressed = await read(index);

				// THE regression: with the standalone `scale` property the centre
				// moved left by (1 − 0.94) × index × segment width — 0 at index 0
				// (which is why only the first segment looked right) and ~6px at
				// index 1 on this 300px control.
				expect(Math.abs(pressed.centre - rest.centre), `segment ${index} centre`).toBeLessThanOrEqual(0.5);
				// The press must still be visible: the thumb shrinks.
				expect(pressed.width, `segment ${index} width`).toBeLessThan(rest.width);
			}
		} finally {
			await setPressed(false);
		}
	});
});
