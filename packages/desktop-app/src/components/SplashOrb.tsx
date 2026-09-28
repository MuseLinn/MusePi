/** Launch-splash orb mascot — a posed still of the desktop pet (PetSprite):
 * gold sphere + white over-ear wearables. NO orbit ring: the real pet draws
 * its ring (rx 104) fully behind the opaque shell (r 114.27), so a still
 * shows no ring — 2026-09-28 user flagged the earlier ringed stills as
 * "和实际有差异". Geometry is copied verbatim from the landing page's .mp-orb
 * so the brand mark renders identically everywhere. Pure SVG + CSS animation
 * hooks (gui-splash-orb-*), no mascot engine: the splash is a still, not a
 * pet. */
import type React from "react";

export function SplashOrb(): React.JSX.Element {
	return (
		<svg
			viewBox="0 0 269 275"
			xmlns="http://www.w3.org/2000/svg"
			focusable="false"
			className="gui-splash-orb-svg"
			aria-hidden="true"
		>
			<defs>
				<radialGradient id="gui-splash-orb-shell" cx="0.34" cy="0.26" r="0.92">
					<stop offset="0" stopColor="oklch(89.07% 0.0798 79.84)" />
					<stop offset="0.5" stopColor="oklch(65% 0.105 79.84)" />
					<stop offset="1" stopColor="oklch(33% 0.08 79.84)" />
				</radialGradient>
				<linearGradient id="gui-splash-orb-wear" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0" stopColor="oklch(97% 0.004 95)" />
					<stop offset="1" stopColor="oklch(90% 0.006 95)" />
				</linearGradient>
				<linearGradient id="gui-splash-orb-rose" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0" stopColor="oklch(83% 0.05 40)" />
					<stop offset="0.55" stopColor="oklch(72% 0.075 35)" />
					<stop offset="1" stopColor="oklch(58% 0.07 32)" />
				</linearGradient>
				<radialGradient id="gui-splash-orb-eye" cx="0.5" cy="0.3" r="0.78">
					<stop offset="0" stopColor="#ffffff" />
					<stop offset="0.45" stopColor="#f4f6f9" />
					<stop offset="1" stopColor="#c9ced7" />
				</radialGradient>
			</defs>
			<g transform="translate(20 24)">
				<circle cx="114.27" cy="114.27" r="114.27" fill="url(#gui-splash-orb-shell)" />
				<ellipse
					cx="80.27"
					cy="57.27"
					rx="31"
					ry="14"
					transform="rotate(-22 80.27 57.27)"
					fill="#ffffff"
					opacity="0.5"
				/>
				<ellipse
					cx="58.27"
					cy="84.27"
					rx="7"
					ry="4"
					transform="rotate(-22 58.27 84.27)"
					fill="#ffffff"
					opacity="0.35"
				/>
				<ellipse
					cx="94.27"
					cy="50.27"
					rx="15"
					ry="5.6"
					transform="rotate(-22 94.27 50.27)"
					fill="#ffffff"
					opacity="0.55"
				/>
				<ellipse cx="88" cy="112" rx="12.5" ry="17" fill="url(#gui-splash-orb-eye)" />
				<ellipse cx="141" cy="112" rx="12.5" ry="17" fill="url(#gui-splash-orb-eye)" />
				<path d="M 97 138 Q 114.5 152 132 138" fill="none" stroke="#f4f6f9" strokeWidth="7" strokeLinecap="round" />
				<path
					d="M -2 78 A 123.3 123.3 0 0 1 230.54 78"
					fill="none"
					stroke="url(#gui-splash-orb-wear)"
					strokeWidth="14"
					strokeLinecap="round"
				/>
				<path
					d="M -2 74 A 128 128 0 0 1 230.54 74"
					fill="none"
					stroke="url(#gui-splash-orb-rose)"
					strokeWidth="2.6"
					strokeLinecap="round"
				/>
				<path
					d="M -2 84 A 118.5 118.5 0 0 1 230.54 84"
					fill="none"
					stroke="url(#gui-splash-orb-rose)"
					strokeWidth="2.6"
					strokeLinecap="round"
				/>
				<rect
					x="-6.5"
					y="74"
					width="9"
					height="30"
					rx="4.5"
					fill="url(#gui-splash-orb-rose)"
					stroke="oklch(58% 0.07 32)"
					strokeWidth="1.2"
				/>
				<rect
					x="225.97"
					y="74"
					width="9"
					height="30"
					rx="4.5"
					fill="url(#gui-splash-orb-rose)"
					stroke="oklch(58% 0.07 32)"
					strokeWidth="1.2"
				/>
				<g transform="translate(-2 104.27) rotate(-14)">
					<ellipse
						rx="12.6"
						ry="25"
						fill="url(#gui-splash-orb-wear)"
						stroke="oklch(72% 0.012 90)"
						strokeWidth="2.2"
					/>
					<ellipse rx="9" ry="20.5" fill="oklch(94% 0.005 95)" />
					<ellipse rx="4.8" ry="12.5" fill="oklch(45% 0.012 80)" />
					<path
						d="M -7.2 -17.8 A 11.2 23.2 0 0 1 3.8 -21.9"
						fill="none"
						stroke="#fff"
						strokeWidth="1.8"
						strokeLinecap="round"
						opacity="0.85"
					/>
				</g>
				<g transform="translate(230.54 104.27) rotate(14)">
					<ellipse
						rx="12.6"
						ry="25"
						fill="url(#gui-splash-orb-wear)"
						stroke="oklch(72% 0.012 90)"
						strokeWidth="2.2"
					/>
					<ellipse rx="9" ry="20.5" fill="oklch(94% 0.005 95)" />
					<ellipse rx="4.8" ry="12.5" fill="oklch(45% 0.012 80)" />
					<path
						d="M -7.2 -17.8 A 11.2 23.2 0 0 1 3.8 -21.9"
						fill="none"
						stroke="#fff"
						strokeWidth="1.8"
						strokeLinecap="round"
						opacity="0.85"
					/>
					<rect
						x="2"
						y="-31"
						width="7"
						height="10"
						rx="2.4"
						fill="url(#gui-splash-orb-rose)"
						stroke="oklch(58% 0.07 32)"
						strokeWidth="1.2"
					/>
				</g>
			</g>
		</svg>
	);
}
