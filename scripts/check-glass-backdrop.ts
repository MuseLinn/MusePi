/**
 * Guard the one cascade invariant a brace check cannot see: that the opaque
 * page backdrop actually wins.
 *
 * Why this exists: `[data-platform="win32"] body { background: var(--bg) }`
 * sat in the stylesheet for a full round-trip looking correct — it parses,
 * it balances, it reaches the bundle — and did nothing, because
 * `html:root body { background: transparent }` two rules earlier is (0,1,8)
 * and a lone attribute plus a type is (0,1,0). Source order was already
 * right, so nothing in the toolchain had a reason to complain. The page root
 * stayed transparent, every floating surface over the sidebar had no
 * in-window content for its backdrop-filter to sample, and the glass read as
 * a hole.
 *
 * Resolution is per platform *context*, not per selector: a rule with no
 * `data-platform` qualifies for every context, so the context is "every
 * declaration that can match here", compared by specificity then source
 * order. Bucketing by the platform written in the selector would let a
 * platform-scoped rule appear to win simply by being the only member of its
 * own bucket — which is exactly the mistake that made an earlier version of
 * this check pass on the broken stylesheet.
 *
 * It is deliberately not a CSS engine: it handles the selector shapes this
 * invariant needs (id, class, attribute, pseudo-class, type) and resolves
 * only the `background` property on the root/body.
 *
 *   bun scripts/check-glass-backdrop.ts
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const STYLESHEETS = ["packages/desktop-app/src/styles/gui-base.css"];
const PLATFORMS = ["win32", "linux"];

/** Specificity as [id, class-ish, type-ish], compared component-wise. */
export function specificity(selector: string): [number, number, number] {
	const s = selector.trim();
	const ids = s.match(/#[\w-]+/g) ?? [];
	const attrs = s.match(/\[[^\]]*\]/g) ?? [];
	const classes = s.match(/\.[\w-]+/g) ?? [];
	const pseudoClasses = s.match(/:(?!:)[a-zA-Z-]+(?:\([^)]*\))?/g) ?? [];
	const rest = s
		.replace(/#[\w-]+/g, " ")
		.replace(/\[[^\]]*\]/g, " ")
		.replace(/\.[\w-]+/g, " ")
		.replace(/::[a-zA-Z-]+(?:\([^)]*\))?/g, " ")
		.replace(/:(?!:)[a-zA-Z-]+(?:\([^)]*\))?/g, " ")
		.replace(/\b[0-9]+[%a-zA-Z]*\b/g, " ");
	return [
		ids.length,
		attrs.length + classes.length + pseudoClasses.length,
		(rest.match(/\b[a-zA-Z][\w-]*\b/g) ?? []).length,
	];
}

function compare(x: [number, number, number], y: [number, number, number]): number {
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
	return 0;
}

/** Does this selector ever target the document root or body? */
function targetsRoot(selector: string): boolean {
	const s = selector.trim();
	return /(^|[\s>+~])html\b/.test(s) || /^:root\b/.test(s) || /(^|[\s>+~])body\b/.test(s);
}

interface Declaration {
	selector: string;
	platform: string | null;
	specificity: [number, number, number];
	order: number;
	value: string;
	line: number;
}

function declarationsFor(source: string, property: string): Declaration[] {
	const out: Declaration[] = [];
	// blank out comments so their braces and text cannot be parsed as rules
	const clean = source.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));
	const rule = /([^{}]+)\{([^{}]*)\}/g;
	let order = 0;
	let m: RegExpExecArray | null = rule.exec(clean);
	while (m !== null) {
		const hit = m;
		m = rule.exec(clean);
		const body = hit[2] ?? "";
		const decl = body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "i"));
		if (!decl) continue;
		const line = clean.slice(0, hit.index).split("\n").length;
		for (const raw of (hit[1] ?? "").split(",")) {
			const selector = raw.trim();
			if (!selector || !targetsRoot(selector)) continue;
			out.push({
				selector,
				platform: /data-platform\s*=\s*["']?([\w-]+)/.exec(selector)?.[1] ?? null,
				specificity: specificity(selector),
				order: order++,
				value: (decl[1] ?? "").trim(),
				line,
			});
		}
	}
	return out;
}

/** The declaration that actually wins for `platform`, or null. */
export function resolveFor(decls: Declaration[], platform: string): Declaration | null {
	let best: Declaration | null = null;
	for (const d of decls) {
		if (d.platform !== null && d.platform !== platform) continue;
		if (!best) {
			best = d;
			continue;
		}
		const c = compare(d.specificity, best.specificity);
		if (c > 0 || (c === 0 && d.order > best.order)) best = d;
	}
	return best;
}

async function main(): Promise<number> {
	let failed = false;
	for (const rel of STYLESHEETS) {
		const source = await fs.readFile(path.resolve(process.cwd(), rel), "utf8");
		const decls = declarationsFor(source, "background");
		for (const platform of PLATFORMS) {
			const win = resolveFor(decls, platform);
			if (!win) continue;
			if (win.value === "transparent") {
				const beaten = decls.filter(d => d !== win && (d.platform === null || d.platform === platform));
				console.error(
					`${rel}:${win.line} — the ${platform} page backdrop resolves to transparent.\n` +
						`  winner: ${win.selector}  [${win.specificity.join(",")}]\n` +
						`  it lost to: ${beaten.map(d => `${d.selector} [${d.specificity.join(",")}]`).join("; ")}\n` +
						`  a transparent root leaves floating surfaces with no in-window content to sample.`,
				);
				failed = true;
			} else {
				console.log(`${rel}: ${platform} backdrop -> ${win.value}  (${win.selector})`);
			}
		}
	}
	if (failed) {
		console.error("glass-backdrop: FAIL — the opaque page backdrop is not winning the cascade");
		return 1;
	}
	console.log("glass-backdrop: OK — the opaque page backdrop wins on win32/linux");
	return 0;
}

process.exit(await main());
