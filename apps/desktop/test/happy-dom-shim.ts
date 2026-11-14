/**
 * happy-dom bootstrap — MUST be imported before any component module in a
 * test file that needs a real DOM (click/act-driven interaction tests).
 *
 * The components under test define `class X extends HTMLElement` at module
 * evaluation (client-core tool-render element), so the globals must exist
 * before those imports run — same reason test/dom-shim.ts carries its
 * "MUST be first" rule. This file has zero imports so ES-module hoisting
 * evaluates it before everything else the test pulls in.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Outside Electron `openExternalUrl()` falls back to `window.open()`, and
// happy-dom's implementation navigates its virtual browser — it fetches the
// URL, so an OAuth hand-off to a fixture address (`https://auth.example/…`)
// turns into a real DNS lookup and an unhandled NetworkError between tests.
// Record the hand-off instead of leaving the page.
const openedExternalUrls: string[] = [];
Object.defineProperty(window, "open", {
	configurable: true,
	writable: true,
	value: (url?: string | URL) => {
		if (url !== undefined) openedExternalUrls.push(String(url));
		return null;
	},
});
/** URLs handed to `window.open()` by `openExternalUrl()` in this process. */
export function externalUrlsOpened(): readonly string[] {
	return openedExternalUrls;
}

// Monaco's WebKit clipboard workaround rejects its previous deferred write on
// every click. happy-dom exposes the clipboard surface without implementing
// that browser lifecycle, so disable it and use Monaco's fallback path instead.
Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
// happy-dom has no rasterizer. A transparent bitmap keeps canvas feature
// probes negative while Monaco can still run its overview-ruler drawing path.
Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
	configurable: true,
	writable: true,
	value: function (this: HTMLCanvasElement) {
		const fallback = new Proxy(
			function fallback(): unknown {
				return fallback;
			},
			{ get: target => target },
		);
		return new Proxy(
			{
				canvas: this,
				measureText: () => ({ width: 0 }),
				getImageData: (_x: number, _y: number, width = 1, height = 1) => ({
					data: new Uint8ClampedArray(width * height * 4),
				}),
			},
			{
				get: (target, property) => Reflect.get(target, property) ?? fallback,
				set: (target, property, value) => Reflect.set(target, property, value),
			},
		);
	},
});
