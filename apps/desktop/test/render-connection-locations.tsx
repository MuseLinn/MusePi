/**
 * Screenshot review fixture for the two-axis dialog.
 *
 * Not a test: it renders the real stylesheet cascade and writes PNGs so the
 * composed interface can be looked at. Geometry tests prove placement; only a
 * picture shows whether the hierarchy reads.
 *
 *   bun apps/desktop/test/render-connection-locations.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import puppeteer from "puppeteer-core";
import { renderToStaticMarkup } from "react-dom/server";
import { ensureChromiumExecutable } from "../../../packages/coding-agent/src/tools/browser/launch";
import { ConnectionLocationRow } from "../src/components/ConnectionLocationRow";
import { iconSpriteData } from "../src/vendor/oc-icons/sprite";

const STYLES = path.resolve(import.meta.dir, "../src/styles");
/** A run stamp in the filename: an image reader that caches by path would
 *  otherwise show the previous render, which is how a stale picture gets
 *  reviewed as if it were current. */
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = path.resolve(import.meta.dir, "../../../.tmp/connection-locations");

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
	.mb-1 { margin-bottom: 4px; }
	.mb-3 { margin-bottom: 12px; }
	.mt-3 { margin-top: 12px; }
	.self-start { align-self: flex-start; }
`;

const HOSTS = [
	{ name: "build-box", where: "me@build.example.com", status: "Saved" },
	{ name: "gpu-rig", where: "me@10.0.0.9:2222", status: "Local config only" },
	{ name: "nas", where: "me@192.168.1.100", status: "Saved" },
];

function row(host: { name: string; where: string; status: string }, index: number, leading: "dot" | "glyph"): string {
	return renderToStaticMarkup(
		<ConnectionLocationRow
			leading={leading}
			glyph="server"
			name={host.name}
			where={host.where}
			status={host.status}
			statusKind={index === 0 ? "connected" : "idle"}
			current={index === 0}
			onActivate={() => {}}
			action={
				<button type="button" className="gui-tool-btn gui-loc-remove" aria-label="Remove">
					×
				</button>
			}
		/>,
	);
}

function fixture(): string {
	const rows = HOSTS.map((h, i) => row(h, i, "dot")).join("");
	const wizardRows = HOSTS.map((h, i) => row(h, i, "glyph")).join("");
	return `
		<div class="gui-dialog-backdrop gui-dialog-backdrop--entered">
			<div class="gui-dialog gui-dialog--instance-manager gui-dialog--entered" role="dialog" aria-modal="true">
				<div class="gui-dialog-morph">
					<div class="gui-dialog-head">
						<span class="text-[14px] font-semibold">连接位置</span>
						<button type="button" class="gui-tool-btn" aria-label="关闭">×</button>
					</div>
					<p class="gui-loc-purpose">决定会话由哪台机器上的 MusePi 守护进程运行。</p>
					<div class="gui-instance-manager-body">
						<section class="gui-loc-section" aria-labelledby="a">
							<h2 class="sr-only" id="a">后台服务（实例）</h2>
							<ul class="gui-loc-list">
								${row({ name: "本机", where: "127.0.0.1:8300", status: "已连接" }, 0, "dot")}
								${rows}
							</ul>
							<button type="button" class="gui-btn gui-btn-primary gui-loc-add">＋ 添加实例</button>
						</section>
					</div>
					<footer class="gui-loc-foot">
						<button type="button" class="gui-btn gui-btn-stop">断开当前实例</button>
						<button type="button" class="gui-remote-disclaimer-link">查看远程连接免责声明</button>
					</footer>
				</div>
			</div>
		</div>`;
}

/** The real token sheet is the only source of tokens. A hand-written
 *  override block here would drift from it — and did: a duplicated
 *  `--color-surface` made the glass sample a light card with white text, a UI
 *  that does not exist. */
/** `Icon` injects its sprite in a mount effect, which static rendering never
 *  runs — without this every glyph in the review image is a blank square. */
const SPRITE = `<svg id="openchamber-icon-sprite" aria-hidden="true" style="display:none">${Object.entries(
	iconSpriteData,
)
	.map(([name, content]) => `<symbol id="oc-${name}" viewBox="0 0 24 24">${content}</symbol>`)
	.join("")}</svg>`;

const TOKENS = `
	${fs.readFileSync(path.resolve(import.meta.dir, "../../../packages/client-core/src/styles/tokens.css"), "utf8")}
	html, body { height: 100%; margin: 0; background: var(--color-bg); color: var(--color-text); }
`;

const SIZES = [
	{ name: "1280", width: 1280, height: 900 },
	{ name: "720", width: 720, height: 640 },
];

async function main(): Promise<void> {
	const executablePath = await ensureChromiumExecutable();
	if (!executablePath) throw new Error("No Chromium executable resolved");
	fs.mkdirSync(OUT, { recursive: true });
	const browser = await puppeteer.launch({ executablePath, headless: true });
	try {
		const page = await browser.newPage();
		for (const size of SIZES) {
			await page.setViewport({ width: size.width, height: size.height });
			// The dialog ships on the app's dark theme; headless Chromium reports a
			// light colour scheme, whose token sheet would override the dark one.
			await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
			await page.setContent(`${SPRITE}<style>${TOKENS}${UTILITIES}${CASCADE}</style>${fixture()}`);
			await page.evaluate(() => {
				document.documentElement.setAttribute("data-theme", "dark");
				document.documentElement.setAttribute("data-platform", "linux");
			});
			await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))));
			// A review artifact is only worth looking at if its markup matches the
			// shipped structure. Assert that here rather than trusting the eye.
			const audit = await page.evaluate(() => {
				const rows = Array.from(document.querySelectorAll(".gui-loc-row"));
				const footer = document.querySelector(".gui-loc-foot");
				return {
					rows: rows.length,
					// Every row has exactly one lead box, whichever mark it holds; and
					// exactly one status slot, which is what the primitive guarantees.
					leadPerRow: rows.map(row => row.querySelectorAll(".gui-loc-lead").length),
					statusPerRow: rows.map(row => row.querySelectorAll(".gui-loc-status").length),
					footerInsideDialog: Boolean(footer?.closest(".gui-dialog")),
					sections: document.querySelectorAll(".gui-loc-section").length,
					dialogWidth: Math.round(
						(document.querySelector(".gui-dialog") as HTMLElement).getBoundingClientRect().width,
					),
					sectionsSideBySide:
						(document.querySelectorAll(".gui-loc-section")[0] as HTMLElement).getBoundingClientRect().right <=
						(document.querySelectorAll(".gui-loc-section")[1] as HTMLElement).getBoundingClientRect().left + 1,
					wizardDirection: getComputedStyle(document.querySelector(".gui-wizard-split") as HTMLElement)
						.flexDirection,
					railWidth: Math.round(
						(document.querySelector(".gui-wizard-rail") as HTMLElement).getBoundingClientRect().width,
					),
				};
			});
			if (audit.leadPerRow.some(count => count !== 1)) throw new Error(`row lead: ${JSON.stringify(audit)}`);
			if (audit.statusPerRow.some(count => count !== 1)) throw new Error(`row status: ${JSON.stringify(audit)}`);
			if (!audit.footerInsideDialog) throw new Error(`footer escaped the dialog: ${JSON.stringify(audit)}`);
			console.log(size.name, JSON.stringify(audit));
			const file = path.join(OUT, `connection-locations-${size.name}-${STAMP}.png`);
			await page.screenshot({ path: file as `${string}.png` });
			console.log(file);
		}
	} finally {
		await browser.close();
	}
}

await main();
