import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { ensureChromiumExecutable } from "../../../packages/coding-agent/src/tools/browser/launch";

/**
 * Agent capsule geometry (puppeteer, real cascade).
 *
 * The capsule replaced the per-row orb; the facts below are geometric and
 * cannot be asserted in happy-dom:
 *  1. it is centered against the CHAT COLUMN (so the right panel, side panel
 *     and rail all move its center with the column, never the window), and it
 *     sits inside the 52px band the transcript reserves — no message row is
 *     covered at rest;
 *  2. it stays HORIZONTAL: the orb (enlarged to 24px), the assistant name, the
 *     role tag and the live state read left to right in one pill;
 *  3. it is pinned, not faded: scrolling the transcript moves the rows and
 *     leaves the pill's box and opacity untouched;
 *  4. at a narrow WINDOW the name folds first, keeping the orb, the role tag
 *     and the live state clear of the Chat|Canvas switch and the toggle.
 *
 * The tall stacked identity head is the right panel's Agent tab — its sticky
 * geometry lives in test/agent-info-head-geometry.test.ts.
 *
 * The row-width assertions guard the other half of the change: empty gutters
 * reclaim the desktop's 64px orb column + 12px gap at EVERY width (the shared
 * transcript only collapses it at ≥641px).
 */

const STYLES = path.resolve(import.meta.dir, "../src/styles");
const CASCADE = [
	"gui-base.css",
	"gui-tone.css",
	"gui-chrome.css",
	"gui-composer.css",
	"gui-settings.css",
	"gui-chat.css",
	"gui-workspace.css",
	"gui-creation.css",
	"gui-pet.css",
	"gui-board.css",
	"gui-widgets.css",
	"gui-misc.css",
	"gui-side-panel.css",
	"gui-glass.css",
]
	.map(file => fs.readFileSync(path.join(STYLES, file), "utf8"))
	.join("\n");
const TRANSCRIPT_CSS = fs.readFileSync(
	path.resolve(import.meta.dir, "../../../packages/client-core/src/components/transcript/transcript.css"),
	"utf8",
);

/** The handful of Tailwind utilities the chat column markup carries. */
const UTILITIES = `
	.flex { display: flex; }
	.flex-col { flex-direction: column; }
	.flex-1 { flex: 1 1 0%; }
	.min-h-0 { min-height: 0; }
	.min-w-0 { min-width: 0; }
	.h-full { height: 100%; }
	.overflow-y-auto { overflow-y: auto; }
	.px-5 { padding-left: 20px; padding-right: 20px; }
	.py-4 { padding-top: 16px; padding-bottom: 16px; }
	.relative { position: relative; }
`;

const ROW = (kind: string, gutter: string, label: string) => `
	<div class="tr-row tr-row--${kind}">
		<div class="tr-gutter">${gutter}</div>
		<div class="tr-body"><p>${label}</p></div>
	</div>`;

const FIXTURE = `
	<div class="gui-shell" id="shell" data-fixture="capsule">
		<div class="gui-main flex min-h-0 flex-1">
			<div class="gui-chat-column gui-float-card flex min-h-0 min-w-0 flex-1 flex-col" style="height: 620px; width: 760px; background: var(--color-surface)">
				<div class="gui-chat-head">
					<div class="gui-chat-head-left"><div class="gui-surface-mode"><button type="button">对话</button></div></div>
					<button type="button" class="gui-agent-capsule" aria-expanded="false" data-agent-status="idle" data-agent-role="coder">
						<span class="gui-agent-avatar" role="img" aria-label="agent listening">
							<svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor"/></svg>
						</span>
						<span class="gui-agent-capsule-name">助手</span>
						<span class="gui-agent-role-tag">编码</span>
						<span class="gui-agent-capsule-sep" aria-hidden="true"></span>
						<span class="gui-agent-capsule-status">空闲</span>
						<span class="gui-agent-capsule-go" aria-hidden="true">
							<svg width="12" height="12" viewBox="0 0 12 12"><path d="M4 2l4 4-4 4" fill="none" stroke="currentColor"/></svg>
						</span>
					</button>
					<button class="gui-chat-info-toggle" type="button">i</button>
				</div>
				<div class="gui-chat-body relative flex min-h-0 min-w-0 flex-1 flex-col">
					<div class="gui-transcript-wrap relative min-h-0 min-w-0 flex-1">
						<div class="gui-transcript min-h-0 min-w-0 h-full overflow-y-auto px-5 py-4">
							<div class="tr-root">
								${ROW("user", "", "用户消息")}
								${ROW("assistant", "", "助手回复正文，占据整行可用宽度。")}
								${ROW("assistant", "垂", "带角标的行保留头像列")}
								${Array.from({ length: 24 }, (_, i) => ROW("assistant", "", `第 ${i + 3} 行正文`)).join("")}
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>
	<!-- The settings effects preview: the same pill, centred by LAYOUT (no
	     absolute head, no left: 50%), which is exactly the surface whose press
	     used to jump. -->
	<div class="gui-effect-preview" id="preview" style="width: 420px; margin-top: 24px">
		<div class="gui-effect-preview-identity">
			<button type="button" class="gui-agent-capsule" aria-expanded="false" data-agent-status="idle" data-agent-role="coder">
				<span class="gui-agent-avatar" role="img" aria-label="agent listening">
					<svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor"/></svg>
				</span>
				<span class="gui-agent-capsule-name">助手</span>
				<span class="gui-agent-role-tag">编码</span>
				<span class="gui-agent-capsule-sep" aria-hidden="true"></span>
				<span class="gui-agent-capsule-status">空闲</span>
			</button>
		</div>
	</div>`;

let browser: Browser;
let page: Page;

beforeAll(async () => {
	const executablePath = await ensureChromiumExecutable();
	if (!executablePath) throw new Error("No Chromium executable resolved");
	browser = await puppeteer.launch({ executablePath, headless: true });
	page = await browser.newPage();
	await page.setViewport({ width: 1100, height: 800 });
	await page.setContent(`
		<style>
			:root {
				--bg-overlay: rgb(24, 24, 24);
				--color-surface: rgb(32, 32, 32);
				--color-surface-sunken: rgb(28, 28, 28);
				--color-surface-raised: rgb(40, 40, 40);
				--color-text: rgb(235, 235, 235);
				--color-text-muted: rgb(160, 160, 160);
				--color-text-faint: rgb(120, 120, 120);
				--color-accent: rgb(90, 150, 240);
				--color-accent-soft: rgb(60, 90, 140);
				--color-accent-bd: rgb(80, 110, 160);
				--border: rgb(70, 70, 70);
				--fg: rgb(235, 235, 235);
				--fg-muted: rgb(170, 170, 170);
				--fg-faint: rgb(120, 120, 120);
				--accent: rgb(90, 150, 240);
				--radius-md: 8px;
				--radius-lg: 12px;
				--radius-2xl: 20px;
				--glass-hairline: rgb(255 255 255 / 10%);
				--glass-rim-hi: rgb(255 255 255 / 8%);
				--shadow-overlay: 0 12px 32px rgb(0 0 0 / 30%);
				--ui-font-size-xs: 11px;
				--ui-font-size-sm: 13px;
				--gui-glass-blur: 12px;
				--gui-glass-saturate: 140%;
			}
			${UTILITIES}
			${TRANSCRIPT_CSS}
			${CASCADE}
		</style>
		${FIXTURE}`);
	await page.evaluate(() =>
		Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))),
	);
});

afterAll(async () => {
	await browser.close();
}, 60_000);

interface Box {
	top: number;
	left: number;
	width: number;
	height: number;
	bottom: number;
	right: number;
}

async function readBoxes() {
	return page.evaluate(() => {
		const box = (element: Element): Box => {
			const rect = element.getBoundingClientRect();
			return {
				top: Math.round(rect.top),
				left: Math.round(rect.left),
				width: Math.round(rect.width),
				height: Math.round(rect.height),
				bottom: Math.round(rect.bottom),
				right: Math.round(rect.right),
			};
		};
		const select = (selector: string) => document.querySelector<HTMLElement>(selector)!;
		const column = select(".gui-chat-column");
		const capsule = select(".gui-agent-capsule");
		const rows = [...document.querySelectorAll<HTMLElement>(".gui-transcript .tr-row")];
		const assistantBodies = rows
			.filter(row => row.classList.contains("tr-row--assistant"))
			.map(row => ({
				gutterEmpty: (row.querySelector(".tr-gutter")?.textContent ?? "").trim() === "",
				row: box(row),
				body: box(row.querySelector(".tr-body")!),
			}));
		return {
			column: box(column),
			capsule: box(capsule),
			capsuleOpacity: getComputedStyle(capsule).opacity,
			capsuleName: box(select(".gui-agent-capsule-name")),
			capsuleNameDisplay: getComputedStyle(select(".gui-agent-capsule-name")).display,
			roleTag: box(select(".gui-agent-capsule .gui-agent-role-tag")),
			roleTagDisplay: getComputedStyle(select(".gui-agent-capsule .gui-agent-role-tag")).display,
			capsuleSep: box(select(".gui-agent-capsule-sep")),
			capsuleSepDisplay: getComputedStyle(select(".gui-agent-capsule-sep")).display,
			capsuleStatus: box(select(".gui-agent-capsule-status")),
			avatar: box(select(".gui-agent-capsule .gui-agent-avatar")),
			headMode: box(select(".gui-surface-mode")),
			infoToggle: box(select(".gui-chat-info-toggle")),
			firstRow: box(rows[0]!),
			assistantBodies,
		};
	});
}

/** Resize the chat COLUMN the way the side panel and right rail do. */
async function setColumnWidth(width: number): Promise<void> {
	await page.evaluate(w => {
		const column = document.querySelector<HTMLElement>(".gui-chat-column")!;
		column.style.flex = `0 0 ${w}px`;
		column.style.width = `${w}px`;
	}, width);
	await page.evaluate(() =>
		Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))),
	);
}

describe("agent capsule geometry", () => {
	test("centered against the chat column, inside the reserved top band", async () => {
		const before = await readBoxes();
		const capsuleCenter = before.capsule.left + before.capsule.width / 2;
		const columnCenter = before.column.left + before.column.width / 2;
		// ±1px: the capsule is a fixed-width pill and both edges round.
		expect(Math.abs(capsuleCenter - columnCenter)).toBeLessThanOrEqual(1);
		// The scroller reserves 52px for the head row; the pill must end inside it
		// so the first message row is never covered at rest.
		const band = before.firstRow.top - before.column.top;
		expect(before.capsule.bottom - before.column.top).toBeLessThanOrEqual(band);
		// Still the one-line chrome strip (30px with the enlarged orb), never the
		// Agent tab's tall identity head.
		expect(before.capsule.height).toBe(30);
	});

	test("stays horizontal: enlarged orb, name, role tag, state, arrow in one line", async () => {
		const boxes = await readBoxes();
		// The orb grew from 20 to 24 but stays a single-row leading glyph.
		expect(boxes.avatar.width).toBe(24);
		expect(boxes.avatar.height).toBe(24);
		// The orb is vertically centered in the pill.
		const pillCenter = boxes.capsule.top + boxes.capsule.height / 2;
		expect(Math.abs(boxes.avatar.top + boxes.avatar.height / 2 - pillCenter)).toBeLessThanOrEqual(1);
		// Reading order: orb → name → role tag → separator → state.
		expect(boxes.avatar.right).toBeLessThanOrEqual(boxes.capsuleName.left);
		expect(boxes.capsuleName.right).toBeLessThanOrEqual(boxes.roleTag.left);
		expect(boxes.roleTag.right).toBeLessThanOrEqual(boxes.capsuleSep.left);
		expect(boxes.capsuleSep.right).toBeLessThanOrEqual(boxes.capsuleStatus.left);
		// Every part stays inside the pill.
		for (const part of [boxes.avatar, boxes.capsuleName, boxes.roleTag, boxes.capsuleStatus]) {
			expect(part.top).toBeGreaterThanOrEqual(boxes.capsule.top);
			expect(part.bottom).toBeLessThanOrEqual(boxes.capsule.bottom);
		}
	});

	test("pinned, not faded: scrolling moves rows and leaves the capsule alone", async () => {
		const before = await readBoxes();
		await page.evaluate(() => {
			document.querySelector<HTMLElement>(".gui-transcript")!.scrollTop = 420;
		});
		const after = await readBoxes();
		expect(after.capsule).toEqual(before.capsule);
		expect(after.capsuleOpacity).toBe("1");
		// The messages really moved under it.
		expect(after.firstRow.top).toBeLessThan(before.firstRow.top - 100);
	});

	test("is the head row's only pointer target", async () => {
		const events = await page.evaluate(() => {
			const head = document.querySelector<HTMLElement>(".gui-chat-head")!;
			const capsule = document.querySelector<HTMLElement>(".gui-agent-capsule")!;
			return {
				headEvents: getComputedStyle(head).pointerEvents,
				capsuleEvents: getComputedStyle(capsule).pointerEvents,
				capsuleTag: capsule.tagName,
			};
		});
		expect(events.headEvents).toBe("none");
		expect(events.capsuleEvents).toBe("auto");
		expect(events.capsuleTag).toBe("BUTTON");
	});

	test("activates from the keyboard as a button", async () => {
		await page.evaluate(() => {
			const capsule = document.querySelector<HTMLElement>(".gui-agent-capsule")!;
			capsule.dataset.pressed = "0";
			capsule.addEventListener("click", () => {
				capsule.dataset.pressed = "1";
			});
			capsule.focus();
		});
		await page.keyboard.press("Enter");
		expect(
			await page.evaluate(() => document.querySelector<HTMLElement>(".gui-agent-capsule")!.dataset.pressed),
		).toBe("1");
	});

	test("hover, keyboard focus and the expanded state reveal the trailing arrow", async () => {
		const read = () =>
			page.evaluate(() => {
				const arrow = document.querySelector<HTMLElement>(".gui-agent-capsule-go")!;
				const capsule = document.querySelector<HTMLElement>(".gui-agent-capsule")!;
				const style = getComputedStyle(arrow);
				return {
					opacity: style.opacity,
					transform: style.transform,
					expanded: capsule.getAttribute("aria-expanded"),
				};
			});
		// Resting: muted, pulled back.
		const resting = await read();
		expect(Number(resting.opacity)).toBeLessThan(0.5);

		/** The arrow fades in 160ms; read after the transition, not on its frame. */
		const settle = () =>
			page.evaluate(() =>
				Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))).then(() => {}),
			);

		await page.hover(".gui-agent-capsule");
		await settle();
		const hovered = await read();
		expect(hovered.opacity).toBe("1");

		await page.mouse.move(0, 0);
		await page.focus(".gui-agent-capsule");
		await settle();
		const focused = await read();
		expect(focused.opacity).toBe("1");
		// The glyph rotates to point back towards the chat once its tab is open.
		await page.evaluate(() => document.querySelector(".gui-agent-capsule")!.setAttribute("aria-expanded", "true"));
		await settle();
		const expanded = await read();
		expect(expanded.expanded).toBe("true");
		expect(expanded.opacity).toBe("1");
		expect(expanded.transform.startsWith("matrix(-1")).toBe(true);
		await page.evaluate(() => document.querySelector(".gui-agent-capsule")!.setAttribute("aria-expanded", "false"));
		await page.evaluate(() => document.querySelector<HTMLElement>(".gui-agent-capsule")!.blur());
	});

	// @guard: revert apps/desktop/src/styles/gui-chat.css:7060 | --gui-capsule-press: scale(1);
	// @guard: test presses in place: the centre holds and the scale applies
	test("presses in place: the centre holds and the scale applies, in the chat and in the preview", async () => {
		/** Read each pill's box and its composed transform. `centre` is the
		 *  painted centre, so it moves whenever the transform translates. */
		const read = () =>
			page.evaluate(() => {
				const measure = (selector: string) => {
					const capsule = document.querySelector<HTMLElement>(selector)!;
					const style = getComputedStyle(capsule);
					const box = capsule.getBoundingClientRect();
					return {
						centre: box.left + box.width / 2,
						width: box.width,
						shift: style.getPropertyValue("--gui-capsule-shift").trim(),
						press: style.getPropertyValue("--gui-capsule-press").trim(),
						transform: style.transform,
					};
				};
				return {
					chat: measure("#shell .gui-agent-capsule"),
					preview: measure("#preview .gui-agent-capsule"),
				};
			});

		/** The press is a 120ms transform transition; read the settled value,
		 *  never an intermediate frame. */
		const settle = () =>
			page.evaluate(() =>
				Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))).then(() => {}),
			);

		/** Hold the REAL `:active` state on both pills through CDP's
		 *  `CSS.forcePseudoState`, so the assertion is about the shipped
		 *  `.gui-agent-capsule:active` rule — an injected `--gui-capsule-press`
		 *  would only prove the variable works, and stayed green with the bug
		 *  restored. */
		const client = await page.createCDPSession();
		await client.send("DOM.enable");
		await client.send("CSS.enable");
		const { root } = (await client.send("DOM.getDocument")) as { root: { nodeId: number } };
		const nodeIds: Record<"chat" | "preview", number> = { chat: 0, preview: 0 };
		for (const [surface, selector] of [
			["chat", "#shell .gui-agent-capsule"],
			["preview", "#preview .gui-agent-capsule"],
		] as const) {
			const { nodeId } = (await client.send("DOM.querySelector", {
				nodeId: root.nodeId,
				selector,
			})) as { nodeId: number };
			expect(nodeId).toBeGreaterThan(0);
			nodeIds[surface] = nodeId;
		}
		const setPressed = async (pressed: boolean): Promise<void> => {
			for (const nodeId of Object.values(nodeIds)) {
				await client.send("CSS.forcePseudoState", {
					nodeId,
					forcedPseudoClasses: pressed ? ["active"] : [],
				});
			}
			await settle();
		};

		try {
			const rest = await read();
			// Rest: the chat pill is centred by its own shift, the preview by layout.
			expect(rest.chat.shift).toBe("translateX(-50%)");
			expect(rest.preview.shift).toBe("translateX(0)");
			expect(rest.chat.press).toBe("scale(1)");
			expect(rest.preview.press).toBe("scale(1)");

			await setPressed(true);
			const pressed = await read();

			// THE regression: the centre must not move when the pill is pressed.
			// With the old `:active { transform: translateX(-50%) scale(0.97) }`
			// the preview moved half its width left (−25px at this width).
			expect(Math.abs(pressed.chat.centre - rest.chat.centre)).toBeLessThanOrEqual(0.5);
			expect(Math.abs(pressed.preview.centre - rest.preview.centre)).toBeLessThanOrEqual(0.5);
			// The press is still a press in BOTH surfaces: the pill shrank and
			// the shipped `:active` rule is what applied it.
			for (const [surface, box] of [
				[rest.chat, pressed.chat],
				[rest.preview, pressed.preview],
			] as const) {
				expect(box.press).toBe("scale(0.97)");
				expect(box.width).toBeLessThan(surface.width);
				expect(box.transform).toContain("0.97");
			}
			// The preview's transform carries no horizontal translation at all.
			expect(pressed.preview.transform.startsWith("matrix(0.97")).toBe(true);
			expect(pressed.chat.transform.startsWith("matrix(0.97")).toBe(true);
		} finally {
			await setPressed(false);
			await client.detach();
		}
	});

	test("keeps a visible focus ring outside the pill, unclipped", async () => {
		const ring = await page.evaluate(() => {
			const capsule = document.querySelector<HTMLElement>(".gui-agent-capsule")!;
			const column = document.querySelector<HTMLElement>(".gui-chat-column")!;
			const head = document.querySelector<HTMLElement>(".gui-chat-head")!;
			capsule.focus();
			const style = getComputedStyle(capsule);
			const box = capsule.getBoundingClientRect();
			const card = column.getBoundingClientRect();
			// The chat card clips its overflow, so the ring's extent (outline
			// width + offset) must stay inside the card box.
			const extent = Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset);
			return {
				width: style.outlineWidth,
				style: style.outlineStyle,
				offset: style.outlineOffset,
				focused: document.activeElement === capsule,
				headOverflow: getComputedStyle(head).overflow,
				slack: {
					top: box.top - card.top,
					left: box.left - card.left,
					right: card.right - box.right,
					bottom: card.bottom - box.bottom,
				},
				extent,
			};
		});
		expect(ring.focused).toBe(true);
		expect(ring.style).toBe("solid");
		expect(ring.width).toBe("2px");
		expect(ring.offset).toBe("2px");
		// The head row itself never clips; the card's clip only trims what does
		// not fit, and the ring keeps its full extent inside it.
		expect(ring.headOverflow).toBe("visible");
		for (const edge of Object.values(ring.slack)) expect(edge).toBeGreaterThanOrEqual(ring.extent);
		await page.evaluate(() => document.querySelector<HTMLElement>(".gui-agent-capsule")!.blur());
	});

	test("drops the arrow transition under reduced motion", async () => {
		await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
		const durations = await page.evaluate(() => {
			const capsule = document.querySelector<HTMLElement>(".gui-agent-capsule")!;
			const arrow = document.querySelector<HTMLElement>(".gui-agent-capsule-go")!;
			return [getComputedStyle(capsule).transitionDuration, getComputedStyle(arrow).transitionDuration];
		});
		// Chromium normalizes a zero duration to `1e-05s`; compare the time.
		for (const duration of durations) {
			for (const part of duration.split(",")) expect(Number.parseFloat(part)).toBeLessThan(0.001);
		}
		await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
	});

	test("folds the name before the role on a narrow window, never colliding with the head", async () => {
		await page.setViewport({ width: 700, height: 800 });
		// The pinning test above left the transcript scrolled; the band is only
		// measurable from the resting position.
		await page.evaluate(() => {
			document.querySelector<HTMLElement>(".gui-transcript")!.scrollTop = 0;
		});
		const narrow = await readBoxes();
		// The name and its separator fold; the role tag — what the capsule exists
		// to show — and the live state stay.
		expect(narrow.capsuleNameDisplay).toBe("none");
		expect(narrow.capsuleSepDisplay).toBe("none");
		expect(narrow.roleTagDisplay).not.toBe("none");
		expect(narrow.roleTag.width).toBeGreaterThan(0);
		// Still centered, still inside the band, clear of the head's own controls.
		const center = narrow.capsule.left + narrow.capsule.width / 2;
		const columnCenter = narrow.column.left + narrow.column.width / 2;
		expect(Math.abs(center - columnCenter)).toBeLessThanOrEqual(1);
		expect(narrow.capsule.left).toBeGreaterThanOrEqual(narrow.headMode.right);
		expect(narrow.capsule.right).toBeLessThanOrEqual(narrow.infoToggle.left);
		expect(narrow.capsule.bottom - narrow.column.top).toBeLessThanOrEqual(narrow.firstRow.top - narrow.column.top);
		await page.setViewport({ width: 1100, height: 800 });
	});

	test("stays on one line when the column is widened or narrowed", async () => {
		await setColumnWidth(620);
		const narrowColumn = await readBoxes();
		expect(narrowColumn.capsule.height).toBe(30);
		expect(
			Math.abs(
				narrowColumn.capsule.left +
					narrowColumn.capsule.width / 2 -
					(narrowColumn.column.left + narrowColumn.column.width / 2),
			),
		).toBeLessThanOrEqual(1);
		await setColumnWidth(900);
		const wideColumn = await readBoxes();
		expect(wideColumn.capsule.height).toBe(30);
		await setColumnWidth(760);
	});

	test("an empty gutter gives the body the full row width", async () => {
		const boxes = await readBoxes();
		const collapsed = boxes.assistantBodies.find(row => row.gutterEmpty);
		const reserved = boxes.assistantBodies.find(row => !row.gutterEmpty);
		expect(collapsed).toBeDefined();
		expect(reserved).toBeDefined();
		if (!collapsed || !reserved) return;
		// No 64px orb column, no 12px gap: the body starts at the row edge.
		expect(collapsed.body.left).toBe(collapsed.row.left);
		expect(Math.abs(collapsed.body.right - collapsed.row.right)).toBeLessThanOrEqual(1);
		// A row that still carries a gutter keeps the column, so the reclaimed
		// width is the 64px + 12px the avatar used to take.
		expect(collapsed.body.width - reserved.body.width).toBeGreaterThanOrEqual(70);
	});
});
