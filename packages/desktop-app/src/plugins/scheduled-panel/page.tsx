/**
 * `sidebar.panel.scheduled` slot entry.
 *
 * The component lives in the app tree so the host can mount the exact same
 * implementation as its offline fallback — no duplicated panel. Its imports
 * resolve to `window.MusePiHostModules` for shared identity (`task-nav` holds
 * the one cron.list snapshot; `client-core` holds the one i18n/React context).
 * Geometry comes from `--gui-side-w` on `.gui-side-keeper`, so a slot mount
 * needs no host-specific props.
 */
export { ScheduledTasksPanel as default } from "../../components/ScheduledTasksPanel";
