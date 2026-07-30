import { expect, test } from "bun:test";
import * as path from "node:path";

const preloadPath = path.join(import.meta.dir, "fixtures", "computer-schema-construction-preload.ts");
const probePath = path.join(import.meta.dir, "fixtures", "computer-schema-construction-probe.ts");

test("computer schema is constructed once on first parameters access", async () => {
	const proc = Bun.spawn([process.execPath, "--preload", preloadPath, probePath], {
		cwd: path.join(import.meta.dir, "../../.."),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	expect(exitCode, stderr).toBe(0);
	expect(JSON.parse(stdout)).toEqual({
		counts: {
			afterModuleImport: 0,
			afterDefaultOffFactory: 0,
			afterToolConstruction: 0,
			afterFirstParametersAccess: 1,
			afterRepeatedParametersAccess: 1,
			afterSecondToolParametersAccess: 1,
			afterValidation: 1,
		},
		disabledToolCount: 0,
		schema: {
			callable: true,
			repeatedIdentity: true,
			crossToolIdentity: true,
			validAccepted: true,
			validOutput: {
				actions: [
					{ type: "click", x: 1, y: 2, button: "left", keys: null },
					{ type: "double_click", x: 3, y: 4 },
					{
						type: "drag",
						path: [
							{ x: 0, y: 0 },
							{ x: 9, y: 9 },
						],
					},
					{ type: "keypress", keys: ["CTRL", "A"] },
					{ type: "move", x: 5, y: 6 },
					{ type: "screenshot" },
					{ type: "scroll", x: 7, y: 8, scroll_x: -10, scroll_y: 20 },
					{ type: "type", text: "hello" },
					{ type: "wait" },
				],
			},
			invalidRejected: [true, true, true, true, true, true],
		},
	});
}, 20_000);
