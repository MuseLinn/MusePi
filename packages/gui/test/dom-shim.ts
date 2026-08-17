/** Minimal DOM shim for SSR component tests (mirrors
 *  desktop-web/test/transcript-dom-shim.ts): desktop-web's tool-render element
 *  extends HTMLElement at module load, and the GUI's Icon sprite injects an
 *  SVG into document.body. Import this FIRST in any test file that pulls
 *  @musepi/desktop-web or the GUI panel components. */

class TestHTMLElement {
	style: Record<string, string> = {};
}

const globals = globalThis as typeof globalThis & {
	HTMLElement?: typeof HTMLElement;
	document?: unknown;
};

globals.HTMLElement ??= TestHTMLElement as unknown as typeof HTMLElement;

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
