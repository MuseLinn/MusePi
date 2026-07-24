// MusePi render profile bench (C18): does frame cost scale with history?
//
// Builds a chat-like Container of N Markdown-bearing message components
// (the dominant per-message render cost) and times two consecutive
// renders with fingerprints (damage tracking) and without. The with/Out
// case re-renders every message every frame; the WITH case re-renders
// only components whose fingerprint changed (the streaming tail).
// Usage: node packages/coding-agent/scripts/bench-render.mjs
import { performance } from "node:perf_hooks";

const { Container, Markdown } = await import("@earendil-works/pi-tui");

// Minimal MarkdownTheme stub (style fns return plain text).
const mdTheme = {
	heading: (t) => t,
	link: (t) => t,
	linkUrl: (t) => t,
	code: (t) => t,
	codeBlock: (t) => t,
	codeBlockBorder: (t) => t,
	quote: (t) => t,
	quoteBorder: (t) => t,
	hr: (t) => t,
	listBullet: (t) => t,
	bold: (t) => t,
	italic: (t) => t,
	strikethrough: (t) => t,
	underline: (t) => t,
	highlightCode: (text) => [text],
};

const SAMPLE = `## Analysis

The renderer diffs frames line-by-line and only writes the changed
rows. With *damage tracking*, settled components are never re-rendered:

- virtual line buffer
- fingerprint-gated cache
- \`render(width): string[]\`

> Frames after the first one cost zero writes when nothing changed.

\`\`\`ts
const fp = component.fingerprint?.();
if (fp === cached.fp) return cached.lines;
\`\`\`
`;

function makeMessageComponent(i, withFingerprint) {
	const md = new Markdown(`Message ${i}\n\n${SAMPLE}`, 1, 0, mdTheme);
	const comp = {
		render: (w) => md.render(w),
		invalidate() {},
	};
	if (withFingerprint) comp.fingerprint = () => `m${i}`;
	return comp;
}

const ITERS = 50;
function bench(n, withFingerprint) {
	const c = new Container();
	const tail = makeMessageComponent("streaming", withFingerprint);
	for (let i = 0; i < n; i++) c.addChild(makeMessageComponent(i, withFingerprint));
	c.addChild(tail);
	// warmup (fills the damage cache + JIT)
	for (let k = 0; k < 3; k++) c.render(100);
	// changed frame: tail fingerprint flips — only it should re-render
	let fp2 = "stream-1";
	if (withFingerprint) tail.fingerprint = () => fp2;
	let changed = 0;
	for (let k = 0; k < ITERS; k++) {
		if (withFingerprint) tail.fingerprint = () => `stream-${k}`;
		const t0 = performance.now();
		c.render(100);
		changed += performance.now() - t0;
	}
	// settled frames: nothing changes
	let settled = 0;
	for (let k = 0; k < ITERS; k++) {
		const t1 = performance.now();
		c.render(100);
		settled += performance.now() - t1;
	}
	return { n, withFingerprint, changedFrameMs: changed / ITERS, settledFrameMs: settled / ITERS };
}

const rows = [];
for (const n of [100, 500, 1000, 2000]) {
	rows.push(bench(n, false));
	rows.push(bench(n, true));
}

console.log("| history | damage tracking | changed frame | settled frame |");
console.log("|---|---|---|---|");
for (const r of rows) {
	console.log(
		`| ${r.n} messages | ${r.withFingerprint ? "on" : "off"} | ${r.changedFrameMs.toFixed(2)} ms | ${r.settledFrameMs.toFixed(2)} ms |`,
	);
}
