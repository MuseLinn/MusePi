/**
 * A fenced code block as React nodes.
 *
 * Same reason as the table: the message's HTML is one string, so any block the
 * string rebuilds loses its DOM identity on every stream tick — and a code
 * block additionally re-runs tree-sitter highlighting, because the highlighted
 * markup is patched into a fresh element each time. Owning the block means the
 * highlight lands once per block and a finished block is never rebuilt.
 *
 * The header is the same three actions the string version drew (line numbers,
 * wrap, copy), now as state and `<MorphIcon>`: the copy glyph morphs to a check
 * instead of being swapped for a different element.
 */

import { AlignJustify, Check, Copy, ListOrdered, StretchHorizontal, WrapText } from "lucide";
import { MorphIcon } from "morphicons/react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { MarkdownBlockProps } from "../registry";

export interface MarkdownCodeBlockProps extends MarkdownBlockProps {
	/** Raw source, before any escaping or highlighting. */
	code: string;
	/** Fence info string (`ts`, `bash`…), already normalized. */
	lang: string;
	/** Human label for the header (`TypeScript`). */
	label: string;
	/** Highlighted `<code>` inner markup, once it is available. */
	highlighted?: string | null;
}

/** Per-line spans, so the appearance setting can number lines with CSS
 *  counters. Kept as an array: React children, not a concatenated string. */
function lines(source: string): string[] {
	return source.endsWith("\n") ? source.slice(0, -1).split("\n") : source.split("\n");
}

export function MarkdownCodeBlock(props: MarkdownBlockProps): ReactNode {
	// The registry hands every block the same props; a fence without its source
	// has nothing to draw, and the guard lives outside the hook owner.
	if (props.code === undefined) return null;
	return <CodeBlock {...props} code={props.code} />;
}

function CodeBlock({ code, lang, label, highlighted, labels }: MarkdownBlockProps & { code: string }): ReactNode {
	const globalLines = useMemo(
		() => typeof document !== "undefined" && document.documentElement.classList.contains("gui-code-lines"),
		[],
	);
	const [numbered, setNumbered] = useState(globalLines);
	const [wrapped, setWrapped] = useState(false);
	const [copied, setCopied] = useState(false);
	const timer = useRef<number | null>(null);

	useEffect(
		() => () => {
			if (timer.current !== null) window.clearTimeout(timer.current);
		},
		[],
	);

	const copy = (): void => {
		void navigator.clipboard.writeText(code).then(() => {
			setCopied(true);
			if (timer.current !== null) window.clearTimeout(timer.current);
			timer.current = window.setTimeout(() => setCopied(false), 1400);
		});
	};

	const className = ["tr-code", numbered ? "tr-code--lines" : "tr-code--no-lines", wrapped ? "tr-code--wrap" : ""]
		.filter(Boolean)
		.join(" ");

	return (
		<div className={className}>
			<div className="tr-code-head">
				<span className="tr-code-lang">{label}</span>
				<span className="tr-code-actions">
					<button
						type="button"
						className="tr-code-btn tr-code-lines"
						aria-pressed={numbered}
						aria-label={labels.lineNumbers}
						title={labels.lineNumbers}
						onClick={() => setNumbered(value => !value)}
					>
						<MorphIcon icon={numbered ? ListOrdered : AlignJustify} size={14} spring="snappy" />
					</button>
					<button
						type="button"
						className="tr-code-btn tr-code-wrap"
						aria-pressed={wrapped}
						aria-label={labels.wrapLines}
						title={labels.wrapLines}
						onClick={() => setWrapped(value => !value)}
					>
						<MorphIcon icon={wrapped ? WrapText : StretchHorizontal} size={14} spring="snappy" />
					</button>
					<button
						type="button"
						className="tr-code-btn tr-code-copy"
						aria-label={copied ? labels.copied : labels.copy}
						title={copied ? labels.copied : labels.copy}
						onClick={copy}
					>
						<MorphIcon icon={copied ? Check : Copy} size={14} spring="snappy" />
					</button>
				</span>
			</div>
			<pre>
				{/* Highlighted markup wins; until it arrives the block draws its own
				 * lines, so the box never shrinks between the two. */}
				{highlighted != null ? (
					<code
						className={lang ? `language-${lang}` : undefined}
						dangerouslySetInnerHTML={{ __html: highlighted }}
					/>
				) : (
					<code className={lang ? `language-${lang}` : undefined}>
						{lines(code).map((line, index) => (
							<span key={index} className="tr-code-line">
								{line}
							</span>
						))}
					</code>
				)}
			</pre>
		</div>
	);
}
