import { type ReactNode, useId } from "react";

/**
 * Dot-matrix bloom loader (desktop GUI parity — action-buttons.tsx
 * MatrixLoader, opendesign lineage): a 5×5 grid of dots whose on-cells
 * pulse outward from the center with a Manhattan-distance phase offset
 * (SMIL animation — zero JS). A component-transfer contrast boost plus
 * two gaussian blurs merged with a screen blend produce the bloom glow.
 */
export function MatrixLoader({ className }: { className?: string }): ReactNode {
	const filterId = useId();
	return (
		<svg className={className} viewBox="0 0 92 92" width="18" height="18" aria-hidden="true" focusable="false">
			<defs>
				<filter id={filterId} x="-100%" y="-100%" width="300%" height="300%">
					<feComponentTransfer in="SourceGraphic" result="bright">
						<feFuncR type="linear" slope={3.9} intercept={-3.51} />
						<feFuncG type="linear" slope={3.9} intercept={-3.51} />
						<feFuncB type="linear" slope={3.9} intercept={-3.51} />
					</feComponentTransfer>
					<feGaussianBlur in="bright" stdDeviation={9.5} result="bloomSmall" />
					<feGaussianBlur in="bright" stdDeviation={19} result="bloomLarge" />
					<feMerge result="bloomMerge">
						<feMergeNode in="bloomLarge" />
						<feMergeNode in="bloomSmall" />
					</feMerge>
					<feBlend in="SourceGraphic" in2="bloomMerge" mode="screen" />
				</filter>
			</defs>
			{/* Off-cell placeholders (invisible, occupy space for consistent layout) */}
			<g opacity="0">
				{[0, 1, 2, 3, 4].map(ri =>
					[0, 1, 2, 3, 4].map(ci => (
						<circle key={`off-${ri}-${ci}`} cx={8 + ci * 19} cy={8 + ri * 19} r={8} fill="currentColor" />
					)),
				)}
			</g>
			{/* Animated on-cells: Manhattan-distance bloom from center (2,2) */}
			<g filter={`url(#${filterId})`}>
				{[0, 1, 2, 3, 4].map(ri =>
					[0, 1, 2, 3, 4].map(ci => {
						const d = Math.abs(ri - 2) + Math.abs(ci - 2);
						// Corner cells (d=4) are always off; center (d=0) always on.
						const hide = d === 4;
						const alwaysOn = d === 0;
						if (hide)
							return (
								<circle
									key={`on-${ri}-${ci}`}
									cx={8 + ci * 19}
									cy={8 + ri * 19}
									r={8}
									fill="currentColor"
									opacity={0}
								/>
							);
						if (alwaysOn)
							return (
								<circle key={`on-${ri}-${ci}`} cx={8 + ci * 19} cy={8 + ri * 19} r={8} fill="currentColor" />
							);
						return (
							<circle key={`on-${ri}-${ci}`} cx={8 + ci * 19} cy={8 + ri * 19} r={8} fill="currentColor">
								<animate
									attributeName="opacity"
									values="0.15;1;0.15"
									dur="1.333s"
									begin={`${d * 220}ms`}
									repeatCount="indefinite"
								/>
							</circle>
						);
					}),
				)}
			</g>
		</svg>
	);
}
