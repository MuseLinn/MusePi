const fs = require("node:fs");
const path = require("node:path");

const STANDARD_STATES = new Set([
	"idle",
	"running_left",
	"running_right",
	"working",
	"waiting",
	"failed",
	"idle_random_1",
	"idle_random_2",
]);
const ONE_SHOT_STATES = new Set(["idle_random_1", "idle_random_2"]);

function positiveInteger(value, maximum) {
	return Number.isInteger(value) && value > 0 && value <= maximum;
}

function readAtlas(meta) {
	if (meta.atlas === undefined && meta.states === undefined) return { format: "sheet" };
	const source = meta.atlas;
	if (typeof source !== "object" || source === null || Array.isArray(source)) return null;
	const atlas = {
		frameWidth: source.frameWidth,
		frameHeight: source.frameHeight,
		rows: source.rows,
		columns: source.columns,
	};
	if (
		!positiveInteger(atlas.frameWidth, 8192) ||
		!positiveInteger(atlas.frameHeight, 8192) ||
		!positiveInteger(atlas.rows, 64) ||
		!positiveInteger(atlas.columns, 64)
	) {
		return null;
	}
	if (typeof meta.states !== "object" || meta.states === null || Array.isArray(meta.states)) return null;
	const states = {};
	for (const [name, state] of Object.entries(meta.states)) {
		if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name) || typeof state !== "object" || state === null) return null;
		const fps = state.fps === undefined ? 8 : state.fps;
		if (
			!Number.isInteger(state.row) ||
			state.row < 0 ||
			state.row >= atlas.rows ||
			!positiveInteger(state.frames, atlas.columns) ||
			typeof fps !== "number" ||
			!Number.isFinite(fps) ||
			fps <= 0 ||
			fps > 60 ||
			(state.loop !== undefined && typeof state.loop !== "boolean")
		) {
			return null;
		}
		states[name] = {
			row: state.row,
			frames: state.frames,
			fps,
			loop: state.loop ?? (!STANDARD_STATES.has(name) || ONE_SHOT_STATES.has(name) ? false : true),
		};
	}
	if (!states.idle) return null;
	return { format: "atlas", atlas, states };
}

function containedFile(root, relative) {
	if (typeof relative !== "string" || !relative.trim()) return null;
	const rootPath = path.resolve(root);
	const candidate = path.resolve(rootPath, relative);
	const outside = value => {
		const rel = path.relative(rootPath, value);
		return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
	};
	if (outside(candidate) || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null;
	const realRoot = fs.realpathSync(rootPath);
	const realCandidate = fs.realpathSync(candidate);
	const realRelative = path.relative(realRoot, realCandidate);
	if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) return null;
	return realCandidate;
}

function readPetPackage(dir, fallbackName) {
	let meta;
	try {
		meta = JSON.parse(fs.readFileSync(path.join(dir, "pet.json"), "utf8"));
	} catch {
		return { error: "invalid-petdex" };
	}
	if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return { error: "invalid-petdex" };
	const animation = readAtlas(meta);
	if (!animation) return { error: "invalid-pet-atlas" };
	const spritesheetRel =
		typeof meta.spritesheetPath === "string"
			? meta.spritesheetPath
			: typeof meta.spritesheet === "string"
				? meta.spritesheet
				: "spritesheet.webp";
	let sheetPath;
	try {
		sheetPath = containedFile(dir, spritesheetRel);
	} catch {
		return { error: "invalid-spritesheet-path" };
	}
	if (!sheetPath) {
		const root = path.resolve(dir);
		const candidate = path.resolve(root, spritesheetRel);
		const relative = path.relative(root, candidate);
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			return { error: "invalid-spritesheet-path" };
		}
		return { error: "missing-spritesheet" };
	}
	const ext = path.extname(sheetPath).toLowerCase();
	const mime = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : "image/webp";
	return {
		id: typeof meta.id === "string" && meta.id ? meta.id : `pet-${Date.now()}`,
		displayName:
			typeof meta.displayName === "string" && meta.displayName
				? meta.displayName
				: typeof meta.name === "string" && meta.name
					? meta.name
					: fallbackName,
		description: typeof meta.description === "string" ? meta.description : null,
		spritesheet: `data:${mime};base64,${fs.readFileSync(sheetPath).toString("base64")}`,
		...animation,
		...(typeof meta.theme === "object" && meta.theme !== null && !Array.isArray(meta.theme)
			? { theme: meta.theme }
			: {}),
	};
}

module.exports = { readPetPackage };
