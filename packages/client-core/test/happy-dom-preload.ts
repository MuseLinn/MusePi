/**
 * Preloads `react-dom` into a browser-capable feature-detection state, then
 * puts the process back the way the suites expect it.
 *
 * react-dom decides `canUseDOM` (and from it `isInputEventSupported`) once, at
 * module evaluation. Bun evaluates that CommonJS package before a test file's
 * `GlobalRegistrator.register()` call runs, so the DOM was always missing at
 * that moment and every suite took React's IE-era input-value polyfill path.
 * That polyfill tracks the focused input in a module-global and throws
 * `TypeError: null is not an object (evaluating 'inst.tag')` on the next
 * `keydown` once the tracker has been cleared by a focusout.
 *
 * Registering happy-dom for the duration of that one import gives react-dom the
 * browser answer it would get in production. The registration is then removed
 * again, so each suite keeps registering and tearing down its own DOM exactly
 * as before — no happy-dom `fetch`/`localStorage`/`HTMLElement` leaks into
 * suites that do not ask for it.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
await import("react-dom/client");
await GlobalRegistrator.unregister();
