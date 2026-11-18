/**
 * Preloads `react-dom` into a browser-capable feature-detection state, then
 * puts the process back the way the suites expect it.
 *
 * react-dom decides `canUseDOM` (and from it `isInputEventSupported`) once, at
 * module evaluation. Bun evaluates that CommonJS package before a test file's
 * first `import "./happy-dom-shim"` statement runs, so the DOM was always
 * missing at that moment and every suite took React's IE-era input-value
 * polyfill path. That polyfill tracks the focused input in a module-global and
 * throws `TypeError: null is not an object (evaluating 'inst.tag')` on the next
 * `keydown` once the tracker has been cleared by a focusout.
 *
 * Registering happy-dom for the duration of that one import gives react-dom the
 * browser answer it would get in production. The registration is then removed
 * again, so each suite keeps controlling its own DOM exactly as before — no
 * happy-dom `fetch`/`localStorage`/`HTMLElement` leaking into suites that do
 * not ask for it.
 */
import { afterAll, beforeEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
await import("react-dom/client");
await GlobalRegistrator.unregister();

/** A suite may unregister the shared DOM in its afterAll; module caching means
 *  a later suite's `import "./happy-dom-shim"` body does not run again. Ensure
 *  a usable window before every test so one suite cannot starve the next. */
function ensureDom(): void {
	// A suite that stubs its own globals (window/localStorage) keeps them: it
	// has a `window` object but no global document. DOM-backed suites always
	// have a document while happy-dom is registered, and lose it entirely when
	// a previous suite unregisters — that is the state this restores.
	const hasDocument = typeof globalThis.document !== "undefined";
	if (!hasDocument && typeof globalThis.window === "object") return;
	const usable = GlobalRegistrator.isRegistered && hasDocument && typeof globalThis.window?.matchMedia === "function";
	if (usable) return;
	try {
		if (GlobalRegistrator.isRegistered) GlobalRegistrator.unregister();
		GlobalRegistrator.register();
	} catch {
		// A suite owns a non-configurable global (its own stubs); leave it alone
		// rather than failing the test on the harness's cleanup.
	}
}
beforeEach(ensureDom);

// After every file, hand the next suite a clean happy-dom instead of whatever
// globals this one installed (some suites replace window/localStorage).
afterAll(() => {
	try {
		if (GlobalRegistrator.isRegistered) GlobalRegistrator.unregister();
		GlobalRegistrator.register();
	} catch {
		// Same: never fail a suite because the next one's globals are in the way.
	}
});
