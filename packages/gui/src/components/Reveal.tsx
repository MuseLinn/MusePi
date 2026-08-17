import type { ReactNode } from "react";
import { useCollapse } from "../lib/use-collapse";

/**
 * 条件区块动效规范 (conditional-block animation standard).
 *
 * Every block whose visibility follows another option's state (settings
 * conditionals, sidebar group/project blocks, provider lists, …) MUST use
 * this component instead of `{cond && …}` or bespoke height tricks:
 *  - the node stays mounted — state inside survives toggles;
 *  - height animates via useCollapse (explicit px — see its doc for why
 *    grid-template-rows 0fr↔1fr was rejected);
 *  - the outer fades 160ms while the inner height eases 240ms with
 *    cubic-bezier(0.22, 1, 0.36, 1) — one shared motion language;
 *  - closed = zero height, aria-hidden + inert (not tabbable).
 *
 * For content that STAYS visible but changes height (tab bodies, in-place
 * list growth) use HeightMorph instead.
 */
export function Reveal({
	open,
	children,
	className = "",
}: {
	open: boolean;
	children: ReactNode;
	className?: string;
}): ReactNode {
	const innerRef = useCollapse(open);
	return (
		<div
			className={`gui-collapse${open ? " gui-collapse--open" : ""}${className ? ` ${className}` : ""}`}
			aria-hidden={!open}
			inert={!open}
		>
			<div className="gui-collapse-inner" ref={innerRef}>
				{children}
			</div>
		</div>
	);
}
