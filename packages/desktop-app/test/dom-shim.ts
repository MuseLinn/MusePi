/**
 * Minimal DOM shim for SSR component tests (mirrors
 * guest-client/test/transcript-dom-shim.ts): guest-client's tool-render element
 * extends HTMLElement at module load, and the GUI's Icon sprite injects an
 * SVG into document.body. Import this FIRST in any test file that pulls
 * @musepi/guest-client or the GUI panel components.
 *
 * The element/document surface is deliberately broader than those two needs.
 * CSS-in-JS libraries decide "browser or server?" from `typeof document`, so
 * the moment this shim installs one, any later import of @emotion/css (reached
 * transitively via @lobehub/icons) takes the browser path and touches
 * `querySelectorAll`, `head`, `createElement`, `createTextNode` and
 * `styleSheets`. Omitting them does not fail here — it fails asynchronously
 * from a module-evaluation continuation, surfacing as an unattributed
 * "Unhandled error between tests" for whichever file happened to be running.
 */

class TestHTMLElement {
	style: Record<string, string> = {};
}

const globals = globalThis as typeof globalThis & {
	HTMLElement?: typeof HTMLElement;
	document?: unknown;
};
// The DOM lib types `customElements` as a real CustomElementRegistry; this
// stub deliberately is not one, so widen once through a named alias.
const globalRegistry = globalThis as unknown as { customElements?: unknown };

globals.HTMLElement ??= TestHTMLElement as unknown as typeof HTMLElement;
// @pierre/diffs registers a `diffs-container` custom element at module load;
// any test pulling the transcript/tool-render graph needs the registry to exist.
globalRegistry.customElements ??= {
	get: () => undefined,
	define: () => {},
};

if (typeof globals.document === "undefined") {
	/** Text node — `createTextNode` is how CSS-in-JS seeds a <style> element. */
	const fakeTextNode = () => ({
		nodeType: 3,
		textContent: "",
		parentNode: null as unknown,
	});
	/**
	 * Element stub. `getAttribute`/`textContent`/`parentNode`/`firstChild`/
	 * `nextSibling`/`sheet` exist because style-sheet insertion reads them back
	 * to decide where a tag goes; a set-only stub throws on the read.
	 */
	const fakeElement = () => {
		const el: Record<string, unknown> = {
			nodeType: 1,
			style: {},
			children: [] as unknown[],
			innerHTML: "",
			textContent: "",
			parentNode: null,
			// Queried on ELEMENTS too, not just document: @ant-design/cssinjs
			// scans `document.body.querySelectorAll(...)` at module load.
			querySelector: () => null,
			querySelectorAll: () => [] as unknown[],
			nextSibling: null,
			// StyleSheet checks `tag.sheet` first and falls back to scanning
			// document.styleSheets; leaving both empty is a valid no-op.
			sheet: undefined,
			ownerNode: undefined,
			attributes: {} as Record<string, string>,
		};
		el.setAttribute = (name: string, value: unknown): void => {
			(el.attributes as Record<string, string>)[name] = String(value);
		};
		el.getAttribute = (name: string): string | null => (el.attributes as Record<string, string>)[name] ?? null;
		el.removeAttribute = (name: string): void => {
			delete (el.attributes as Record<string, string>)[name];
		};
		el.appendChild = (child: unknown): unknown => {
			(el.children as unknown[]).push(child);
			return child;
		};
		el.insertBefore = (child: unknown): unknown => {
			(el.children as unknown[]).unshift(child);
			return child;
		};
		el.removeChild = (child: unknown): unknown => {
			const list = el.children as unknown[];
			const i = list.indexOf(child);
			if (i >= 0) list.splice(i, 1);
			return child;
		};
		return el;
	};
	globals.document = {
		// A real element stub, not a bare object: libraries query it
		// (`document.body.querySelectorAll(...)`), so it needs the same surface
		// the rest of the shim's elements carry.
		body: { ...fakeElement(), nodeName: "BODY", ownerDocument: null },
		head: fakeElement(),
		// Present-but-empty: the browser-detection probes only check existence.
		styleSheets: [] as unknown[],
		documentElement: fakeElement(),
		addEventListener() {},
		removeEventListener() {},
		activeElement: null,
		querySelector() {
			return null;
		},
		querySelectorAll() {
			return [] as unknown[];
		},
		getElementById() {
			return null;
		},
		createElement: () => fakeElement(),
		createElementNS: () => fakeElement(),
		createTextNode: () => fakeTextNode(),
	} as unknown as Document;
}
