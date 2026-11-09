/**
 * `sidebar.panel.capability` slot entry.
 *
 * The component lives in the app tree so the host can mount the exact same
 * implementation as its offline fallback — no duplicated panel. Its imports
 * resolve to `window.MusePiHostModules` for shared identity (`capability-nav`
 * holds the one tab/count snapshot the `app.capability` page publishes;
 * `client-core` holds the one i18n/React context). Geometry comes from
 * `--gui-side-w` on `.gui-side-keeper`, so a slot mount needs no host props.
 */
export { CapabilitySidePanel as default } from "../../components/CapabilitySidePanel";
