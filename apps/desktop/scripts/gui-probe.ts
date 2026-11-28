#!/usr/bin/env bun
/**
 * Render a GUI component with the REAL stylesheets and report what it measured.
 *
 * Why this exists: verifying a GUI change used to mean hand-writing a throwaway
 * preview, a throwaway puppeteer script and a throwaway probe, then deleting
 * them. That workflow found real defects every time (a card stretched to 272px
 * by an inherited `flex: 1`; a Docker card showing WSL copy; a form that read as
 * two competing pickers), so the *procedure* is worth keeping — but it was
 * rebuilt from scratch each round, and each rebuild re-introduced the same
 * mistakes. They are encoded here instead:
 *
 *  1. **The bundle ships no usable CSS.** `bun build` emits a partial sheet;
 *     concatenating the real files in the app's own import order is what makes
 *     the render faithful. Anything less renders unstyled markup and reports
 *     zero radii, which reads exactly like a CSS bug that does not exist.
 *  2. **The app writes `data-theme` on mount.** Setting it before mounting is
 *     overwritten. It is re-asserted after the scene settles.
 *  3. **Dialogs portal to `document.body`.** Querying the mount container finds
 *     nothing for anything built on `DialogFrame`; the query root is the body.
 *  4. **`html` inherits no colour in a bare page.** Without an explicit
 *     `color: var(--color-text)` headings render white-on-white.
 *  5. **A module script does not run from `file://`.** Chromium refuses it
 *     silently — no page error, no console message, no stage marker — so the
 *     symptom is "the scenario never finished" and the cause is invisible.
 *     Loopback HTTP with an explicit `text/javascript` content type is what
 *     works, and the boot script is a file too: an inline module next to a
 *     1.4MB inline stylesheet is not reliably executed either.
 *  6. **Reading computed values beats reading the image.** "The card looks
 *     tall" is a guess; `height: 271.625px` beside `flex: 1 1 0%` is the cause.
 *     Every scenario returns measurements, and screenshots are evidence beside
 *     them, never the only output.
 *
 * A scenario also declares what it *expects*, so a run answers "is this still
 * right" rather than "here is a picture". A failed expectation exits non-zero.
 *
 * Usage:
 *   bun apps/desktop/scripts/gui-probe.ts <scenario.tsx> [options]
 *     --theme light,dark     themes to render (default both)
 *     --width 900            layout width for the mount container
 *     --out DIR              where screenshots go (default apps/desktop/.tmp/gui-probe)
 *     --json                 print the measurement bundle as JSON only
 *
 * A scenario module default-exports an object keyed by scenario name; each
 * value is `{ render(root), measure?(body), expect?, capture? }`. See
 * `scripts/gui-probe-scenarios/` for worked examples.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..");
const REPO_ROOT = resolve(APP_DIR, "../..");
const STYLES = join(APP_DIR, "src", "styles");
const CORE_STYLES = join(REPO_ROOT, "packages", "client-core", "src", "styles");

// ── argv ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
	const index = argv.indexOf(name);
	return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const scenarioFile = argv.find((arg, index) => !arg.startsWith("--") && !argv[index - 1]?.startsWith("--"));
if (!scenarioFile) {
	console.error(
		"usage: bun apps/desktop/scripts/gui-probe.ts <scenario.tsx> [--theme light,dark] [--width 900] [--out DIR] [--json]",
	);
	process.exit(2);
}
const themes = flag("--theme", "light,dark").split(",");
const width = Number(flag("--width", "900"));
const outDir = resolve(REPO_ROOT, flag("--out", "apps/desktop/.tmp/gui-probe"));
const jsonOnly = argv.includes("--json");

/** Point 1: the stylesheets the renderer links, in the renderer's order. */
function stylesheetText() {
	const gui = readFileSync(join(STYLES, "gui.css"), "utf8").replace(/@import\s+"\.\/([^"]+)";/g, (_match, name) => {
		const file = join(STYLES, name);
		if (!existsSync(file)) throw new Error(`gui.css imports a missing sheet: ${name}`);
		return readFileSync(file, "utf8");
	});
	const parts = [join(CORE_STYLES, "tokens.css"), join(CORE_STYLES, "base.css"), join(STYLES, "tailwind.out.css")];
	for (const file of parts) {
		if (!existsSync(file)) throw new Error(`missing stylesheet: ${file}`);
	}
	// The transcript sheet is imported by main.tsx outside gui.css, so a scenario
	// that renders transcript components needs it appended explicitly.
	const transcript = join(REPO_ROOT, "packages/client-core/src/components/transcript/transcript.css");
	const dictation = join(STYLES, "dictation.css");
	const extra = [transcript, dictation]
		.filter(file => existsSync(file))
		.map(file => readFileSync(file, "utf8"))
		.join("\n");
	return [...parts.map(file => readFileSync(file, "utf8")), gui, extra].join("\n");
}

/** A Chromium the host already has. Never downloads one. */
function findChrome() {
	const candidates = [
		process.env.MUSEPI_CHROME,
		"C:/Program Files/Google/Chrome/Application/chrome.exe",
		"C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
		"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
	].filter((file): file is string => typeof file === "string" && file.length > 0);
	const found = candidates.find(file => existsSync(file));
	if (!found) {
		throw new Error(`no Chromium found; set MUSEPI_CHROME.\nlooked in:\n  ${candidates.join("\n  ")}`);
	}
	return found;
}

/**
 * Point 5: a static server over the work directory.
 *
 * `file://` refuses to run module scripts and says nothing about it, so every
 * stage marker stays unset and the run reports "did not finish". Serving from
 * loopback is the standard fix and costs one listener.
 */
function serveWorkDir(dir: string): { url: string; stop: () => void } {
	const server = Bun.serve({
		port: 0,
		fetch(request: Request): Response {
			const pathname = decodeURIComponent(new URL(request.url).pathname);
			const file = join(dir, pathname);
			if (!file.startsWith(dir)) return new Response("forbidden", { status: 403 });
			if (!existsSync(file)) return new Response("not found", { status: 404 });
			// An explicit type matters: without it the browser will not treat the
			// response as a module script, and that failure is silent too.
			const type =
				file.endsWith(".js") || file.endsWith(".mjs")
					? "text/javascript"
					: file.endsWith(".css")
						? "text/css"
						: file.endsWith(".html")
							? "text/html"
							: "application/octet-stream";
			return new Response(readFileSync(file), { headers: { "content-type": `${type}; charset=utf-8` } });
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/**
 * Point 5's second half: the boot script is a FILE, not an inline module.
 *
 * Every stage records where it got to so a failure names the stage instead of
 * "timed out" — a top-level throw in a module reports nothing useful.
 */
function bootScript(bundleName: string, scenario: string, theme: string): string {
	// Results travel through the DOM, not through `window`: a module script and
	// `page.evaluate` do not reliably observe the same global object, and a value
	// written to `window` here read back as undefined — which looked exactly like
	// "the script never ran" while the tree was in fact rendered.
	return `const root = document.getElementById("root");
const stage = m => { root.dataset.stage = m; };
const publish = (key, value) => { root.dataset[key + "Json"] = JSON.stringify(value); };
stage("start");
const scenarioName = ${JSON.stringify(scenario)};
// A throw anywhere below used to leave the stage at the last phase that ran, so
// the probe could only report the phase, not the fault. Publishing it keeps the
// failure self-describing.
try {
	stage("import");
	const mod = await import("./bundle/${bundleName}");
	const scenarios = mod.default ?? mod;
	stage(scenarios ? "registered" : "not-registered");
	const entry = (scenarios?.scenarios ?? scenarios)?.[scenarioName];
	if (!entry) throw new Error("unknown scenario: " + scenarioName);
	stage("render");
	await entry.render(root);
	stage("rendered");
	// Point 2: the app owns data-theme and rewrites it on mount.
	document.documentElement.setAttribute("data-theme", ${JSON.stringify(theme)});
	document.documentElement.setAttribute("data-platform", ${JSON.stringify(process.platform)});
	await new Promise(r => setTimeout(r, 250));
	stage("measure");
	publish("result", (await entry.measure?.(document.body)) ?? null);
	publish("expectations", entry.expect ?? null);
	stage("done");
} catch (error) {
	publish("bootError", String(error && error.stack ? error.stack : error));
	stage("error");
}
`;
}

function pageHtml(theme: string, bootName: string, scenario: string): string {
	return `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8">
<style>${stylesheetText()}</style>
<style>
  /* Point 4: a bare page has no inherited colour. */
  html { color: var(--color-text); }
  body { margin: 0; padding: 20px; }

  /* Point 7: the desktop shell is deliberately transparent at html/body so the
   * native window material shows through; gui-base.css then paints the canvas
   * only under a platform attribute, and a window without one renders no
   * backdrop at all. The app always sets it, so the probe must too — otherwise
   * every light-theme capture shows light cards floating on black. */
  body { background: var(--color-bg); }
  #root { max-width: ${width}px; }
</style>
</head><body>
<div id="root" data-scenario="${scenario}"></div>
<script type="module" src="./${bootName}"></script>
</body></html>`;
}

/**
 * Point 3: scenario names come from the source, not from importing it.
 *
 * This script runs in Bun; a scenario imports browser modules that evaluate DOM
 * globals at import time (`HTMLElement` for one). Importing the file here to
 * read its keys would fail on a scenario that is perfectly valid in the page.
 */
function scenarioNames(source: string): string[] {
	// The scenario map is whatever the module exports as default. Finding its
	// *body* is enough to read the keys, and it avoids caring whether the author
	// wrote `export default { … }` or `const scenarios = { … }; export default
	// scenarios` — both end up as "some object literal associated with the
	// default export", and the second is what gives type checking.
	let start = source.search(/export\s+default\s*\{/);
	if (start < 0) {
		// `export default <name>`: locate the declaration of *that* name. The
		// search is anchored at line start so a selector table named elsewhere in
		// the file cannot be mistaken for the scenario map.
		const named = /export\s+default\s+([A-Za-z_$][\w$]*)/.exec(source);
		if (named) {
			const declaration = new RegExp(`^(?:const|let|var)\\s+${named[1]}\\s*=\\s*\\{`, "m");
			start = source.search(declaration);
		}
	}
	if (start < 0) return [];
	const body = source.slice(source.indexOf("{", start) + 1);
	const names: string[] = [];
	let depth = 0;
	let lineStart = 0;
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (ch === "{") depth += 1;
		else if (ch === "}") {
			if (depth === 0) break;
			depth -= 1;
		} else if (ch === "\n") lineStart = i + 1;
		else if (depth === 0) {
			const quoted =
				/^"([^"]+)"\s*:/.exec(body.slice(i)) ??
				/^'([^']+)'\s*:/.exec(body.slice(i)) ??
				/^([A-Za-z_$][\w$-]*)\s*:/.exec(body.slice(i));
			const indent = /^\s*/.exec(body.slice(lineStart))?.[0].length ?? 0;
			if (quoted && i === lineStart + indent) {
				names.push(quoted[1]);
				i += quoted[1].length;
			}
		}
	}
	return names;
}

/** The `capture` selector a scenario declares, read the same shallow way. */
function captureSelector(source: string, scenario: string): string {
	const escaped = scenario.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const at = source.search(new RegExp(`(?:^|[\\s{,])["']?${escaped}["']?\\s*:\\s*\\{`));
	if (at < 0) return "#root";
	const match = /capture\s*:\s*["']([^"']+)["']/.exec(source.slice(at, at + 400));
	return match ? match[1] : "#root";
}

/** Evaluate a scenario's own expectations against its measurement. */
function checkExpectations(
	expectations: Record<string, Record<string, unknown>> | null,
	measured: { elements?: Record<string, Record<string, unknown>> } | null,
): string[] {
	if (!expectations || !measured) return [];
	const failures = [];
	for (const [key, spec] of Object.entries(expectations)) {
		const row = measured.elements?.[key];
		if (!row) {
			failures.push(`${key}: not measured`);
			continue;
		}
		for (const [property, want] of Object.entries(spec)) {
			// `box` addresses the geometry; `box.h` its height. Everything else is
			// a computed style or attribute already flattened onto the row.
			const [field, sub] = property.split(".");
			const box = row.box as Record<string, number> | undefined;
			const got = field === "box" && sub ? box?.[sub] : row[field];
			// `{ max: 120 }` asserts a bound: a layout defect such as "the card
			// stretched to the tallest track" is a range violation, and pinning an
			// exact pixel would fail on every harmless copy change.
			if (want && typeof want === "object" && !Array.isArray(want) && ("max" in want || "min" in want)) {
				if (typeof got !== "number") {
					failures.push(`${key}.${property}: not a number (${JSON.stringify(got)})`);
					continue;
				}
				const bound = want as { max?: number; min?: number };
				if (bound.max !== undefined && got > bound.max)
					failures.push(`${key}.${property}: ${got} exceeds ${bound.max}`);
				if (bound.min !== undefined && got < bound.min)
					failures.push(`${key}.${property}: ${got} below ${bound.min}`);
				continue;
			}
			const ok =
				typeof want === "object" && want !== null ? JSON.stringify(got) === JSON.stringify(want) : got === want;
			if (!ok) failures.push(`${key}.${property}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
		}
	}
	return failures;
}

/** Bundle the scenario behind a generated entry that re-exports it as default. */
async function bundleScenario(scenarioPath: string, workDir: string): Promise<string> {
	const entryFile = join(workDir, "entry.ts");
	writeFileSync(entryFile, `export { default } from ${JSON.stringify(scenarioPath)};\n`);
	const out = join(workDir, "bundle");
	const result = await Bun.build({ entrypoints: [entryFile], target: "browser", format: "esm", outdir: out });
	if (!result.success) {
		for (const log of result.logs) console.error(String(log));
		throw new Error("scenario bundle failed");
	}
	const entry = result.outputs.find(file => file.path.endsWith(".js"));
	if (!entry) throw new Error("bundle produced no JS entry");
	return basename(entry.path);
}

const scenarioPath = resolve(scenarioFile);
if (!existsSync(scenarioPath)) {
	console.error(`scenario not found: ${scenarioPath}`);
	process.exit(2);
}

const source = readFileSync(scenarioPath, "utf8");
const scenarios = scenarioNames(source);
if (scenarios.length === 0) {
	console.error(`no scenarios found in ${scenarioFile} — default-export an object keyed by scenario name`);
	process.exit(2);
}

const workDir = mkdtempSync(join(tmpdir(), "musepi-gui-probe-"));
mkdirSync(outDir, { recursive: true });
let exitCode = 0;
let server: { url: string; stop: () => void } | undefined;
let browser: Awaited<ReturnType<typeof import("puppeteer-core")["default"]["launch"]>> | undefined;
try {
	const bundleName = await bundleScenario(scenarioPath, workDir);
	server = serveWorkDir(workDir);
	const { default: puppeteer } = await import("puppeteer-core");
	browser = await puppeteer.launch({
		executablePath: findChrome(),
		headless: true,
		args: ["--no-sandbox", "--disable-dev-shm-usage", "--force-color-profile=srgb"],
	});
	const results = [];
	for (const scenario of scenarios) {
		for (const theme of themes) {
			const bootName = `boot-${scenario}-${theme}.mjs`;
			writeFileSync(join(workDir, bootName), bootScript(bundleName, scenario, theme));
			const pageFile = `page-${scenario}-${theme}.html`;
			writeFileSync(join(workDir, pageFile), pageHtml(theme, bootName, scenario));

			const page = await browser.newPage();
			await page.setViewport({ width: width + 60, height: 1100, deviceScaleFactor: 2 });
			const errors: string[] = [];
			page.on("pageerror", error => errors.push(String(error)));
			page.on("console", message => {
				// A scenario that throws inside the page otherwise reports only
				// "waiting failed", which says nothing about why.
				// A missing favicon is the browser asking a question this page never
				// answers; it is not a defect in what the scenario renders.
				const text = message.text();
				if (message.type() === "error" && !/favicon|Failed to load resource/.test(text)) {
					errors.push(`console: ${text}`);
				}
			});
			await page.goto(`${server.url}/${pageFile}`, { waitUntil: "load", timeout: 60_000 });
			try {
				await page.waitForFunction(() => document.getElementById("root")?.dataset.stage === "done", {
					timeout: 20_000,
				});
			} catch {
				const staged = await page
					.evaluate(() => document.getElementById("root")?.dataset.stage ?? "unknown")
					.catch(() => "unknown");
				// A scenario that throws used to leave only a stage name behind
				// ("last stage: render"), which named the phase but not the fault.
				const bootError = await page
					.evaluate(() => document.getElementById("root")?.dataset.bootErrorJson ?? "")
					.catch(() => "");
				const raised = bootError ? `\n    scenario threw: ${JSON.parse(bootError)}` : "";
				const detail = ` (last stage: ${staged})${raised}${errors.length > 0 ? `\n    ${errors.join("\n    ")}` : ""}`;
				throw new Error(`scenario "${scenario}" / ${theme} did not finish measuring${detail}`);
			}
			const { measured, expectations } = (await page.evaluate(() => {
				const node = document.getElementById("root");
				const parse = (key: string): unknown => {
					const raw = node?.dataset[`${key}Json`];
					return raw ? JSON.parse(raw) : null;
				};
				return { measured: parse("result"), expectations: parse("expectations") };
			})) as {
				measured: { elements?: Record<string, Record<string, unknown>> } | null;
				expectations: Record<string, Record<string, unknown>> | null;
			};
			const shot = join(outDir, `${scenario}-${theme}.png`);
			const target = await page.$(captureSelector(source, scenario));
			if (target) await target.screenshot({ path: shot });
			else await page.screenshot({ path: shot });
			const failures = [...checkExpectations(expectations, measured), ...errors];
			if (failures.length > 0) exitCode = 1;
			results.push({ scenario, theme, measured, shot, failures });
			await page.close();
		}
	}

	if (jsonOnly) {
		console.log(JSON.stringify(results, null, 1));
	} else {
		for (const row of results) {
			console.log(
				`\n=== ${row.scenario} / ${row.theme} — ${row.failures.length === 0 ? "ok" : `FAIL (${row.failures.length})`} ===`,
			);
			if (row.measured) console.log(JSON.stringify(row.measured, null, 1));
			for (const failure of row.failures) console.log(`  ✗ ${failure}`);
			console.log(`  ▸ ${row.shot}`);
		}
	}
} finally {
	await browser?.close().catch(() => {});
	server?.stop();
	// Nothing here is a deliverable; keep the tree only when asked to debug it.
	if (process.env.MUSEPI_GUI_PROBE_KEEP) console.log(`kept: ${workDir}`);
	else rmSync(workDir, { recursive: true, force: true });
}
process.exit(exitCode);
