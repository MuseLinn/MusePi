/**
 * Brand surfaces as plugin contributions: the welcome backdrop is the first
 * one, registered into the hero frame seat.
 *
 * Capability seam (docs/capability-seams.md):
 * - Space: `conversation.hero.frame` (single occupant, hoc wrapper) — the
 *   contribution owns the layer behind the hero content.
 * - Input: the host injects `slots` only; the component reads the
 *   `musepi-gui-dotmatrix*` preferences itself and listens for their change
 *   events (settings → 常规), so a toggle repaints without a host re-render.
 * - Output: one absolutely-positioned dot-grid canvas behind the hero content.
 * - Lifecycle: the canvas mounts/unmounts with the seat; its rAF, resize and
 *   pointer listeners are owned and reclaimed by `DotMatrixMark`.
 * - Fallback: disabling this plugin (or a compile failure) leaves the built-in
 *   `WelcomeBackdrop` in place — the host keeps the same backdrop as its
 *   fallback, so the welcome never loses its background.
 * - Inspection: this directory, `hero-frame.tsx`, and
 *   `apps/desktop/src/lib/welcome-backdrop.tsx`.
 */
interface UiBrandPluginApi {
	readonly slots: {
		register(component: { slot: string; moduleUrl: string; label: string; availability?: string }): void;
	};
	setLabel(label: string): void;
}

export const name = "musepi-ui-brand";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: UiBrandPluginApi): void {
	ctx.slots.register({
		slot: "conversation.hero.frame",
		moduleUrl: "./hero-frame.tsx",
		label: "点阵品牌背景",
	});
}
