import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { renderToStaticMarkup } from "react-dom/server";
import { ensureChromiumExecutable } from "../../../packages/coding-agent/src/tools/browser/launch";
import { ConnectionLocationRow } from "../src/components/ConnectionLocationRow";

/**
 * The two-axis dialog, measured in real Chromium.
 *
 * Three facts cannot be asserted in happy-dom, because each one is geometry
 * produced by the real cascade:
 *
 *  1. **Hierarchy holds at both widths.** At 1280 the two sections sit side by
 *     side and both are readable; at the narrowest supported window (720 —
 *     `apps/desktop/electron/main.cjs` minWidth) they stack. A wide dialog
 *     with two sections is exactly where hierarchy collapses silently, so both
 *     widths are measured rather than assumed.
 *  2. **No nested scrollbar.** The dialog body is the only scroller. Its
 *     `scrollWidth === clientWidth` and the list inside it neither scrolls nor
 *     overflows; a list that grew a horizontal bar under complete content is
 *     the failure M80's contract exists to stop.
 *  3. **The row anatomy is the same in both lists.** The status slot sits at
 *     the same edge in both, and the row box — not a control inside it — is the
 *     full-width target (M86's honest hit area).
 *
 * What this cannot prove: that the copy reads well, that the model is easy to
 * understand, or that the layout is *attractive*. Geometry and hit areas are
 * checkable; taste is a screenshot review, which is separate.
 */

const STYLES = path.resolve(import.meta.dir, "../src/styles");
const CASCADE = [
	"gui-base.css",
	"gui-tone.css",
	"gui-chrome.css",
	"gui-composer.css",
	"gui-connection.css",
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
	.map(file => {
		const full = path.join(STYLES, file);
		return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
	})
	.join("\n");

/** The Tailwind utilities the dialog's markup carries. */
const UTILITIES = `
	.flex { display: flex; }
	.flex-col { flex-direction: column; }
	.flex-1 { flex: 1 1 0%; }
	.flex-shrink-0 { flex-shrink: 0; }
	.min-h-0 { min-height: 0; }
	.min-w-0 { min-width: 0; }
	.h-full { height: 100%; }
	.p-4 { padding: 16px; }
	.p-3 { padding: 12px; }
	.w-36 { width: 144px; }
	.text-\\[13px\\] { font-size: 13px; }
	.text-\\[14px\\] { font-size: 14px; }
	.font-semibold { font-weight: 600; }
	.font-medium { font-weight: 500; }
`;

const HOSTS = [
	{ name: "build-box", where: "me@build.example.com", status: "Saved" },
	{ name: "gpu-rig", where: "me@10.0.0.9:2222", status: "Local config only" },
];

/**
 * The rows in this fixture are rendered by the **shipped component**, not
 * hand-written. The previous version built its own markup, including a
 * `.gui-loc-copy` class that exists in zero files under `src/`, and gave both
 * lists the same shape — so it could not see the divergence it was supposed to
 * guard (the daemon list led with a 7px dot, the workspace list with a 24px
 * glyph, and only one of them had a trailing slot on every row).
 *
 * Rendering the component means a change to its structure reaches this test
 * automatically: the fixture cannot drift from what ships.
 */
function renderedRow(options: {
	leading: "dot" | "glyph";
	name: string;
	where: string;
	status: string;
	current?: boolean;
	action?: string;
}): string {
	return renderToStaticMarkup(
		<ConnectionLocationRow
			leading={options.leading}
			glyph="server"
			name={options.name}
			where={options.where}
			status={options.status}
			statusKind={options.current ? "connected" : "idle"}
			current={options.current ?? false}
			disabled={options.current ?? false}
			onActivate={() => {}}
			action={
				options.action ? (
					<button type="button" className="gui-tool-btn gui-loc-remove" aria-label={options.action}>
						×
					</button>
				) : undefined
			}
		/>,
	);
}

function fixture(): string {
	// The daemon list: dot-led, every row carries a status, stored rows carry a
	// remove action (the local row does not).
	const daemonRows = [
		renderedRow({
			leading: "dot",
			name: "This machine",
			where: "127.0.0.1:8300",
			status: "Connected",
			current: true,
		}),
		renderedRow({
			leading: "dot",
			name: HOSTS[0]!.name,
			where: HOSTS[0]!.where,
			status: HOSTS[0]!.status,
			action: "Remove",
		}),
		renderedRow({
			leading: "dot",
			name: HOSTS[1]!.name,
			where: HOSTS[1]!.where,
			status: HOSTS[1]!.status,
			action: "Remove",
		}),
	].join("");
	// The workspace list: glyph-led, a provenance status on every row.
	const workspaceRows = [
		renderedRow({
			leading: "glyph",
			name: HOSTS[0]!.name,
			where: HOSTS[0]!.where,
			status: HOSTS[0]!.status,
			current: true,
		}),
		renderedRow({ leading: "glyph", name: HOSTS[1]!.name, where: HOSTS[1]!.where, status: HOSTS[1]!.status }),
	].join("");
	return `
		<div class="gui-dialog-backdrop gui-dialog-backdrop--entered">
			<div class="gui-dialog gui-dialog--instance-manager gui-dialog--entered" role="dialog" aria-modal="true">
				<div class="gui-dialog-morph">
					<div class="gui-dialog-head">
						<span class="text-[14px] font-semibold">Connection locations</span>
						<button type="button" class="gui-tool-btn" aria-label="Close">×</button>
					</div>
					<p class="gui-loc-purpose">Decides which machine's MusePi daemon runs the session.</p>
					<div class="gui-instance-manager-body">
						<section class="gui-loc-section" aria-labelledby="gui-loc-instances">
							<h2 class="sr-only" id="gui-loc-instances">Daemon (instance)</h2>
							<ul class="gui-loc-list">${daemonRows}</ul>
							<div class="gui-loc-fields">
								<label class="gui-field"><span class="gui-field-label">Instance label</span><input class="gui-input" /></label>
								<label class="gui-field"><span class="gui-field-label">Service address</span><input class="gui-input" /></label>
							</div>
							<div class="gui-loc-actions">
								<button type="button" class="gui-btn gui-btn-primary">Test and add</button>
							</div>
						</section>
					</div>
				</div>
			</div>
		</div>`;
}

let browser: Browser;
let page: Page;

async function mount(width: number, height: number): Promise<void> {
	await page.setViewport({ width, height });
	await page.setContent(`
		<style>
			:root {
				--bg: rgb(18, 18, 18);
				--bg-overlay: rgb(24, 24, 24);
				--color-bg: rgb(18, 18, 18);
				--color-surface: rgb(32, 32, 32);
				--color-surface-sunken: rgb(28, 28, 28);
				--color-surface-raised: rgb(40, 40, 40);
				--color-text: rgb(235, 235, 235);
				--color-text-secondary: rgb(190, 190, 190);
				--color-text-muted: rgb(160, 160, 160);
				--color-text-faint: rgb(120, 120, 120);
				--color-accent: rgb(90, 150, 240);
				--color-accent-fg: rgb(255, 255, 255);
				--color-accent-soft: rgb(90 150 240 / 18%);
				--color-accent-bd: rgb(90 150 240 / 45%);
				--color-success: rgb(80, 200, 120);
				--color-danger: rgb(220, 90, 90);
				--color-warning: rgb(230, 180, 80);
				--border: rgb(70, 70, 70);
				--glass-border: rgb(80 80 80 / 60%);
				--glass-bg: rgb(40 40 40 / 70%);
				--glass-bg-strong: rgb(34 34 34 / 92%);
				--glass-sheen: linear-gradient(rgb(255 255 255 / 5%), transparent);
				--glass-shadow: 0 20px 60px rgb(0 0 0 / 50%);
				--glass-hover: rgb(255 255 255 / 8%);
				--radius-xs: 4px;
				--radius-sm: 6px;
				--radius-md: 8px;
				--radius-lg: 12px;
				--radius-xl: 16px;
				--radius-2xl: 20px;
				--radius-full: 999px;
				--spring: cubic-bezier(0.34, 1.56, 0.64, 1);
				--spring-snappy: cubic-bezier(0.2, 0.8, 0.2, 1);
				--z-modal: 3000;
				--ui-font-size: 15px;
				--ui-font-size-xs: 13px;
				--ui-font-size-sm: 14px;
				--gui-glass-blur: 12px;
				--gui-glass-saturate: 140%;
				--gui-glass-overlay: 55%;
				--gui-glass-alpha: 1;
				--font-mono: ui-monospace, monospace;
			}
			html, body { height: 100%; margin: 0; }
			${UTILITIES}
			${CASCADE}
		</style>
		${fixture()}`);
	await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))));
}

interface Box {
	top: number;
	left: number;
	width: number;
	height: number;
	right: number;
	bottom: number;
}

async function readGeometry() {
	return page.evaluate(() => {
		const box = (element: Element): Box => {
			const rect = element.getBoundingClientRect();
			return {
				top: Math.round(rect.top),
				left: Math.round(rect.left),
				width: Math.round(rect.width),
				height: Math.round(rect.height),
				right: Math.round(rect.right),
				bottom: Math.round(rect.bottom),
			};
		};
		const all = (selector: string) => Array.from(document.querySelectorAll<HTMLElement>(selector));
		const sections = all(".gui-loc-section");
		const body = document.querySelector<HTMLElement>(".gui-instance-manager-body")!;
		const bodyStyle = getComputedStyle(body);
		const lists = all(".gui-loc-list");
		const row = document.querySelector<HTMLElement>(".gui-loc-row")!;
		const rowMain = row.querySelector<HTMLElement>(".gui-loc-row-main")!;
		/** Cell positions relative to their own row, so the two lists — which sit
		 *  at different x on screen — can be compared cell for cell. */
		const cellsOf = (scope: Element) =>
			Array.from(scope.querySelectorAll<HTMLElement>(".gui-loc-row")).map(node => {
				const rowLeft = node.getBoundingClientRect().left;
				const at = (selector: string) => {
					const cell = node.querySelector<HTMLElement>(selector);
					return cell ? Math.round(cell.getBoundingClientRect().left - rowLeft) : null;
				};
				const rowBox = node.getBoundingClientRect();
				const statusBox = node.querySelector<HTMLElement>(".gui-loc-status")?.getBoundingClientRect();
				return {
					name: at(".gui-loc-name"),
					where: at(".gui-loc-where"),
					status: at(".gui-loc-status"),
					/** Distance from the row's own trailing edge. The two lists have
					 *  different widths, so a trailing slot cannot share an absolute
					 *  x; what must match is where it sits *within* the row. */
					trailingGap: statusBox ? Math.round(rowBox.right - statusBox.right) : null,
					hasStatus: statusBox !== undefined,
				};
			});
		const [firstList, secondList] = lists;
		return {
			dialog: box(document.querySelector<HTMLElement>(".gui-dialog")!),
			sections: sections.map(box),
			sectionsSideBySide:
				sections.length === 2 &&
				sections[0]!.getBoundingClientRect().right <= sections[1]!.getBoundingClientRect().left + 1,
			sectionsStacked:
				sections.length === 2 &&
				sections[0]!.getBoundingClientRect().bottom <= sections[1]!.getBoundingClientRect().top + 1,
			bodyOverflowX: bodyStyle.overflowX,
			bodyOverflowY: bodyStyle.overflowY,
			bodyScrollWidth: body.scrollWidth,
			bodyClientWidth: body.clientWidth,
			listOverflowX: lists.map(list => getComputedStyle(list).overflowX),
			listOverflowY: lists.map(list => getComputedStyle(list).overflowY),
			listOverflow: lists.map(list => ({ scrollWidth: list.scrollWidth, clientWidth: list.clientWidth })),
			row: box(row),
			rowMain: box(rowMain),
			daemonCells: firstList ? cellsOf(firstList) : [],
			workspaceCells: secondList ? cellsOf(secondList) : [],
			docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
		};
	});
}

beforeAll(async () => {
	const executablePath = await ensureChromiumExecutable();
	if (!executablePath) throw new Error("No Chromium executable resolved");
	browser = await puppeteer.launch({ executablePath, headless: true });
	page = await browser.newPage();
}, 120_000);

afterAll(async () => {
	await browser.close();
}, 60_000);

describe("single-axis dialog at 1280", () => {
	test("one section, and the dialog is sized for it", async () => {
		await mount(1280, 900);
		const geometry = await readGeometry();
		expect(geometry.sections).toHaveLength(1);
		const [section] = geometry.sections;
		// The frame must not keep the two-pane width: at 1040px the single list
		// sat against a blank right half, which reads as a failed layout.
		expect(geometry.dialog.width).toBeLessThan(700);
		expect(section!.width).toBeGreaterThan(300);
		expect(section!.left).toBeGreaterThanOrEqual(geometry.dialog.left);
		expect(section!.right).toBeLessThanOrEqual(geometry.dialog.right);
	});

	test("the dialog body is the only scroller and declares both axes", async () => {
		await mount(1280, 900);
		const geometry = await readGeometry();
		expect(geometry.bodyOverflowY).toBe("auto");
		expect(geometry.bodyOverflowX).toBe("clip");
		// No horizontal overflow under complete content (M80).
		expect(geometry.bodyScrollWidth).toBe(geometry.bodyClientWidth);
		expect(geometry.docOverflowX).toBeLessThanOrEqual(0);
	});

	test("neither list inside the body scrolls", async () => {
		await mount(1280, 900);
		const geometry = await readGeometry();
		for (const overflow of geometry.listOverflowY) expect(overflow).toBe("hidden");
		for (const size of geometry.listOverflow) expect(size.scrollWidth).toBe(size.clientWidth);
	});
});

describe("single-axis dialog at the narrowest supported window (720)", () => {
	test("the section stays inside the dialog and readable", async () => {
		await mount(720, 640);
		const geometry = await readGeometry();
		expect(geometry.sections).toHaveLength(1);
		const [section] = geometry.sections;
		expect(section!.width).toBeGreaterThan(240);
		expect(section!.right).toBeLessThanOrEqual(geometry.dialog.right);
	});

	test("no nested scrollbar appears at the narrow width either", async () => {
		await mount(720, 640);
		const geometry = await readGeometry();
		expect(geometry.bodyOverflowX).toBe("clip");
		expect(geometry.bodyScrollWidth).toBe(geometry.bodyClientWidth);
		for (const size of geometry.listOverflow) expect(size.scrollWidth).toBe(size.clientWidth);
	});
});

describe("row anatomy", () => {
	test("every row has a status slot", async () => {
		await mount(1280, 900);
		const geometry = await readGeometry();
		// Three daemon rows; none may omit the trailing slot, which is what made
		// half the list end early in the shape this replaced.
		expect(geometry.daemonCells).toHaveLength(3);
		for (const cell of geometry.daemonCells) expect(cell.hasStatus).toBe(true);
	});

	test("name and where sit at the same x on every row", async () => {
		await mount(1280, 900);
		const geometry = await readGeometry();
		// Exact, not bounded: the row is one component, so a divergence is a
		// defect rather than a permitted variation. A 7px dot beside a 24px glyph
		// shifting the name is what this catches.
		const first = geometry.daemonCells[0]!;
		for (const cell of geometry.daemonCells) {
			expect(cell.name).toBe(first.name);
			expect(cell.where).toBe(first.where);
		}
	});

	test("the status slot sits at a constant offset from the row's trailing edge", async () => {
		await mount(1280, 900);
		const geometry = await readGeometry();
		const gaps = geometry.daemonCells.map(cell => cell.trailingGap);
		expect(new Set(gaps).size).toBe(1);
	});
});
