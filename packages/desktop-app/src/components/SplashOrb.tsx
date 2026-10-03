/** Launch-splash orb mascot — a posed still of the desktop pet (PetSprite):
 * gold sphere + white over-ear wearables. NO orbit ring: the real pet draws
 * its ring (rx 104) fully behind the opaque shell (r 114.27), so a still
 * shows no ring — 2026-09-28 user flagged the earlier ringed stills as
 * "和实际有差异". Geometry is copied verbatim from the landing page's .mp-orb
 * so the brand mark renders identically everywhere. Pure SVG + CSS animation
 * hooks (gui-splash-orb-*), no mascot engine: the splash is a still, not a
 * pet.
 *
 * 2026-10-03 — the face was hand-drawn here (two bare ovals + a thin arc) and
 * matched NONE of the pet's 12 eye shapes, which is why the splash read as
 * "特别呆" next to a living pet. It now uses the pet's own `happy` rings,
 * verbatim from `lib/pet-face.ts` ENCODED_EYES.happy, in the pet's own
 * placement (no shift — this is a still OF the pet). The specular highlight
 * ellipses are gone: on a static mark they read as a 3D render, not a mark.
 * Regenerate both from .workbuddy/brand-qa/icon-v3/gen.py. */
import type React from "react";

/** `happy` eye rings from lib/pet-face.ts, 48 measured points each. */
const FACE_EYES = [
	"94.46,77.38 98.87,78.08 103.02,79.73 106.69,82.26 109.65,85.59 111.73,89.53 112.83,93.86 112.81,98.32 111.87,102.68 110.65,106.98 109.40,111.28 108.15,115.57 106.90,119.86 105.63,124.15 104.35,128.44 103.06,132.72 101.76,136.99 100.47,141.27 99.17,145.55 97.76,149.79 95.55,153.66 92.18,156.57 88.13,158.42 83.75,159.29 79.29,159.27 74.89,158.49 70.68,157.00 66.81,154.78 63.51,151.78 61.12,148.02 60.02,143.71 60.58,139.30 61.95,135.04 63.28,130.77 64.59,126.50 65.90,122.22 67.19,117.94 68.46,113.66 69.73,109.37 70.99,105.08 72.24,100.79 73.48,96.49 74.68,92.18 76.21,87.99 78.64,84.25 81.87,81.17 85.73,78.94 90.01,77.66",
	"161.90,85.01 166.11,85.33 169.94,87.09 172.90,90.10 174.77,93.89 175.58,98.04 175.47,102.28 174.92,106.48 174.26,110.67 173.50,114.85 172.62,118.99 171.62,123.12 170.51,127.21 169.28,131.27 167.93,135.29 166.43,139.26 164.78,143.17 162.97,147.00 160.97,150.74 158.56,154.22 155.64,157.29 152.33,159.94 148.71,162.15 144.84,163.89 140.78,165.08 136.57,165.54 132.40,164.90 129.02,162.46 128.04,158.41 129.19,154.36 131.11,150.58 132.95,146.76 134.64,142.86 136.19,138.91 137.60,134.92 138.88,130.87 140.03,126.79 141.06,122.68 141.97,118.53 142.77,114.37 143.41,110.17 144.00,105.97 144.83,101.82 146.17,97.80 148.20,94.08 150.87,90.79 154.08,88.03 157.79,86.00",
] as const;

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
				<g fill="url(#gui-splash-orb-eye)">
					<polygon points={FACE_EYES[0]} />
					<polygon points={FACE_EYES[1]} />
				</g>
				<path
					d="M99.36 171.45 Q113.71 178.10 129.17 174.82"
					fill="none"
					stroke="#f4f6f9"
					strokeWidth="9.19"
					strokeLinecap="round"
				/>
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
