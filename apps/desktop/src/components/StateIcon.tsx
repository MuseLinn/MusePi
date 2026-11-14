import type React from "react";
import { Icon, type IconName } from "../vendor/oc-icons";

/**
 * Spring cross-morph for state-paired sprite icons.
 *
 * Design spec (docs/gui-design.md 动效 + 设计板「图标 morph 规范」): any icon
 * that flips with runtime state morphs between its two shapes instead of
 * hard-swapping. Stroke icons use `MorphIcon` (morphicons); fill-only pairs
 * use a single lucide glyph with a CSS fill transition. This component is
 * retained for sprite glyphs without a stroke equivalent, where a path morph
 * would turn filled shapes into outlines. It keeps the same reading through a
 * different mechanic: both shapes stay mounted in an inline-grid, the
 * outgoing one collapses while the incoming one grows in from the opposite
 * side, driven by `--spring`.
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

/**
 * N-ary variant: the value-keyed switch (tri-state kind icons —
 * calendar/board/list, loading/speaking/idle, all/actions/list — don't fit a
 * pair). Every option stays mounted; the active one stands upright while the
 * others hold the collapsed pose, so switching rolls one glyph into the next
 * with the same spring. Binary `StateIcon` keeps its richer two-directional
 * pairing; use this when there are 3+ states.
 */
export function StateIconN({
	value,
	options,
	className,
	...rest
}: {
	/** The active option key. */
	value: string;
	/** `optionKey → oc-icon name`; every entry renders as a layer. */
	options: Record<string, IconName>;
	className?: string;
} & Omit<React.HTMLAttributes<HTMLSpanElement>, "children">): React.JSX.Element {
	return (
		<span
			aria-hidden={true}
			className={"gui-icon-morph gui-icon-morph--nary".concat(className ? ` ${className}` : "")}
			{...rest}
		>
			{Object.entries(options).map(([key, name]) => (
				<Icon key={key} name={name} className={`gui-icon-morph__shape${key === value ? " is-active" : ""}`} />
			))}
		</span>
	);
}
