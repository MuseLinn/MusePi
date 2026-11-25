/**
 * A display formula as React nodes.
 *
 * KaTeX emits an HTML string, and the browser's own parser turns it into a tree
 * (`DOMParser`, which applies the spec's MathML foreign-content adjustments
 * KaTeX output relies on) — this module maps that tree onto React elements, the
 * same way the reference implementation does. The point is that the formula's
 * subtree, its scroll box and its copy control are React's:
 *
 * - a wide formula keeps its horizontal scroll across a re-render (measured
 *   before this: `scrollLeft` 17 → 0 whenever text arrived below it, because the
 *   whole message HTML was rewritten and the KaTeX subtree with it);
 * - the copy glyph morphs instead of being replaced mid-flight.
 *
 * KaTeX output is a static span/MathML/SVG vocabulary with no raw user HTML, so
 * mapping it onto elements is the same trust a highlighted code fence gets.
 */

import { Check, Copy } from "lucide";
import { MorphIcon } from "morphicons/react";
import { type CSSProperties, createElement, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { MarkdownBlockProps } from "../registry";

/** One `style` attribute → React's style object. KaTeX emits plain kebab-case
 *  declarations only, so camel-casing each property is the whole mapping. */
function styleObject(css: string): CSSProperties {
	const style: Record<string, string> = {};
	for (const declaration of css.split(";")) {
		const colon = declaration.indexOf(":");
		if (colon === -1) continue;
		const name = declaration.slice(0, colon).trim();
		if (name === "") continue;
		const key = name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
		style[key] = declaration.slice(colon + 1).trim();
	}
	return style;
}

/** Map one parsed node onto a React element (text nodes pass through). */
function nodeToReact(node: ChildNode, key: number): ReactNode {
	if (node.nodeType === Node.TEXT_NODE) return node.textContent;
	if (node.nodeType !== Node.ELEMENT_NODE) return null;
	const element = node as Element;
	const props: Record<string, unknown> = { key };
	for (const attribute of element.attributes) {
		if (attribute.name === "class") props.className = attribute.value;
		else if (attribute.name === "style") props.style = styleObject(attribute.value);
		else props[attribute.name] = attribute.value;
	}
	const children = Array.from(element.childNodes).map((child, index) => nodeToReact(child, index));
	return createElementFor(element.tagName, props, children);
}

function createElementFor(tag: string, props: Record<string, unknown>, children: ReactNode[]): ReactNode {
	return createElement(tag, props, ...children);
}

/**
 * KaTeX markup → React nodes, or `null` where the DOM parser is unavailable
 * (the server renderer and the test DOM): node identity is a browser concern,
 * and `DOMParser` does not exist off the page.
 */
export function katexMarkupToReact(html: string): ReactNode[] | null {
	if (typeof DOMParser === "undefined") return null;
	const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
	return Array.from(parsed.body.childNodes).map((child, index) => nodeToReact(child, index));
}

export interface MarkdownMathBlockProps extends MarkdownBlockProps {
	/** KaTeX-rendered markup for the formula. */
	rendered: string;
	/** The LaTeX source the copy control hands over. */
	latex: string;
}

export function MarkdownMathBlock(props: MarkdownBlockProps): ReactNode {
	// The registry hands every block the same props; a formula without its
	// markup has nothing to draw, and the guard lives outside the hook owner.
	if (props.rendered === undefined) return null;
	return <MathBlock {...props} rendered={props.rendered} latex={props.latex ?? ""} />;
}

function MathBlock({ rendered, latex, labels }: MarkdownBlockProps & { rendered: string; latex: string }): ReactNode {
	const [copied, setCopied] = useState(false);
	const timer = useRef<number | null>(null);
	// `null` off the browser: the markup is then injected as one blob, which is
	// what the server render needs (node identity only matters in a live page).
	const nodes = useMemo(() => katexMarkupToReact(rendered), [rendered]);

	useEffect(
		() => () => {
			if (timer.current !== null) window.clearTimeout(timer.current);
		},
		[],
	);

	const copy = (): void => {
		void navigator.clipboard.writeText(latex).then(() => {
			setCopied(true);
			if (timer.current !== null) window.clearTimeout(timer.current);
			timer.current = window.setTimeout(() => setCopied(false), 1400);
		});
	};

	return (
		<span className="tr-math">
			{nodes ?? <span dangerouslySetInnerHTML={{ __html: rendered }} />}
			<button
				type="button"
				className="tr-code-btn tr-math-copy"
				aria-label={copied ? labels.copied : labels.copy}
				title={copied ? labels.copied : labels.copy}
				onClick={copy}
			>
				<MorphIcon icon={copied ? Check : Copy} size={14} spring="snappy" />
			</button>
		</span>
	);
}
