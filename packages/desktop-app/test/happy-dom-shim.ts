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

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
