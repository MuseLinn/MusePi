/** Static launch form of the desktop pet. Shell paints follow the live
 * `gui-pet-*` palette. The happy face and the headphone rig are the same
 * geometry CompanionArt draws, without the interactive mascot engine. */
import type React from "react";
import { FACE_BOX, faceFor, mouthFrame, mouthPath, mouthSpecFor, mouthStroke, toPath } from "../lib/companion-face";
import { HEADPHONE_SCALE, type HeadphoneDisc, headphoneFront, headphonePadding } from "../lib/companion-headphones";

const PAD = headphonePadding(FACE_BOX);
const CENTRE = FACE_BOX / 2;
const HAPPY = faceFor("happy");
const HAPPY_MOUTH = mouthSpecFor("happy");
const HEADPHONES = headphoneFront(CENTRE, CENTRE);
const VIEW_W = FACE_BOX + PAD.side * 2;
const VIEW_H = FACE_BOX + PAD.top + PAD.bottom;

function discFill(role: HeadphoneDisc["role"]): string {
	if (role === "pad") return "oklch(90% 0.006 95)";
	if (role === "plate") return "oklch(97% 0.004 95)";
	return "url(#gui-splash-orb-wear)";
}

export function SplashOrb(): React.JSX.Element {
	return (
		<svg
			viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
			xmlns="http://www.w3.org/2000/svg"
			focusable="false"
			className="gui-splash-orb-svg"
			aria-hidden="true"
		>
			<defs>
				<radialGradient id="gui-splash-orb-shell" cx="0.34" cy="0.26" r="0.92">
					<stop offset="0" stopColor="var(--gui-pet-shell-a, oklch(89.07% 0.0798 79.84))" />
					<stop offset="0.5" stopColor="var(--gui-pet-shell-b, oklch(65% 0.105 79.84))" />
					<stop offset="1" stopColor="var(--gui-pet-shell-c, oklch(33% 0.08 79.84))" />
				</radialGradient>
				<linearGradient id="gui-splash-orb-wear" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0" stopColor="oklch(97% 0.004 95)" />
					<stop offset="1" stopColor="oklch(90% 0.006 95)" />
				</linearGradient>
				<radialGradient id="gui-splash-orb-eye" cx="0.5" cy="0.3" r="0.78">
					<stop offset="0" stopColor="#ffffff" />
					<stop offset="0.45" stopColor="#f4f6f9" />
					<stop offset="1" stopColor="#c9ced7" />
				</radialGradient>
			</defs>
			<g transform={`translate(${PAD.side} ${PAD.top})`}>
				<circle cx={CENTRE} cy={CENTRE} r={CENTRE} fill="url(#gui-splash-orb-shell)" />
				<g fill="url(#gui-splash-orb-eye)">
					<path d={toPath(HAPPY[0])} />
					<path d={toPath(HAPPY[1])} />
				</g>
				<path
					d={mouthPath(mouthFrame(HAPPY, HAPPY_MOUTH), HAPPY_MOUTH)}
					fill="none"
					stroke="#f4f6f9"
					strokeWidth={mouthStroke(HAPPY_MOUTH)}
					strokeLinecap="round"
				/>
				<g transform={`translate(${CENTRE} ${CENTRE}) scale(${HEADPHONE_SCALE}) translate(${-CENTRE} ${-CENTRE})`}>
					{HEADPHONES.arches.map(arch => (
						<path
							key={arch.role}
							d={arch.d}
							fill="none"
							stroke={arch.role === "lining" ? "#b6ada4" : "url(#gui-splash-orb-wear)"}
							strokeWidth={arch.width}
							strokeLinecap="round"
						/>
					))}
					{HEADPHONES.joins.map(join => (
						<line
							key={join.side}
							x1={join.x1}
							y1={join.y1}
							x2={join.x2}
							y2={join.y2}
							stroke="url(#gui-splash-orb-wear)"
							strokeWidth={join.width}
							strokeLinecap="round"
						/>
					))}
					{HEADPHONES.discs.map(disc => (
						<ellipse
							key={`${disc.side}-${disc.role}`}
							cx={disc.cx}
							cy={disc.cy}
							rx={disc.rx}
							ry={disc.ry}
							fill={discFill(disc.role)}
							stroke="oklch(72% 0.012 90)"
							strokeWidth={disc.role === "plate" ? 1.4 : 0.8}
						/>
					))}
				</g>
			</g>
		</svg>
	);
}
