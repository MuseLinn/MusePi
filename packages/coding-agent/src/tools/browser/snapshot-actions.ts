import { ToolError } from "../tool-errors";
import { type BrowserElementsSnapshot, type BrowserVisualSnapshot, visualPointToCss } from "./snapshots";

export type SnapshotAction =
	| "click"
	| "click_if_interactive"
	| "visual_type"
	| "fill"
	| "type"
	| "press"
	| "hover"
	| "scroll"
	| "drag"
	| "drag_path"
	| "select_option"
	| "set_checked"
	| "scroll_into_view";

export interface SnapshotActionParams {
	action: SnapshotAction;
	snapshotId?: string;
	ref?: string;
	x?: number;
	y?: number;
	deltaX?: number;
	deltaY?: number;
	from?: { x: number; y: number };
	to?: { x: number; y: number };
	points?: Array<{ x: number; y: number }>;
	button?: "left" | "right" | "middle";
	durationMs?: number;
	modifiers?: Array<"Alt" | "Control" | "Meta" | "Shift">;
	text?: string;
	key?: string;
	value?: string;
	checked?: boolean;
	replace?: boolean;
	radius?: number;
}

export interface BrowserVisualInteraction {
	outcome: "clicked" | "candidates";
	target?: { x: number; y: number; role: string; name: string };
	candidates: Array<{ x: number; y: number; role: string; name: string; distance: number }>;
}

function observationId(snapshot: BrowserElementsSnapshot | undefined, params: SnapshotActionParams): number {
	if (!snapshot) throw new ToolError(`Action ${params.action} requires an element snapshotId`);
	if (params.snapshotId !== snapshot.snapshotId)
		throw new ToolError("Action snapshotId does not match the resolved snapshot");
	if (!params.ref) throw new ToolError(`Action ${params.action} requires an element ref`);
	const match = /^e(\d+)$/.exec(params.ref);
	if (!match) throw new ToolError(`Invalid element ref ${JSON.stringify(params.ref)}`);
	const id = Number(match[1]);
	if (!snapshot.elements.some(element => element.id === id)) {
		throw new ToolError(`Element ref ${params.ref} is not present in snapshot ${snapshot.snapshotId}`);
	}
	return id;
}

function visualSnapshot(
	snapshot: BrowserVisualSnapshot | undefined,
	params: SnapshotActionParams,
): BrowserVisualSnapshot {
	if (!snapshot) throw new ToolError(`Action ${params.action} requires a visual snapshotId`);
	if (params.snapshotId !== snapshot.snapshotId)
		throw new ToolError("Action snapshotId does not match the resolved snapshot");
	return snapshot;
}

function point(
	snapshot: BrowserVisualSnapshot,
	x: number | undefined,
	y: number | undefined,
): { x: number; y: number } {
	if (x === undefined || y === undefined) throw new ToolError("Visual action requires both x and y coordinates");
	return visualPointToCss(snapshot, { x, y });
}

function keyboardCode(key: string | undefined): string {
	if (!key) throw new ToolError("Keyboard action requires key");
	const parts = key.split("+").filter(Boolean);
	if (parts.length === 0) throw new ToolError("Keyboard action requires key");
	const last = parts.pop()!;
	return [
		...parts.map(part => `await page.keyboard.down(${JSON.stringify(part)});`),
		`await page.keyboard.press(${JSON.stringify(last)});`,
		...parts.reverse().map(part => `await page.keyboard.up(${JSON.stringify(part)});`),
	].join("\n");
}

/** Compile one explicit snapshot action into the existing run scope. */
export function snapshotActionCode(
	params: SnapshotActionParams,
	elements?: BrowserElementsSnapshot,
	visual?: BrowserVisualSnapshot,
): string {
	let body: string;
	switch (params.action) {
		case "click": {
			if (params.ref) {
				const id = observationId(elements, params);
				body = `const handle = await tab.id(${id}); await handle.click();`;
				break;
			}
			const snapshot = visualSnapshot(visual, params);
			const target = point(snapshot, params.x, params.y);
			body = `await page.mouse.click(${target.x},${target.y});`;
			break;
		}
		case "click_if_interactive": {
			const snapshot = visualSnapshot(visual, params);
			const target = point(snapshot, params.x, params.y);
			const radius = params.radius ?? 48;
			if (!Number.isInteger(radius) || radius < 8 || radius > 128) {
				throw new ToolError("Interactive click radius must be between 8 and 128");
			}
			body = `const inspection = await tab.evaluate(({ x, y, radius }) => {
				const interactive = element => element.matches("a[href],button,input,select,textarea,[role='button'],[role='link'],[role='checkbox'],[role='radio'],[role='menuitem'],[role='tab'],[onclick],[tabindex]:not([tabindex='-1'])");
				const describe = element => {
					const rect = element.getBoundingClientRect();
					return {
						x: Math.round((rect.x + rect.width / 2) * ${snapshot.image.width / snapshot.viewport.width}),
						y: Math.round((rect.y + rect.height / 2) * ${snapshot.image.height / snapshot.viewport.height}),
						role: element.getAttribute("role") ?? element.tagName.toLowerCase(),
						name: (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().replace(/\\s+/g, " ").slice(0, 120),
					};
				};
				const exact = document.elementsFromPoint(${target.x},${target.y}).find(interactive);
				if (exact) return { clicked: true, target: describe(exact) };
				const candidates = Array.from(document.querySelectorAll("a[href],button,input,select,textarea,[role='button'],[role='link'],[role='checkbox'],[role='radio'],[role='menuitem'],[role='tab'],[onclick],[tabindex]:not([tabindex='-1'])"))
					.map(element => {
						const item = describe(element);
						return { ...item, distance: Math.round(Math.hypot(item.x - ${params.x}, item.y - ${params.y})) };
					})
					.filter(item => item.distance <= radius)
					.sort((a, b) => a.distance - b.distance)
					.slice(0, 8);
				return { clicked: false, candidates };
			}, { x: ${target.x}, y: ${target.y}, radius: ${radius} });
			if (inspection.clicked) {
				await page.mouse.click(${target.x},${target.y});
				return { outcome: "clicked", target: inspection.target };
			}
			return { outcome: "candidates", candidates: inspection.candidates };`;
			break;
		}
		case "visual_type": {
			if (typeof params.text !== "string") throw new ToolError("Visual type action requires text");
			const snapshot = visualSnapshot(visual, params);
			const target = point(snapshot, params.x, params.y);
			body = `await page.mouse.click(${target.x},${target.y});\n${params.replace ? 'const selectAllModifier = await tab.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control"); await page.keyboard.down(selectAllModifier); await page.keyboard.press("A"); await page.keyboard.up(selectAllModifier);\n' : ""}await page.keyboard.type(${JSON.stringify(params.text)});\nreturn { ok: true };`;
			break;
		}
		case "fill": {
			if (typeof params.text !== "string") throw new ToolError("Fill action requires text");
			const id = observationId(elements, params);
			body = `const handle = await tab.id(${id}); await handle.fill(${JSON.stringify(params.text)});`;
			break;
		}
		case "type": {
			if (typeof params.text !== "string") throw new ToolError("Type action requires text");
			const id = observationId(elements, params);
			body = `const handle = await tab.id(${id}); ${params.replace ? `await handle.fill(${JSON.stringify(params.text)});` : `await handle.type(${JSON.stringify(params.text)});`}`;
			break;
		}
		case "press": {
			if (params.ref) {
				const id = observationId(elements, params);
				body = `const handle = await tab.id(${id}); await handle.focus();\n${keyboardCode(params.key)}`;
			} else if (params.x !== undefined && params.y !== undefined) {
				const snapshot = visualSnapshot(visual, params);
				const target = point(snapshot, params.x, params.y);
				body = `await page.mouse.click(${target.x},${target.y});\n${keyboardCode(params.key)}`;
			} else {
				body = keyboardCode(params.key);
			}
			break;
		}
		case "hover": {
			if (params.ref) {
				const id = observationId(elements, params);
				body = `const handle = await tab.id(${id}); await handle.hover();`;
				break;
			}
			const snapshot = visualSnapshot(visual, params);
			const target = point(snapshot, params.x, params.y);
			body = `await page.mouse.move(${target.x},${target.y});`;
			break;
		}
		case "scroll": {
			const snapshot = visualSnapshot(visual, params);
			const origin =
				params.x !== undefined || params.y !== undefined ? point(snapshot, params.x, params.y) : { x: 0, y: 0 };
			const deltaX = ((params.deltaX ?? 0) * snapshot.viewport.width) / snapshot.image.width;
			const deltaY = ((params.deltaY ?? 0) * snapshot.viewport.height) / snapshot.image.height;
			body = `await page.mouse.move(${origin.x},${origin.y}); await page.mouse.wheel({ deltaX: ${deltaX}, deltaY: ${deltaY} });`;
			break;
		}
		case "drag": {
			const snapshot = visualSnapshot(visual, params);
			if (!params.from || !params.to) throw new ToolError("Drag action requires from and to points");
			const from = point(snapshot, params.from.x, params.from.y);
			const to = point(snapshot, params.to.x, params.to.y);
			body = `await page.mouse.move(${from.x},${from.y}); await page.mouse.down(); await page.mouse.move(${to.x},${to.y}, { steps: 12 }); await page.mouse.up();`;
			break;
		}
		case "drag_path": {
			const snapshot = visualSnapshot(visual, params);
			if (!params.points || params.points.length < 2 || params.points.length > 500) {
				throw new ToolError("Drag path requires 2–500 points");
			}
			const points = params.points.map(entry => point(snapshot, entry.x, entry.y));
			const durationMs = params.durationMs;
			if (durationMs !== undefined && (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > 20_000)) {
				throw new ToolError("Drag path durationMs must be an integer between 0 and 20000");
			}
			const button = params.button ?? "left";
			if (!["left", "right", "middle"].includes(button)) throw new ToolError("Invalid drag path button");
			const modifiers = params.modifiers ?? [];
			const allowed = new Set(["Alt", "Control", "Meta", "Shift"]);
			if (
				modifiers.length > 4 ||
				new Set(modifiers).size !== modifiers.length ||
				modifiers.some(modifier => !allowed.has(modifier))
			) {
				throw new ToolError("Drag path modifiers must be unique Alt, Control, Meta or Shift keys");
			}
			const down = modifiers.map(modifier => `await page.keyboard.down(${JSON.stringify(modifier)});`).join("\n");
			const up = modifiers
				.slice()
				.reverse()
				.map(modifier => `await page.keyboard.up(${JSON.stringify(modifier)});`)
				.join("\n");
			body = `try {
	${down}
	const path = ${JSON.stringify(points.map(entry => [entry.x, entry.y]))};
	const durationMs = ${durationMs ?? "undefined"};
	await page.mouse.move(path[0][0], path[0][1]);
	await page.mouse.down({ button: ${JSON.stringify(button)} });
	const segments = [];
	let totalSteps = 0;
	for (let index = 1; index < path.length; index++) {
		const from = path[index - 1];
		const to = path[index];
		const steps = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / 4));
		totalSteps += steps;
		segments.push({ to, steps });
	}
	const totalDurationMs = durationMs ?? Math.min(5000, totalSteps * 8);
	const delayMs = totalSteps > 0 ? totalDurationMs / totalSteps : 0;
	for (const segment of segments) {
		await page.mouse.move(segment.to[0], segment.to[1], { steps: segment.steps });
		if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
	}
} finally {
	await page.mouse.up({ button: ${JSON.stringify(button)} }).catch(() => undefined);
	${up}
}`;
			break;
		}
		case "select_option": {
			if (typeof params.value !== "string") throw new ToolError("Select action requires value");
			const id = observationId(elements, params);
			body = `const handle = await tab.id(${id}); await handle.select(${JSON.stringify(params.value)});`;
			break;
		}
		case "set_checked": {
			if (typeof params.checked !== "boolean") throw new ToolError("Checked action requires a boolean");
			const id = observationId(elements, params);
			body = `const handle = await tab.id(${id}); await handle.evaluate((el, next) => { el.checked = next; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); }, ${params.checked});`;
			break;
		}
		case "scroll_into_view": {
			const id = observationId(elements, params);
			body = `const handle = await tab.id(${id}); await handle.evaluate(el => el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" }));`;
			break;
		}
	}
	return `${body}\nreturn { ok: true };`;
}
