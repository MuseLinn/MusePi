/**
 * Builtin headphone rig — the approved coaxial cans.
 *
 * Each cup is a short cylinder whose base faces the sphere. Plate, wall and
 * pad share one axis in the XZ plane (no outward splay). The front view is an
 * orthographic projection of that rig onto the drawn shell: the disc is
 * foreshortened by cos(tilt), so the cup reads as the cylinder's side.
 *
 * Lengths on {@link HEADPHONE_RIG} are fractions of the shell radius. Screen
 * space uses the shell the art actually draws (FACE_BOX / 2), which is larger
 * than the face engine's SPHERE_R; the rings stay in face space and the cans
 * are scaled onto the painted ball so they sit at the ears.
 */

export type Vec3 = readonly [number, number, number];

/** Approved construction. Dome, cheek sphere and outer pad stay at 0. */
export const HEADPHONE_RIG = {
	cupDist: 1.08,
	cupCy: -0.04,
	cupZ: 0.2,
	cupHalf: 0.14,
	/** Radians from +Z toward ±X. 60° → included angle 120°, front aspect 0.5. */
	cupTiltRad: Math.PI / 3,
	plateR: 0.165,
	cupR: 0.21,
	padR: 0.222,
	padRt: 0.048,
	padT: 0.025,
	wallMid: 0.08,
	wallH: 0.052,
	wallRing: 0.03,
	plateLip: 0.008,
	plateHalf: 0.01,
	bandCy: -0.17,
	bandZ: 0.22,
	bandRm: 1.056,
	bandRt: 0.045,
	liningRm: 0.965,
	liningRt: 0.05,
	bandA0: (-173 * Math.PI) / 180,
	bandA1: (-7 * Math.PI) / 180,
	liningA0: (-130 * Math.PI) / 180,
	liningA1: (-50 * Math.PI) / 180,
	yokeW: 0.02,
	plateDomeH: 0,
	cheekR: 0,
	outerPadR: 0,
} as const;

/** Render scale applied about the shell centre. The rig above is unscaled. */
export const HEADPHONE_SCALE = 1.08;

export type CupSide = "L" | "R";

const sideSign = (side: CupSide): 1 | -1 => (side === "R" ? 1 : -1);

export function cupAxis(side: CupSide): Vec3 {
	const s = sideSign(side);
	return [s * Math.sin(HEADPHONE_RIG.cupTiltRad), 0, Math.cos(HEADPHONE_RIG.cupTiltRad)];
}

export function cupCenter(side: CupSide): Vec3 {
	const s = sideSign(side);
	return [s * HEADPHONE_RIG.cupDist, HEADPHONE_RIG.cupCy, HEADPHONE_RIG.cupZ];
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec3): Vec3 => {
	const l = len(a) || 1;
	return mul(a, 1 / l);
};
const cross = (a: Vec3, b: Vec3): Vec3 => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
];

function basis(axis: Vec3): [Vec3, Vec3] {
	const tmp: Vec3 = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
	const u = norm(cross(axis, tmp));
	return [u, cross(axis, u)];
}

/** Angle between the two cup axes, in degrees. */
export function cupIncludedAngleDeg(): number {
	const d = Math.min(1, Math.max(-1, dot(cupAxis("R"), cupAxis("L"))));
	return (Math.acos(d) * 180) / Math.PI;
}

function bandPoint(angle: number, rm: number): Vec3 {
	return [rm * Math.cos(angle), HEADPHONE_RIG.bandCy + rm * Math.sin(angle), HEADPHONE_RIG.bandZ];
}

/** Band-end centreline to the cup's top, in radii. One straight span per side. */
export function joinLength(side: CupSide): number {
	const end = bandPoint(side === "R" ? HEADPHONE_RIG.bandA1 : HEADPHONE_RIG.bandA0, HEADPHONE_RIG.bandRm);
	const top = add(cupCenter(side), [0, -HEADPHONE_RIG.cupR * 0.95, 0]);
	return len(sub(top, end));
}

function minTorus(center: Vec3, axis: Vec3, major: number, tube: number): number {
	const [u, v] = basis(axis);
	let min = Infinity;
	for (let i = 0; i < 96; i++) {
		const t = (i / 96) * Math.PI * 2;
		const on = add(center, add(mul(u, Math.cos(t) * major), mul(v, Math.sin(t) * major)));
		min = Math.min(min, len(sub(on, mul(norm(on), tube))));
	}
	return min;
}

function minCylinder(center: Vec3, axis: Vec3, radius: number, half: number): number {
	const [u, v] = basis(axis);
	let min = Infinity;
	const steps = 16;
	for (let i = 0; i < steps; i++) {
		const h = -half + (2 * half * i) / (steps - 1);
		for (let j = 0; j < 48; j++) {
			const t = (j / 48) * Math.PI * 2;
			const p = add(add(center, mul(axis, h)), add(mul(u, Math.cos(t) * radius), mul(v, Math.sin(t) * radius)));
			min = Math.min(min, len(p));
		}
	}
	return min;
}

function minArc(rm: number, rt: number, a0: number, a1: number): number {
	let min = Infinity;
	for (let i = 0; i <= 72; i++) {
		const p = bandPoint(a0 + ((a1 - a0) * i) / 72, rm);
		min = Math.min(min, len(sub(p, mul(norm(p), rt))));
	}
	return min;
}

export interface HeadphoneClearance {
	pad: number;
	shell: number;
	plate: number;
	band: number;
	lining: number;
}

/** Nearest solid point of each part, in radii from the sphere centre. */
export function headphoneClearance(): HeadphoneClearance {
	const rig = HEADPHONE_RIG;
	let pad = Infinity;
	let shell = Infinity;
	let plate = Infinity;
	for (const side of ["L", "R"] as const) {
		const axis = cupAxis(side);
		const center = cupCenter(side);
		pad = Math.min(pad, minTorus(add(center, mul(axis, rig.padT)), axis, rig.padR, rig.padRt));
		const wall = add(center, mul(axis, rig.wallMid));
		shell = Math.min(
			shell,
			minCylinder(wall, axis, rig.cupR, rig.wallH),
			minTorus(wall, axis, rig.cupR, rig.wallRing),
		);
		plate = Math.min(
			plate,
			minCylinder(add(center, mul(axis, rig.cupHalf)), axis, rig.plateR + rig.plateLip, rig.plateHalf),
		);
	}
	return {
		pad,
		shell,
		plate,
		band: minArc(rig.bandRm, rig.bandRt, rig.bandA0, rig.bandA1),
		lining: minArc(rig.liningRm, rig.liningRt, rig.liningA0, rig.liningA1),
	};
}

export type DiscRole = "pad" | "shell" | "plate";

export interface HeadphoneDisc {
	side: CupSide;
	role: DiscRole;
	cx: number;
	cy: number;
	rx: number;
	ry: number;
}

export interface HeadphoneArch {
	role: "band" | "lining";
	d: string;
	width: number;
}

export interface HeadphoneJoin {
	side: CupSide;
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	width: number;
}

export interface HeadphoneFront {
	arches: HeadphoneArch[];
	joins: HeadphoneJoin[];
	/** Painter order: pad, then shell, then plate, per side. */
	discs: HeadphoneDisc[];
}

function screen(x: number, y: number, radius: number, centre: number): [number, number] {
	return [centre + x * radius, centre + y * radius];
}

function archPath(rm: number, a0: number, a1: number, radius: number, centre: number): string {
	const parts: string[] = [];
	const n = 36;
	for (let i = 0; i <= n; i++) {
		const p = bandPoint(a0 + ((a1 - a0) * i) / n, rm);
		const [x, y] = screen(p[0], p[1], radius, centre);
		parts.push(`${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`);
	}
	return parts.join("");
}

/**
 * Front-view art in shell-local pixels, before {@link HEADPHONE_SCALE}.
 * `radius` and `centre` are the painted shell (both FACE_BOX / 2 today).
 */
export function headphoneFront(radius: number, centre = radius): HeadphoneFront {
	const rig = HEADPHONE_RIG;
	const arches: HeadphoneArch[] = [
		{
			role: "band",
			d: archPath(rig.bandRm, rig.bandA0, rig.bandA1, radius, centre),
			width: 2 * rig.bandRt * radius,
		},
		{
			role: "lining",
			d: archPath(rig.liningRm, rig.liningA0, rig.liningA1, radius, centre),
			width: 2 * rig.liningRt * radius,
		},
	];
	const joins: HeadphoneJoin[] = [];
	const discs: HeadphoneDisc[] = [];
	const foreshorten = Math.abs(Math.cos(rig.cupTiltRad));
	for (const side of ["L", "R"] as const) {
		const end = bandPoint(side === "R" ? rig.bandA1 : rig.bandA0, rig.bandRm);
		const top = add(cupCenter(side), [0, -rig.cupR * 0.95, 0]);
		const [x1, y1] = screen(end[0], end[1], radius, centre);
		const [x2, y2] = screen(top[0], top[1], radius, centre);
		joins.push({ side, x1, y1, x2, y2, width: 2 * rig.bandRt * radius });
		const axis = cupAxis(side);
		const center = cupCenter(side);
		const layers: Array<[DiscRole, number, number]> = [
			["pad", rig.padT, rig.padR + rig.padRt],
			["shell", rig.wallMid, rig.cupR],
			["plate", rig.cupHalf, rig.plateR],
		];
		for (const [role, along, discR] of layers) {
			const [cx, cy] = screen(center[0] + axis[0] * along, center[1] + axis[1] * along, radius, centre);
			discs.push({
				side,
				role,
				cx,
				cy,
				rx: discR * foreshorten * radius,
				ry: discR * radius,
			});
		}
	}
	return { arches, joins, discs };
}

export interface HeadphoneBounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

/** Axis-aligned bounds of the scaled front view, in shell-local pixels. */
export function headphoneBounds(radius: number, centre = radius, scale = HEADPHONE_SCALE): HeadphoneBounds {
	const art = headphoneFront(radius, centre);
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	const grow = (x: number, y: number, pad: number): void => {
		const sx = centre + (x - centre) * scale;
		const sy = centre + (y - centre) * scale;
		const p = pad * scale;
		minX = Math.min(minX, sx - p);
		minY = Math.min(minY, sy - p);
		maxX = Math.max(maxX, sx + p);
		maxY = Math.max(maxY, sy + p);
	};
	for (const arch of art.arches) {
		const width = arch.width / 2;
		for (const token of arch.d.split(/(?=[ML])/)) {
			const nums = token
				.slice(1)
				.trim()
				.split(/[\s,]+/)
				.map(Number);
			if (nums.length >= 2) grow(nums[0], nums[1], width);
		}
	}
	for (const join of art.joins) {
		grow(join.x1, join.y1, join.width / 2);
		grow(join.x2, join.y2, join.width / 2);
	}
	for (const disc of art.discs) {
		grow(disc.cx - disc.rx, disc.cy, 0);
		grow(disc.cx + disc.rx, disc.cy, 0);
		grow(disc.cx, disc.cy - disc.ry, 0);
		grow(disc.cx, disc.cy + disc.ry, 0);
	}
	return { minX, minY, maxX, maxY };
}

/**
 * View padding that keeps the scaled cans inside the svg. The floors are the
 * previous rig's padding, so a smaller headset cannot shrink the stage.
 */
export function headphonePadding(box: number): { top: number; side: number; bottom: number } {
	const centre = box / 2;
	const b = headphoneBounds(centre, centre);
	const slack = 10;
	return {
		side: Math.max(20, Math.ceil(Math.max(-b.minX, b.maxX - box) + slack)),
		top: Math.max(24, Math.ceil(-b.minY + slack)),
		bottom: Math.max(22, Math.ceil(b.maxY - box + slack)),
	};
}
