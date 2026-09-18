import type React from "react";
import { Icon, type IconName } from "../vendor/oc-icons";

/**
 * Spring cross-morph for state-paired sprite icons.
 *
 * Design spec (docs/gui-design.md 动效 + 设计板「图标 morph 规范」): any icon
 * that flips with runtime state — play/pause, eye/eye-off, expand/collapse,
 * saved/download, panel direction — morphs between its two shapes instead of
 * hard-swapping. The onboarding step icon does this with a path-level
 * MorphIcon, but that primitive is stroke-based (single interpolated `d`) and
 * the app-wide sprite set is fill-based (Remix-style `<use>` shapes), where a
 * path morph would render outlines and break the icon language. So the sprite
 * world gets the same *reading* through a different mechanic: both shapes stay
 * mounted in an inline-grid, the outgoing one collapses while the incoming one
 * grows in from the opposite side, driven by `--spring`.
 *
 * Pure CSS on purpose: `.gui-motion-off` and `prefers-reduced-motion` degrade
 * it globally, and no per-component matchMedia wiring is needed.
 *
 * ```
 * <StateIcon on={running} pair={["pause", "play"]} className="h-4 w-4" />
 * ```
 * (`on` shows `pair[0]`; `false` shows `pair[1]`.)
 */
export function StateIcon({
	on,
	pair,
	className,
	...rest
}: {
	/** When truthy, renders `pair[0]`; falsy/undefined renders `pair[1]`. */
	on?: boolean;
	/** `[shownWhenOn, shownWhenOff]` — oc-icon names. */
	pair: readonly [IconName, IconName];
	className?: string;
} & Omit<React.HTMLAttributes<HTMLSpanElement>, "children">): React.JSX.Element {
	return (
		<span
			aria-hidden={true}
			className={"gui-icon-morph".concat(on ? " is-on" : "", className ? ` ${className}` : "")}
			{...rest}
		>
			<Icon name={pair[0]} className="gui-icon-morph__shape gui-icon-morph__shape--on" />
			<Icon name={pair[1]} className="gui-icon-morph__shape gui-icon-morph__shape--off" />
		</span>
	);
}
