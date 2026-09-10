/** Minimal DOM shim for SSR component tests (mirrors
 *  guest-client/test/transcript-dom-shim.ts): guest-client's tool-render element
 *  extends HTMLElement at module load, and the GUI's Icon sprite injects an
 *  SVG into document.body. Import this FIRST in any test file that pulls
 *  @musepi/guest-client or the GUI panel components. */

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
	const fakeElement = () => ({
		nodeType: 1,
		style: {},
		setAttribute() {},
		removeAttribute() {},
		appendChild() {},
		removeChild() {},
		children: [],
		innerHTML: "",
	});
	globals.document = {
		body: {
			nodeType: 1,
			nodeName: "BODY",
			ownerDocument: null,
			firstChild: null,
			insertBefore() {},
		},
		addEventListener() {},
		removeEventListener() {},
		activeElement: null,
		querySelector() {
			return null;
		},
		getElementById() {
			return null;
		},
		createElement: () => fakeElement(),
		createElementNS: () => fakeElement(),
	} as unknown as Document;
}
