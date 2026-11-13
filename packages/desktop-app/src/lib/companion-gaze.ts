/** A normalized pointer sample. `at` uses the renderer's performance clock;
 *  older callers may omit it, in which case the sample does not expire. */
export interface GazeVec {
	x: number;
	y: number;
	at?: number;
}

/** Independent response channels: eyes acquire a target quickly, while the
 *  head follows more slowly. All fields are normalized before face travel. */
export interface GazeMotionState {
	eyeX: number;
	eyeY: number;
	headX: number;
	headY: number;
	attention: number;
}

export const GAZE_IDLE_MS = 3000;
const GAZE_DEAD_ZONE = 0.06;
const GAZE_ATTACK_MS = 220;
const GAZE_RELEASE_MS = 380;
const GAZE_EYE_GLIDE_MS = 120;
const GAZE_HEAD_GLIDE_MS = 240;

export function createGazeMotionState(): GazeMotionState {
	return { eyeX: 0, eyeY: 0, headX: 0, headY: 0, attention: 0 };
}

/** Remove small centre jitter without losing range outside the dead zone.
 *  A stale sample targets the centre but remains active, so idle drift does
 *  not immediately pull the eyes away again. */
export function resolveGazeTarget(target: GazeVec | null, now: number): { x: number; y: number } | null {
	if (!target) return null;
	const stale = target.at !== undefined && now - target.at >= GAZE_IDLE_MS;
	if (stale) return { x: 0, y: 0 };
	const length = Math.hypot(target.x, target.y);
	if (length <= GAZE_DEAD_ZONE) return { x: 0, y: 0 };
	const clamped = Math.min(1, length);
	const scale = (clamped - GAZE_DEAD_ZONE) / (1 - GAZE_DEAD_ZONE) / length;
	return { x: target.x * scale, y: target.y * scale };
}

function approach(current: number, target: number, dt: number, timeConstant: number): number {
	return current + (target - current) * (1 - Math.exp(-dt / timeConstant));
}

/** Advance the shared frame state in place. The caller clamps dt to keep a
 *  backgrounded window from completing a whole movement in one frame. */
export function advanceGazeMotion(
	state: GazeMotionState,
	target: GazeVec | null,
	dt: number,
	now: number,
): GazeMotionState {
	const resolved = resolveGazeTarget(target, now);
	if (resolved) {
		state.eyeX = approach(state.eyeX, resolved.x, dt, GAZE_EYE_GLIDE_MS);
		state.eyeY = approach(state.eyeY, resolved.y, dt, GAZE_EYE_GLIDE_MS);
		state.headX = approach(state.headX, resolved.x, dt, GAZE_HEAD_GLIDE_MS);
		state.headY = approach(state.headY, resolved.y, dt, GAZE_HEAD_GLIDE_MS);
		state.attention = Math.min(1, state.attention + dt / GAZE_ATTACK_MS);
	} else {
		state.attention = Math.max(0, state.attention - dt / GAZE_RELEASE_MS);
	}
	return state;
}

/** Vary each state's authored cadence by ±28%. A zero cadence remains a
 *  hard no-blink contract for concentrated and held-attention expressions. */
export function nextBlinkDelay(cadenceMs: number, random: number): number {
	if (cadenceMs <= 0) return 0;
	const unit = Math.max(0, Math.min(1, random));
	return Math.round(cadenceMs * (0.72 + unit * 0.56));
}
