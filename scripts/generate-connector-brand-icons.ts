/**
 * Generate the connector brand glyphs.
 *
 * Every connector card shows a vendor mark. Loading one over the network per
 * card is both slow and a small disclosure — the vendor learns that this
 * machine opened its settings page. The glyphs are therefore committed data:
 * this script reads them once, at development time, and writes a module the
 * renderer imports.
 *
 * Sources, preferred in this order:
 *
 * 1. `simple-icons` through Iconify — one monochrome path per brand, which is
 *    the shape a single-colour tile wants.
 * 2. `logos` through Iconify — vendor marks that simple-icons does not carry.
 * 3. The vendor's own icon, fetched once from the address its page declares
 *    and stored as a data URI. A vector becomes paths like the two above; a
 *    PNG or ICO is kept as the bytes the vendor serves.
 *
 * A brand with none of the three is left out; the card falls back to its
 * initial, which reads as deliberate rather than as a broken image.
 *
 * Run with `bun scripts/generate-connector-brand-icons.ts`. The output is
 * committed, so building or running the app needs no network and no extra
 * dependency.
 */

import { writeFile } from "node:fs/promises";
import { BUNDLED_CONNECTORS } from "../packages/coding-agent/src/connectors/bundled-catalog";

const OUTPUT = new URL(
	"../apps/desktop/src/components/settings-sections/connector-brand-icons.generated.ts",
	import.meta.url,
);

/**
 * Iconify slugs per connector id.
 *
 * A connector's id is its own slug inside MusePi, not necessarily the icon
 * collection's. Each candidate is tried in order.
 */
const SLUGS: Record<string, string[]> = {
	github: ["simple-icons/github"],
	gitlab: ["simple-icons/gitlab"],
	sentry: ["simple-icons/sentry"],
	cloudflare: ["simple-icons/cloudflare"],
	vercel: ["simple-icons/vercel"],
	netlify: ["simple-icons/netlify"],
	render: ["simple-icons/render"],
	postman: ["simple-icons/postman"],
	sourcegraph: ["logos/sourcegraph", "simple-icons/sourcegraph"],
	deepwiki: [],
	context7: [],
	"microsoft-learn": ["logos/microsoft"],
	"apollo-graphos": ["simple-icons/apollographql"],
	scalar: ["simple-icons/scalar"],
	notion: ["simple-icons/notion"],
	atlassian: ["simple-icons/atlassian"],
	dropbox: ["simple-icons/dropbox"],
	egnyte: ["simple-icons/egnyte"],
	huggingface: ["simple-icons/huggingface"],
	perplexity: ["simple-icons/perplexity"],
	firecrawl: ["logos/firecrawl", "simple-icons/firecrawl"],
	tavily: ["logos/tavily"],
	exa: ["logos/exa"],
	parallel: [],
	jina: ["logos/jina", "simple-icons/jina"],
	mem0: ["logos/mem0"],
	amap: [],
	figma: ["simple-icons/figma"],
	canva: ["simple-icons/canva"],
	miro: ["simple-icons/miro"],
	webflow: ["simple-icons/webflow"],
	sanity: ["simple-icons/sanity"],
	tldraw: ["simple-icons/tldraw"],
	supabase: ["simple-icons/supabase"],
	neon: ["simple-icons/neon"],
	airtable: ["simple-icons/airtable"],
	prisma: ["simple-icons/prisma"],
	planetscale: ["simple-icons/planetscale"],
	turso: ["simple-icons/turso"],
	cockroachdb: ["simple-icons/cockroachlabs"],
	clickhouse: ["simple-icons/clickhouse"],
	motherduck: [],
	amplitude: ["logos/amplitude", "simple-icons/amplitude"],
	posthog: ["simple-icons/posthog"],
	linear: ["simple-icons/linear"],
	stripe: ["simple-icons/stripe"],
	paypal: ["simple-icons/paypal"],
	intercom: ["simple-icons/intercom"],
	monday: ["logos/monday", "simple-icons/mondaydotcom"],
	clickup: ["simple-icons/clickup"],
	asana: ["simple-icons/asana"],
	todoist: ["simple-icons/todoist"],
	zapier: ["simple-icons/zapier"],
	attio: [],
	"cal-com": ["simple-icons/caldotcom"],
	ramp: [],
	ashby: [],
	plain: [],
	feishu: [],
	lark: [],
};

/**
 * Vendor-declared icons for brands the icon collections do not carry.
 *
 * Each address comes from that site's own `rel="icon"` link, so the mark is
 * the one the vendor serves rather than a redrawn approximation.
 */
const VENDOR_ICONS: Record<string, string> = {
	feishu: "https://www.feishu.cn/favicon.ico",
	lark: "https://p16-hera-overseas.larksuitecdn.com/tos-mya-i-lojyj5t9n9/9b87226605154fb7b8141a9c94de22e9.png~tplv-lojyj5t9n9-origin.image",
	amap: "https://a.amap.com/pc/static/favicon.ico",
	attio: "https://attio.com/favicon.ico",
	ramp: "https://ramp.com/favicon.ico",
	motherduck: "https://www.motherduck.com/apple-touch-icon.png",
	context7: "https://context7.com/favicon.ico",
	parallel: "https://parallel.ai/icon.svg",
	ashby: "https://www.ashbyhq.com/icon.png",
	canva: "https://www.canva.com/favicon.ico",
	plain: "https://framerusercontent.com/images/BXA24c7albrT0OqBIAA9KPt1pg.png",
	mem0: "https://framerusercontent.com/images/2ys67ADJdvcyGmQnhp8vKWSq8.svg",
};

interface Glyph {
	viewBox: string;
	paths: Array<{ d: string; fill?: string }>;
}

/**
 * One icon from a collection.
 *
 * `simple-icons` is read from the installed package: the version comes from
 * the lockfile, so the same input gives the same output on every machine and
 * the run needs no network for it. The `logos` collection is not vendored, so
 * those few marks are fetched; the run reports which ones.
 */
async function fetchSvg(slug: string): Promise<string | undefined> {
	const [collection, name] = slug.split("/");
	if (collection === "simple-icons" && name) {
		try {
			return await Bun.file(new URL(`../node_modules/simple-icons/icons/${name}.svg`, import.meta.url)).text();
		} catch {
			return undefined;
		}
	}
	for (let attempt = 0; attempt < 3; attempt++) {
		if (attempt > 0) await Bun.sleep(800 * attempt);
		try {
			const response = await fetch(`https://api.iconify.design/${slug}.svg`, {
				signal: AbortSignal.timeout(15_000),
			});
			const text = await response.text();
			if (response.ok && text.startsWith("<svg")) return text;
			if (response.ok) continue;
		} catch {
			// Retried below; a missing icon must not fail the whole run.
		}
	}
	return undefined;
}

/**
 * Read a rendered SVG into paths.
 *
 * Only `<path>` elements are kept: they carry the marks these collections use,
 * and keeping the raw markup would mean injecting it as HTML at render time.
 */
function parseSvg(svg: string): Glyph | undefined {
	const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1] ?? "0 0 24 24";
	const paths: Array<{ d: string; fill?: string }> = [];
	for (const match of svg.matchAll(/<path\b([^>]*)\/?>/g)) {
		const attrs = match[1] ?? "";
		const d = /\bd="([^"]+)"/.exec(attrs)?.[1];
		if (!d) continue;
		const fill = /\bfill="([^"]+)"/.exec(attrs)?.[1];
		// `currentColor` is the theme's job, not a brand colour.
		paths.push(fill && fill !== "currentColor" && fill !== "none" ? { d, fill } : { d });
	}
	return paths.length > 0 ? { viewBox, paths } : undefined;
}

/**
 * Read a vendor icon.
 *
 * An SVG goes through the same path parser as the collections. Anything else
 * is kept as the bytes the vendor serves, base64-encoded into a data URI: a
 * raster mark cannot be expressed as a path, and re-encoding it would mean
 * shipping an image decoder for a 20-pixel tile.
 */
async function fetchVendorIcon(url: string): Promise<Glyph | { dataUri: string } | undefined> {
	for (let attempt = 0; attempt < 3; attempt++) {
		if (attempt > 0) await Bun.sleep(800 * attempt);
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
			if (!response.ok) continue;
			const type = response.headers.get("content-type") ?? "";
			const bytes = new Uint8Array(await response.arrayBuffer());
			if (bytes.byteLength === 0) continue;
			if (/svg/i.test(type) || /^\s*<svg/i.test(new TextDecoder().decode(bytes.subarray(0, 200)))) {
				const glyph = parseSvg(new TextDecoder().decode(bytes));
				if (glyph) return glyph;
				continue;
			}
			const mime = /icon/i.test(type) ? "image/x-icon" : type.split(";")[0] || "image/png";
			return { dataUri: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}` };
		} catch {
			// Retried above.
		}
	}
	return undefined;
}

const glyphs: Record<string, Glyph | { dataUri: string }> = {};
const missing: string[] = [];

for (const entry of BUNDLED_CONNECTORS) {
	const id = String(entry.id);
	const candidates = SLUGS[id] ?? [`simple-icons/${id}`];
	let glyph: Glyph | { dataUri: string } | undefined;
	for (const slug of candidates) {
		const svg = await fetchSvg(slug);
		if (!svg) continue;
		glyph = parseSvg(svg);
		if (glyph) break;
	}
	if (!glyph) {
		const vendor = VENDOR_ICONS[id];
		if (vendor) glyph = await fetchVendorIcon(vendor);
	}
	if (glyph) glyphs[id] = glyph;
	else missing.push(id);
	await Bun.sleep(250);
}

const body = Object.entries(glyphs)
	.sort(([a], [b]) => a.localeCompare(b))
	.map(([id, glyph]) => {
		if ("dataUri" in glyph) return `\t${JSON.stringify(id)}: { src: ${JSON.stringify(glyph.dataUri)} },`;
		const paths = glyph.paths
			.map(p => `{ d: ${JSON.stringify(p.d)}${p.fill ? `, fill: ${JSON.stringify(p.fill)}` : ""} }`)
			.join(", ");
		return `\t${JSON.stringify(id)}: { viewBox: ${JSON.stringify(glyph.viewBox)}, paths: [${paths}] },`;
	})
	.join("\n");

const module = `/**
 * Brand marks for the bundled connectors.
 *
 * Generated by \`scripts/generate-connector-brand-icons.ts\` from the
 * simple-icons and logos collections, and from the vendor's own icon where
 * neither carries one; do not edit by hand. The marks are committed rather
 * than fetched so that opening the Connectors page makes no request to a
 * vendor, and so the page renders the same offline.
 *
 * A connector absent here has no mark anywhere; its card shows the name's
 * first character instead.
 */

/**
 * One brand mark.
 *
 * A collection icon is a vector: a view box and one or more paths, where a
 * path without \`fill\` inherits the tile's text colour. A vendor icon that
 * exists only as a raster is kept as a data URI, so showing it still makes no
 * request.
 */
export type ConnectorBrandGlyph =
	| {
			readonly viewBox: string;
			readonly paths: ReadonlyArray<{ readonly d: string; readonly fill?: string }>;
	  }
	| { readonly src: string };

export const CONNECTOR_BRAND_GLYPHS: Readonly<Record<string, ConnectorBrandGlyph>> = {
${body}
};
`;

await writeFile(OUTPUT, module, "utf8");
console.log(`wrote ${Object.keys(glyphs).length} glyphs, ${missing.length} without a mark`);
if (missing.length > 0) console.log(`no mark: ${missing.join(", ")}`);
