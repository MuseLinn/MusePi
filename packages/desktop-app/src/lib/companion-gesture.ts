/** Pointer input for the builtin orb. Velocities are CSS px/s; timestamps use
 * the renderer's performance.now() clock. The frame loop reads this object
 * through a ref so pointer events do not re-render React. */
export interface CompanionGestureInput {
	pressed: boolean;
	dragging: boolean;
	vx: number;
	vy: number;
	at: number;
	releasedAt: number | null;
}

/** Smoothed gesture channels. They compose with, rather than replace, the
 * session's authored body motion. */
export interface CompanionGestureMotion {
	tilt: number;
	stretch: number;
	lift: number;
	drop: number;
	squash: number;
}

export function createCompanionGestureMotion(): CompanionGestureMotion {
	return { tilt: 0, stretch: 0, lift: 0, drop: 0, squash: 0 };
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const finite = (value: number): number => (Number.isFinite(value) ? value : 0);

/**
 * Advance the orb's gesture springs by one frame.
 *
 * Direction is a continuous signed tilt, never a mirror. A stale pointer
 * sample stops contributing velocity after 120ms. Releasing produces a
 * damped landing impulse that starts at zero and ends at zero.
 */
export function advanceCompanionGesture(
	state: CompanionGestureMotion,
	input: CompanionGestureInput | null,
	dt: number,
	now: number,
): CompanionGestureMotion {
	const step = clamp(finite(dt), 0, 64);
	const active = input?.dragging === true;
	const recent = active && Number.isFinite(now - input.at) && now - input.at <= 120;
	const vx = recent ? finite(input.vx) : 0;
	const vy = recent ? finite(input.vy) : 0;
	const targetTilt = active ? clamp(vx / 900, -1, 1) * 11 : 0;
	const targetStretch = input?.pressed ? (active ? 0.06 + clamp(Math.abs(vy) / 1400, 0, 1) * 0.05 : 0.025) : 0;
	const targetLift = active ? -5 : 0;
	const alpha = 1 - Math.exp(-step / (active ? 85 : 150));
	state.tilt += (targetTilt - state.tilt) * alpha;
	state.stretch += (targetStretch - state.stretch) * alpha;
	state.lift += (targetLift - state.lift) * alpha;

	const releaseAge = input?.releasedAt === null || input?.releasedAt === undefined ? Infinity : now - input.releasedAt;
	const landing = releaseAge >= 0 && releaseAge < 520 ? Math.sin(releaseAge / 58) * Math.exp(-releaseAge / 210) : 0;
	state.drop = landing * 3.2;
	state.squash = landing * 0.09;
	return state;
}

/** SVG transform for the current gesture. Scale pivots on the orb's ground
 * point so the landing squash does not make the body float. */
export function companionGestureTransform(motion: CompanionGestureMotion, box: number): string {
	const parts: string[] = [];
	const dy = motion.lift + motion.drop;
	if (Math.abs(dy) > 0.005) parts.push(`translate(0 ${dy.toFixed(2)})`);
	if (Math.abs(motion.tilt) > 0.005) {
		const centre = box / 2;
		parts.push(`rotate(${motion.tilt.toFixed(2)} ${centre} ${centre})`);
	}
	const deformation = motion.stretch - motion.squash;
	if (Math.abs(deformation) > 0.0001) {
		const centre = box / 2;
		const sx = 1 - deformation * 0.65;
		const sy = 1 + deformation;
		parts.push(`translate(${centre} ${box}) scale(${sx.toFixed(4)} ${sy.toFixed(4)}) translate(${-centre} ${-box})`);
	}
	return parts.join(" ");
}
