/**
 * OTA updater — checks a version manifest and hands the renderer the
 * download URL when a newer release exists.
 *
 * The manifest is a tiny JSON attached as an ASSET to each GitHub release
 * (BitFun parity): /releases/latest/download/<asset> 302s to the newest
 * release's copy — no api.github.com rate limits, works anonymously once
 * the repo is public.
 *   { "version": "0.4.3", "url": "https://…/MusePi-0.4.3.dmg", "notes": "…" }
 *
 * Resolution order: OMP_UPDATE_MANIFEST_URL env → package.json
 * "update" → the MusePi releases-latest asset default. Auto-check on
 * startup can be silenced with OMP_NO_AUTO_UPDATE=1.
 */
"use strict";

const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const pkgPath = path.resolve(__dirname, "..", "package.json");
let pkg = {};
try {
	pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
} catch {
	// package.json missing — env-only mode
}

/** Default channel: the update-manifest.json asset on the latest GitHub release. */
const RELEASE_MANIFEST_URL =
	"https://github.com/MuseLinn/MusePi/releases/latest/download/update-manifest.json";

function manifestUrl() {
	if (process.env.OMP_UPDATE_MANIFEST_URL) return process.env.OMP_UPDATE_MANIFEST_URL;
	if (pkg.update?.manifestUrl) return pkg.update.manifestUrl;
	return RELEASE_MANIFEST_URL;
}

/** Fetch + compare the remote version. Returns null when up to date or disabled. */
async function checkForUpdates(timeoutMs = 8000) {
	const url = manifestUrl();
	if (!url) return { enabled: false, reason: "no-update-source" };
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, { signal: controller.signal, headers: { "Cache-Control": "no-cache" } });
		if (res.status === 404) {
			// The manifest repo is private or the file was never published —
			// equivalent to having no update source. The settings button must
			// not show a scary error for a not-yet-released app.
			return { enabled: false, reason: "no-update-source" };
		}
		if (!res.ok) return { enabled: true, error: `manifest ${res.status}` };
		const manifest = await res.json();
		if (typeof manifest.version !== "string" || typeof manifest.url !== "string") {
			return { enabled: true, error: "bad manifest" };
		}
		const current = app.getVersion();
		const newer = compareVersions(manifest.version, current) > 0;
		return { enabled: true, current, latest: manifest.version, newer, url: manifest.url, notes: manifest.notes };
	} catch (err) {
		return { enabled: true, error: err instanceof Error ? err.message : String(err) };
	} finally {
		clearTimeout(timer);
	}
}

/** Semver-ish compare; "0.1.0" < "0.1.1" < "0.2.0". */
function compareVersions(a, b) {
	const pa = String(a).split(".").map(n => Number.parseInt(n, 10) || 0);
	const pb = String(b).split(".").map(n => Number.parseInt(n, 10) || 0);
	for (let i = 0; i < 3; i++) {
		if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
	}
	return 0;
}

module.exports = { checkForUpdates, manifestUrl };
