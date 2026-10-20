#!/usr/bin/env bun
/**
 * Generate sitemap.xml and robots.txt for the Pages site.
 *
 * The site publishes ~140 documentation pages from docs/ and a landing page
 * from web/, and Jekyll rewrites each `foo.md` to `foo.html` (the
 * jekyll-relative-links plugin). A hand-written sitemap would list a subset
 * of them the first time a document was added, so it is generated instead.
 *
 * The zh-CN twins are published under their own names (`foo.zh-CN.html`),
 * which is what the language switcher links to.
 *
 * Usage:
 *   bun scripts/build-site-sitemap.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const DOCS_DIR = path.join(REPO_ROOT, "docs");
const OUT_DIR = path.join(REPO_ROOT, "web");

/** The Pages site root. baseurl in _config.yml is /MusePi. */
const SITE = "https://muselinn.github.io";
const BASE = "/MusePi";

if (!fs.existsSync(DOCS_DIR)) {
	console.error("[sitemap] docs/ not found");
	process.exit(2);
}

interface Entry {
	loc: string;
	lastmod: string;
	changefreq: string;
	priority: string;
}

const entries: Entry[] = [
	{ loc: `${SITE}${BASE}/`, lastmod: "", changefreq: "weekly", priority: "1.0" },
];

// The landing page and the docs index.
entries.push({
	loc: `${SITE}${BASE}/docs/`,
	lastmod: "",
	changefreq: "weekly",
	priority: "0.8",
});

const docs = fs
	.readdirSync(DOCS_DIR)
	.filter(name => name.endsWith(".md"))
	.sort();

for (const name of docs) {
	const stat = fs.statSync(path.join(DOCS_DIR, name));
	const lastmod = stat.mtime.toISOString().slice(0, 10);
	// Jekyll turns `foo.md` into `foo.html`; `foo.zh-CN.md` becomes
	// `foo.zh-CN.html` and is linked from the language switcher.
	const html = name.replace(/\.md$/, ".html");
	entries.push({
		loc: `${SITE}${BASE}/docs/${html}`,
		lastmod,
		changefreq: "monthly",
		priority: "0.6",
	});
}

// The landing page's own mtime, so its lastmod is not empty.
const landingStat = fs.statSync(path.join(OUT_DIR, "index.html"));
entries[0].lastmod = landingStat.mtime.toISOString().slice(0, 10);

const xml = [
	'<?xml version="1.0" encoding="UTF-8"?>',
	'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
	...entries.map(e =>
		[
			"  <url>",
			`    <loc>${e.loc}</loc>`,
			e.lastmod ? `    <lastmod>${e.lastmod}</lastmod>` : "",
			`    <changefreq>${e.changefreq}</changefreq>`,
			`    <priority>${e.priority}</priority>`,
			"  </url>",
		]
			.filter(Boolean)
			.join("\n"),
	),
	"</urlset>",
	"",
].join("\n");

fs.writeFileSync(path.join(OUT_DIR, "sitemap.xml"), xml, "utf8");

const robots = [
	"# https://muselinn.github.io/MusePi/",
	"User-agent: *",
	"Allow: /",
	"",
	`Sitemap: ${SITE}${BASE}/sitemap.xml`,
	"",
].join("\n");

fs.writeFileSync(path.join(OUT_DIR, "robots.txt"), robots, "utf8");

console.log(`[sitemap] ${entries.length} urls -> web/sitemap.xml`);
console.log(`[sitemap] robots.txt -> ${SITE}${BASE}/sitemap.xml`);
