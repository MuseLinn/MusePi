#!/usr/bin/env bun
/**
 * Keep the website's hard-coded release version in step with the release.
 *
 * The landing page is a zero-build static site: `pages.yml` copies `web/`
 * verbatim, so nothing rewrites the version at publish time. The page shows
 * the current release in two places, and main.js replaces both from the
 * GitHub Releases API at runtime — but only when that request succeeds. On a
 * blocked, rate-limited or offline visitor the page keeps whatever the markup
 * says, which is how the site ended up advertising v0.5.4 while v0.5.6 was
 * the actual release.
 *
 * So the fallback is a real, user-visible number and it has to be right.
 * This gate compares it against the version the desktop app is built from.
 *
 * The API refresh stays in place: it lets a site published between releases
 * still show the newest tag, and it self-corrects the moment the release
 * workflow publishes.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const INDEX_HTML = path.join(REPO_ROOT, "web", "index.html");
const DESKTOP_PKG = path.join(REPO_ROOT, "packages", "desktop-app", "package.json");

if (!fs.existsSync(INDEX_HTML) || !fs.existsSync(DESKTOP_PKG)) {
	console.error("[web-version] missing web/index.html or packages/desktop-app/package.json");
	process.exit(2);
}

const desktopVersion = (JSON.parse(fs.readFileSync(DESKTOP_PKG, "utf8")) as { version?: string }).version;
if (!desktopVersion) {
	console.error("[web-version] packages/desktop-app/package.json has no version");
	process.exit(2);
}

const html = fs.readFileSync(INDEX_HTML, "utf8");

// Every version the page can show before the runtime refresh lands.
const fallbacks = [...html.matchAll(/data-release-version[^>]*>(v?\d+\.\d+\.\d+)</g)].map(m => m[1]);

if (fallbacks.length === 0) {
	console.error("[web-version] no [data-release-version] placeholders found in web/index.html");
	process.exit(1);
}

const expected = `v${desktopVersion}`;
const stale = fallbacks.filter(v => v !== expected);

if (stale.length > 0) {
	console.error(
		`[web-version] web/index.html advertises ${stale.join(", ")} but the release is ${expected}.\n` +
			"  The runtime refresh only replaces these when the GitHub API answers, so a stale\n" +
			"  fallback is what visitors see when it does not. Update the placeholders to\n" +
			`  ${expected} (packages/desktop-app/package.json is the source of truth).`,
	);
	process.exit(1);
}

console.log(`[web-version] OK  (${fallbacks.length} placeholders, ${expected})`);
