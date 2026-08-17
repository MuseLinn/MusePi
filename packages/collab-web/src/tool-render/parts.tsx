/**
 * Shared UI primitives for tool renderers. Every renderer composes these
 * instead of inventing new CSS — see tool-render.css for the `tv-` classes.
 */
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n/index.js";
import { highlightToCodeHtml } from "../components/transcript/highlight.js";
import { escapeHtml } from "../components/transcript/highlight.js";
import { useCodeHighlight } from "../components/transcript/highlight-context.js";
import { diffWords } from "./diff-words.js";
import { diffLayoutPref } from "./parts-shared";
import type { ToolRenderHost, ToolResultImage, ToolResultLike } from "./types";
import { getHljs, replaceTabs, resultImagesOf, resultTextOf, shortenPath, stripAnsi } from "./util";

export type Tone = "accent" | "ok" | "err" | "warn";

/** Inline chip. Renders nothing for empty content. */
export function Badge({ children, tone }: { children: ReactNode; tone?: Tone }): ReactNode {
	if (children == null || children === "" || children === false) return null;
	return <span className={`tv-badge${tone ? ` tv-badge--${tone}` : ""}`}>{children}</span>;
}

/** Chip row; falsy items are skipped. Usable inline (summaries) and in bodies. */
export function Badges({ items }: { items: ReadonlyArray<ReactNode> }): ReactNode {
	const visible = items.filter(item => item != null && item !== "" && item !== false);
	if (visible.length === 0) return null;
	return (
		<span className="tv-badges">
			{visible.map((item, i) => (
				<Badge key={i}>{item}</Badge>
			))}
		</span>
	);
}

/** File path with optional `:start-end` line range or raw selector suffix. */
export function PathText({
	path,
	from,
	to,
	sel,
}: {
	path: string;
	from?: number | null;
	to?: number | null;
	sel?: string | null;
}): ReactNode {
	let range = "";
	if (from != null || to != null) {
		const start = from ?? 1;
		range = to != null ? `:${start}-${to}` : `:${start}`;
	}
	return (
		<span className="tv-path">
			{shortenPath(path)}
			{range && <span className="tv-lines">{range}</span>}
			{sel && <span className="tv-lines">:{sel}</span>}
		</span>
	);
}

/** Key/value grid. */
export function KvGrid({ children }: { children: ReactNode }): ReactNode {
	return <div className="tv-kv">{children}</div>;
}

export function Kv({ k, children }: { k: ReactNode; children: ReactNode }): ReactNode {
	if (children == null || children === "" || children === false) return null;
	return (
		<>
			<span className="tv-kv-key">{k}</span>
			<span className="tv-kv-val">{children}</span>
		</>
	);
}

function useHighlight(code: string, lang: string | null | undefined): string | null {
	return useMemo(() => {
		if (!lang) return null;
		const hljs = getHljs();
		if (!hljs) return null;
		try {
			if (!hljs.getLanguage(lang)) return null;
			return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
		} catch {
			return null;
		}
	}, [code, lang]);
}

export interface OutputProps {
	text: string;
	/** Lines shown before collapsing behind a "more" affordance. */
	maxLines?: number;
	/** highlight.js language (only applied when the host exposes hljs). */
	lang?: string | null;
	/** Render in error color. */
	error?: boolean;
	/** "code": horizontal scroll, inset bg. "plain": soft-wrapped. */
	variant?: "code" | "plain";
	/** Uppercase mini-title above the block. */
	title?: string;
	/** Drop the inset background (inline in flow). */
	bare?: boolean;
}

/**
 * Expandable text block — the workhorse for command output, file previews,
 * search results. Tabs are widened, ANSI escapes stripped.
 */
export function Output({ text, maxLines = 10, lang, error, variant = "plain", title, bare }: OutputProps): ReactNode {
	const [expanded, setExpanded] = useState(false);
	const clean = useMemo(() => replaceTabs(stripAnsi(text)).replace(/\n+$/, ""), [text]);
	const lines = useMemo(() => clean.split("\n"), [clean]);
	const collapsible = lines.length > maxLines + 1;
	const shown = collapsible && !expanded ? lines.slice(0, maxLines).join("\n") : clean;
	const html = useHighlight(shown, error ? null : lang);
	const classes = ["tv-pre"];
	if (variant === "plain") classes.push("tv-pre--wrap");
	if (error) classes.push("tv-pre--error");
	if (bare) classes.push("tv-pre--bare");
	return (
		<div className="tv-out">
			{title && <div className="tv-out-title">{title}</div>}
			{html !== null ? (
				<pre className={classes.join(" ")} dangerouslySetInnerHTML={{ __html: html }} />
			) : (
				<pre className={classes.join(" ")}>{shown}</pre>
			)}
			{collapsible && (
				<button type="button" className="tv-expand" onClick={() => setExpanded(v => !v)}>
					{expanded ? t("collapse") : t("⋯ {count} more lines", { count: String(lines.length - maxLines) })}
				</button>
			)}
		</div>
	);
}

/** Source-code block: inset background, no soft wrap, optional title chip. */
export function CodeBlock({
	code,
	lang,
	title,
	maxLines = 14,
}: {
	code: string;
	lang?: string | null;
	title?: string;
	maxLines?: number;
}): ReactNode {
	if (!code) return null;
	return <Output text={code} lang={lang} maxLines={maxLines} variant="code" title={title} />;
}

/**
 * Result text of a tool result, styled for success or error automatically.
 * Renders nothing when the result is absent or has no text.
 */
export function ResultText({
	result,
	maxLines = 10,
	lang,
	variant,
	title,
}: {
	result: ToolResultLike | undefined;
	maxLines?: number;
	lang?: string | null;
	variant?: "code" | "plain";
	title?: string;
}): ReactNode {
	const text = resultTextOf(result).trim();
	if (!text) return null;
	return (
		<Output
			text={text}
			maxLines={maxLines}
			lang={result?.isError ? null : lang}
			error={result?.isError === true}
			variant={variant ?? (lang ? "code" : "plain")}
			title={title}
		/>
	);
}

function openImage(img: ToolResultImage): void {
	try {
		const bin = atob(img.data);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		const url = URL.createObjectURL(new Blob([bytes], { type: img.mimeType }));
		window.open(url, "_blank", "noopener");
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
	} catch {
		// undecodable image data — the broken thumbnail already conveys it
	}
}

/** Thumbnails for every image block in a result; click opens full size. */
export function ResultImages({ result }: { result: ToolResultLike | undefined }): ReactNode {
	const images = resultImagesOf(result);
	if (images.length === 0) return null;
	return (
		<div className="tv-imgs">
			{images.map((img, i) => (
				<button
					key={i}
					type="button"
					style={{ all: "unset", display: "inline-flex" }}
					onClick={() => openImage(img)}
					aria-label={t("Open tool result image {count}", { count: String(i + 1) })}
				>
					<img
						className="tv-img"
						src={`data:${img.mimeType};base64,${img.data}`}
						alt={t("tool result {count}", { count: String(i + 1) })}
					/>
				</button>
			))}
		</div>
	);
}

/** Callout block. */
export function Note({ tone, children }: { tone?: "err" | "warn" | "ok"; children: ReactNode }): ReactNode {
	if (children == null || children === "" || children === false) return null;
	return <div className={`tv-note${tone ? ` tv-note--${tone}` : ""}`}>{children}</div>;
}

/** Labeled row inside a `.tv-list`. */
export function Row({ k, children }: { k?: ReactNode; children: ReactNode }): ReactNode {
	return (
		<div className="tv-row">
			{k != null && k !== "" && <span className="tv-row-key">{k}</span>}
			<span className="tv-row-val">{children}</span>
		</div>
	);
}

/** Marker for arguments that arrived with the wrong JSON type. */
export function InvalidArg({ what }: { what?: string }): ReactNode {
	return <span className="tv-err-text">{t("[invalid {value}]", { value: what ?? "arg" })}</span>;
}

/**
 * Unified-diff rendering with the chat-settings layouts (openchamber
 * diffLayout parity): inline (single column, `+`/`-`/`@@` rows), or
 * side-by-side (removed left, added right, aligned per hunk). `dynamic`
 * picks side-by-side when the block is wide enough and inline otherwise.
 */
export type DiffLayout = "dynamic" | "inline" | "side-by-side";

/** Width threshold (px) for the dynamic layout to go side-by-side. */
const SBS_MIN_WIDTH = 720;

interface SideRow {
	kind: "ctx" | "add" | "del" | "hunk" | "header" | "gap";
	left: string | null;
	right: string | null;
	/** hunk start line numbers: old (left) / new (right), 1-based; ctx rows
	 *  carry the running number of the side they appear on. */
	oldNo: number | null;
	newNo: number | null;
}

/** Pair a unified-diff line list into aligned left/right rows. */
const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function pairDiffRows(lines: string[]): SideRow[] {
	const out: SideRow[] = [];
	let del: string[] = [];
	let add: string[] = [];
	// Running file line numbers from the last hunk header (null until one
	// is seen — headers/hunks carry no numbers).
	let oldLine = 0;
	let newLine = 0;
	const flush = (): void => {
		const n = Math.max(del.length, add.length);
		for (let i = 0; i < n; i++) {
			const d = del[i];
			const a = add[i];
			out.push({
				kind: d !== undefined ? "del" : "add",
				left: d ?? null,
				right: a ?? null,
				oldNo: d !== undefined ? oldLine++ : null,
				newNo: a !== undefined ? newLine++ : null,
			});
		}
		del = [];
		add = [];
	};
	for (const line of lines) {
		// A truly empty line is a block separator; a git context blank line
		// is " " (leading space) and must stay a ctx row — trimming would
		// misclassify it as a gap and render "…" in both panes.
		if (line.length === 0) {
			flush();
			out.push({ kind: "gap", left: null, right: null, oldNo: null, newNo: null });
			continue;
		}
		const hunk = HUNK_RE.exec(line);
		if (hunk) {
			flush();
			oldLine = Number(hunk[1]);
			newLine = Number(hunk[2]);
			out.push({ kind: "hunk", left: line, right: null, oldNo: null, newNo: null });
			continue;
		}
		if (line.startsWith("---") || line.startsWith("+++")) {
			flush();
			out.push({ kind: "header", left: line, right: null, oldNo: null, newNo: null });
			continue;
		}
		if (line.startsWith("-")) {
			del.push(line);
			continue;
		}
		if (line.startsWith("+")) {
			add.push(line);
			continue;
		}
		flush();
		out.push({
			kind: "ctx",
			left: line,
			right: line,
			// Context rows advance both files.
			oldNo: oldLine > 0 ? oldLine++ : null,
			newNo: newLine > 0 ? newLine++ : null,
		});
	}
	flush();
	return out;
}

function SideBySideDiff({
	rows,
	hlLeft,
	hlRight,
}: {
	rows: string[];
	hlLeft: string[] | null;
	hlRight: string[] | null;
}): ReactNode {
	const paired = useMemo(() => pairDiffRows(rows), [rows]);
	const cells = useMemo(() => {
		let li = 0;
		let ri = 0;
		const cell = (text: string | null, html: string | null): ReactNode =>
			html !== null && html.length > 0 ? (
				// biome-ignore lint/security/noDangerouslySetInnerHtml: escaped spans built by highlightToCodeHtml
				<span className="tv-diff-sbs-cell tv-diff-hl" dangerouslySetInnerHTML={{ __html: html }} />
			) : (
				<span className="tv-diff-sbs-cell">{text ?? ""}</span>
			);
		/**
		 * Paired del+add rows (a same-line replacement): render a word-level
		 * diff of the old vs new content so the changed tokens get their own
		 * mark (TUI renderDiff parity) instead of the whole lines looking
		 * like independent delete/add. The left pane shows removed runs, the
		 * right pane added runs; equal runs render plain in both.
		 */
		const wordCell = (oldText: string, newText: string, side: "left" | "right"): ReactNode => {
			const html = diffWords(oldText, newText)
				.map(part => {
					if ((side === "left" && part.added) || (side === "right" && part.removed)) {
						// Each pane renders only its own side of the change
						// (TUI renderIntraLineDiff parity): the left pane shows
						// removed + equal, the right pane added + equal.
						return "";
					}
					const cls =
						side === "left" && part.removed
							? "tv-diff-word tv-diff-word--del"
							: side === "right" && part.added
								? "tv-diff-word tv-diff-word--add"
								: null;
					const v = escapeHtml(part.value);
					return cls ? `<span class="${cls}">${v}</span>` : v;
				})
				.join("");
			return (
				// biome-ignore lint/security/noDangerouslySetInnerHtml: escaped by escapeHtml
				<span className="tv-diff-sbs-cell tv-diff-hl" dangerouslySetInnerHTML={{ __html: html }} />
			);
		};
		return paired.map(row => {
			if (row.kind === "hunk" || row.kind === "header" || row.kind === "gap") {
				return {
					cls: `tv-diff-sbs-row tv-diff-sbs-row--${row.kind}`,
					left: (
						<span className="tv-diff-sbs-cell">
							<span className="tv-diff-ln" />
							{row.left ?? "…"}
						</span>
					),
					right: null,
				};
			}
			const leftHtml = hlLeft && row.left !== null ? hlLeft[li] : null;
			if (row.left !== null) li++;
			const rightHtml = hlRight && row.right !== null ? hlRight[ri] : null;
			if (row.right !== null) ri++;
			// A same-line replacement (del + add paired): word-diff both panes
			// and tint the right pane as an addition too.
			const pairedRow = row.kind === "del" && row.right !== null;
			const leftCls = `tv-diff-sbs-cell${row.kind === "del" ? " tv-diff-sbs-cell--del" : ""}`;
			const rightCls = `tv-diff-sbs-cell${
				pairedRow || row.kind === "add" ? " tv-diff-sbs-cell--add" : ""
			}`;
			return {
				cls: `tv-diff-sbs-row tv-diff-sbs-row--${row.kind}`,
				left: pairedRow ? (
					<span className={leftCls}>
						<span className="tv-diff-ln">{row.oldNo ?? ""}</span>
						{wordCell(row.left!, row.right!, "left")}
					</span>
				) : (
					<span className={leftCls}>
						<span className="tv-diff-ln">{row.oldNo ?? ""}</span>
						{cell(row.left, leftHtml)}
					</span>
				),
				right: pairedRow ? (
					<span className={rightCls}>
						<span className="tv-diff-ln">{row.newNo ?? ""}</span>
						{wordCell(row.left!, row.right!, "right")}
					</span>
				) : (
					<span className={rightCls}>
						<span className="tv-diff-ln">{row.newNo ?? ""}</span>
						{cell(row.right, rightHtml)}
					</span>
				),
			};
		});
	}, [paired, hlLeft, hlRight]);
	return (
		<div className="tv-diff tv-diff--sbs">
			{cells.map((row, i) => (
				<div key={i} className={row.cls}>
					{row.left}
					{row.right}
				</div>
			))}
		</div>
	);
}

/** Extension → tree-sitter/native highlight language id (matches the TUI
 *  highlighter: "typescript", "rust", …). Unknown extensions yield null. */
const EXT_HIGHLIGHT_LANG: Record<string, string> = {
	ts: "typescript",
	mts: "typescript",
	cts: "typescript",
	tsx: "tsx",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	jsx: "javascript",
	rs: "rust",
	go: "go",
	c: "c",
	h: "c",
	cpp: "cpp",
	cc: "cpp",
	cxx: "cpp",
	hpp: "cpp",
	hh: "cpp",
	py: "python",
	pyi: "python",
	rb: "ruby",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	json: "json",
	html: "html",
	htm: "html",
	css: "css",
	scss: "scss",
	md: "markdown",
	markdown: "markdown",
	yaml: "yaml",
	yml: "yaml",
	toml: "toml",
	sql: "sql",
	java: "java",
	kt: "kotlin",
	kts: "kotlin",
	swift: "swift",
	php: "php",
	lua: "lua",
	zig: "zig",
	vue: "vue",
	svelte: "svelte",
	xml: "xml",
	svg: "xml",
	graphql: "graphql",
	gql: "graphql",
	dart: "dart",
	scala: "scala",
	cs: "csharp",
	r: "r",
	ex: "elixir",
	exs: "elixir",
	erl: "erlang",
	hs: "haskell",
	clj: "clojure",
	proto: "protobuf",
	sol: "solidity",
};

const DIFF_HEADER_RE = /^(?:---|\+\+\+) (?:a\/|b\/)?(.+)$/;

/** Language id for a unified diff, inferred from its `---`/`+++` file headers. */
function diffLangOf(diff: string): string | null {
	for (const rawLine of diff.split("\n")) {
		const m = DIFF_HEADER_RE.exec(rawLine.trim());
		if (!m) continue;
		const name = m[1].trim().split(/[\\/]/).pop() ?? "";
		const dot = name.lastIndexOf(".");
		if (dot <= 0) continue; // no extension — try the next header
		const lang = EXT_HIGHLIGHT_LANG[name.slice(dot + 1).toLowerCase()];
		if (lang) return lang;
	}
	return null;
}

/** Code content of a unified-diff row (strip the +/−/space prefix); rows that
 *  carry no code (hunk/header) contribute an empty line to keep alignment. */
function diffRowCode(row: string): string {
	if (row.startsWith("--- ") || row.startsWith("+++ ")) return "";
	const c = row.charAt(0);
	if (c === "+" || c === "-" || c === " ") return row.slice(1);
	return "";
}

/**
 * Per-line highlighted HTML for a diff (escaped spans, `.tr-code-line` shape)
 * plus the side-by-side column arrays. All null when no highlighter is
 * mounted (plain browser) or no language could be inferred.
 */
interface DiffHighlight {
	inline: string[] | null;
	left: string[] | null;
	right: string[] | null;
}

function InlineDiff({ rows, hlLines }: { rows: string[]; hlLines: string[] | null }): ReactNode {
	// Line numbers per input row: walk the raw lines with the same hunk
	// cursor rules as pairDiffRows (ctx advances both, del the old, add the
	// new) so the inline column shows the same numbers as side-by-side.
	const numbers = useMemo(() => {
		const out: Array<{ oldNo: number | null; newNo: number | null }> = [];
		let oldLine = 0;
		let newLine = 0;
		for (const line of rows) {
			const hunk = HUNK_RE.exec(line);
			if (hunk) {
				oldLine = Number(hunk[1]);
				newLine = Number(hunk[2]);
				out.push({ oldNo: null, newNo: null });
			} else if (line.startsWith("--- ") || line.startsWith("+++ ") || line.length === 0) {
				out.push({ oldNo: null, newNo: null });
			} else if (line.startsWith("-")) {
				out.push({ oldNo: oldLine > 0 ? oldLine++ : null, newNo: null });
			} else if (line.startsWith("+")) {
				out.push({ oldNo: null, newNo: newLine > 0 ? newLine++ : null });
			} else if (line.startsWith(" ")) {
				out.push({
					oldNo: oldLine > 0 ? oldLine++ : null,
					newNo: newLine > 0 ? newLine++ : null,
				});
			} else {
				out.push({ oldNo: null, newNo: null });
			}
		}
		return out;
	}, [rows]);
	// Indices of 1:1 paired removed+added rows — TUI renderIntraLineDiff
	// parity: a run of consecutive `-` lines followed by consecutive `+`
	// lines gets word-level marks only when both runs are exactly one line
	// (removedLines.length === 1 && addedLines.length === 1). Multi-line
	// blocks keep whole-row tint.
	const pairs = useMemo(() => {
		const set = new Set<number>();
		let i = 0;
		while (i < rows.length) {
			if (!rows[i]!.startsWith("-") || rows[i]!.startsWith("--- ")) {
				i++;
				continue;
			}
			let j = i;
			while (j < rows.length && rows[j]!.startsWith("-") && !rows[j]!.startsWith("--- ")) j++;
			let k = j;
			while (k < rows.length && rows[k]!.startsWith("+") && !rows[k]!.startsWith("+++ ")) k++;
			if (j - i === 1 && k - j === 1) set.add(i);
			i = k;
		}
		return set;
	}, [rows]);
	const wordHtml = (oldLine: string, newLine: string, side: "del" | "add"): string =>
		diffWords(oldLine.slice(1), newLine.slice(1))
			.map(part => {
				if ((side === "del" && part.added) || (side === "add" && part.removed)) return "";
				const cls =
					side === "del" && part.removed
						? "tv-diff-word tv-diff-word--del"
						: side === "add" && part.added
							? "tv-diff-word tv-diff-word--add"
							: null;
				const v = escapeHtml(part.value);
				return cls ? `<span class="${cls}">${v}</span>` : v;
			})
			.join("");
	return (
		<div className="tv-diff">
			{rows.map((line, i) => {
				let cls = "";
				// `--- a/x` / `+++ b/x` file headers (trailing space separates
				// them from deletion lines) render dim, not as del/add rows.
				const isHeader = line.startsWith("--- ") || line.startsWith("+++ ");
				const isCode = !isHeader && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "));
				if (line.length === 0) cls = "--gap";
				else if (isHeader) cls = "--header";
				else if (line.startsWith("+")) cls = "--add";
				else if (line.startsWith("-")) cls = "--del";
				else if (line.startsWith("@@")) cls = "--hunk";
				const pairedDel = pairs.has(i) ? rows[i + 1]! : null;
				const pairedAdd = i > 0 && pairs.has(i - 1) ? rows[i - 1]! : null;
				const html =
					pairedDel !== null
						? wordHtml(line, pairedDel, "del")
						: pairedAdd !== null
							? wordHtml(pairedAdd, line, "add")
							: hlLines && isCode
								? hlLines[i]
								: null;
				const ln = numbers[i]?.oldNo ?? numbers[i]?.newNo ?? "";
				return (
					<div key={i} className={`tv-diff-row${cls ? ` tv-diff-row${cls}` : ""}`}>
						<span className="tv-diff-ln">{line.length === 0 ? "" : ln}</span>
						{line.length === 0 ? (
							"…"
						) : html !== null ? (
							<>
								{(cls === "--add" || cls === "--del") && (
									<span className="tv-diff-sig">{line.charAt(0)}</span>
								)}
								{/* biome-ignore lint/security/noDangerouslySetInnerHtml: escaped spans (escapeHtml / highlightToCodeHtml) */}
								<span className="tv-diff-hl" dangerouslySetInnerHTML={{ __html: html || "\u00A0" }} />
							</>
						) : (
							line
						)}
					</div>
				);
			})}
		</div>
	);
}

export function DiffBlock({
	diff,
	maxLines = 80,
	layout,
}: {
	diff: string;
	maxLines?: number;
	/** Explicit layout override (settings preview); unset reads the pref. */
	layout?: DiffLayout;
}): ReactNode {
	const [expanded, setExpanded] = useState(false);
	const rootRef = useRef<HTMLDivElement | null>(null);
	const pref = layout ?? diffLayoutPref();
	const [wide, setWide] = useState(true);
	useEffect(() => {
		if (pref !== "dynamic") return;
		const el = rootRef.current;
		if (!el) return;
		const ro = new ResizeObserver(() => setWide(el.clientWidth >= SBS_MIN_WIDTH));
		ro.observe(el);
		setWide(el.clientWidth >= SBS_MIN_WIDTH);
		return () => ro.disconnect();
	}, [pref]);
	const sideBySide = pref === "side-by-side" || (pref === "dynamic" && wide);
	const lines = useMemo(() => replaceTabs(stripAnsi(diff)).replace(/\n+$/, "").split("\n"), [diff]);
	// Syntax highlighting — same pipeline as Markdown code blocks (desktop:
	// Electron IPC → tree-sitter natives; browser: no provider → plain text).
	const highlight = useCodeHighlight();
	const lang = useMemo(() => diffLangOf(diff), [diff]);
	const [hl, setHl] = useState<DiffHighlight | null>(null);
	useEffect(() => {
		if (!highlight || !lang) {
			setHl(null);
			return;
		}
		let alive = true;
		const full = replaceTabs(stripAnsi(diff)).replace(/\n+$/, "").split("\n");
		const inlineCodes = full.map(diffRowCode);
		const paired = pairDiffRows(full);
		const leftRows: string[] = [];
		const rightRows: string[] = [];
		for (const row of paired) {
			// Header/hunk rows produce an empty code (diffRowCode strips the
			// prefix only from +/-/space lines) AND consume no li/ri counter
			// in SideBySideDiff — skipping them keeps the highlight arrays
			// index-aligned with those counters. A ctx blank line (" ") also
			// yields "" but DOES consume a counter, so it must stay in the
			// array (the empty highlight renders via the cell fallback).
			if (row.left !== null && row.kind !== "header" && row.kind !== "hunk") {
				leftRows.push(diffRowCode(row.left));
			}
			if (row.right !== null && row.kind !== "header" && row.kind !== "hunk") {
				rightRows.push(diffRowCode(row.right));
			}
		}
		void (async () => {
			const [inlineOut, leftOut, rightOut] = await Promise.all([
				highlight(inlineCodes.join("\n"), lang),
				leftRows.length > 0 ? highlight(leftRows.join("\n"), lang) : null,
				rightRows.length > 0 ? highlight(rightRows.join("\n"), lang) : null,
			]);
			if (!alive) return;
			const toLines = (out: string | null): string[] | null =>
				out == null ? null : highlightToCodeHtml(out).split("\n").slice(0, -1); // drop trailing newline slot
			setHl({ inline: toLines(inlineOut), left: toLines(leftOut), right: toLines(rightOut) });
		})();
		return () => {
			alive = false;
		};
	}, [diff, lang, highlight]);
	const collapsible = lines.length > maxLines + 1;
	const shown = collapsible && !expanded ? lines.slice(0, maxLines) : lines;
	return (
		<div className="tv-out" ref={rootRef}>
			{sideBySide ? (
				<SideBySideDiff rows={shown} hlLeft={hl?.left ?? null} hlRight={hl?.right ?? null} />
			) : (
				<InlineDiff rows={shown} hlLines={hl?.inline ?? null} />
			)}
			{collapsible && (
				<button type="button" className="tv-expand" onClick={() => setExpanded(v => !v)}>
					{expanded ? t("collapse") : t("⋯ {count} more lines", { count: String(lines.length - maxLines) })}
				</button>
			)}
		</div>
	);
}

/**
 * Agent id chip. Becomes a drill-down button when the host can open that
 * agent's sub-session; otherwise renders as a plain accent badge.
 */
export function AgentLink({
	id,
	host,
	children,
}: {
	id: string;
	host?: ToolRenderHost;
	children?: ReactNode;
}): ReactNode {
	const clickable = host?.openAgent !== undefined && (host.hasAgent === undefined || host.hasAgent(id));
	if (!clickable) return <Badge tone="accent">{children ?? id}</Badge>;
	return (
		<button type="button" className="tv-badge tv-badge--accent tv-agent-link" onClick={() => host.openAgent?.(id)}>
			{children ?? id}
			<span className="tv-agent-link-arrow" aria-hidden="true">
				{" ↗"}
			</span>
		</button>
	);
}
