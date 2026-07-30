import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { BUILTIN_TOOLS, ComputerTool, createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type as arkType } from "arktype";

declare global {
	var __computerCoordinateSchemaConstructionCount: number;
}

const count = () => globalThis.__computerCoordinateSchemaConstructionCount;
const toolSession = (settings: Settings): ToolSession =>
	({
		cwd: ".",
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	}) as ToolSession;

const counts = {
	afterModuleImport: count(),
	afterDefaultOffFactory: -1,
	afterToolConstruction: -1,
	afterFirstParametersAccess: -1,
	afterRepeatedParametersAccess: -1,
	afterSecondToolParametersAccess: -1,
	afterValidation: -1,
};

const disabledTools = await createTools(toolSession(Settings.isolated()), ["computer"]);
counts.afterDefaultOffFactory = count();

const firstTool = await BUILTIN_TOOLS.computer(toolSession(Settings.isolated()));
const secondTool = await BUILTIN_TOOLS.computer(toolSession(Settings.isolated()));
if (!(firstTool instanceof ComputerTool) || !(secondTool instanceof ComputerTool)) {
	throw new Error("Expected the built-in computer factory to construct ComputerTool instances");
}
counts.afterToolConstruction = count();

const firstSchema = firstTool.parameters;
counts.afterFirstParametersAccess = count();
const repeatedSchema = firstTool.parameters;
counts.afterRepeatedParametersAccess = count();
const secondToolSchema = secondTool.parameters;
counts.afterSecondToolParametersAccess = count();

const validInput = {
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
};
const validOutput = firstSchema(validInput);
const invalidOutputs = [
	firstSchema({ actions: [{ type: "click", x: -1, y: 2, button: "left" }] }),
	firstSchema({ actions: [{ type: "move", x: 0.5, y: 0 }] }),
	firstSchema({ actions: [{ type: "scroll", x: 0, y: 0, scroll_x: 2 ** 31, scroll_y: 0 }] }),
	firstSchema({ actions: [{ type: "drag", path: [{ x: 0, y: 0 }] }] }),
	firstSchema({
		actions: [
			{
				type: "drag",
				path: [
					{ x: 0, y: 0, label: "unexpected" },
					{ x: 1, y: 1 },
				],
			},
		],
	}),
	firstSchema({ actions: [], unexpected: true }),
];
counts.afterValidation = count();

await Promise.all([firstTool.close(), secondTool.close()]);

process.stdout.write(
	JSON.stringify({
		counts,
		disabledToolCount: disabledTools.length,
		schema: {
			callable: typeof firstSchema === "function",
			repeatedIdentity: firstSchema === repeatedSchema,
			crossToolIdentity: firstSchema === secondToolSchema,
			validAccepted: !(validOutput instanceof arkType.errors),
			validOutput,
			invalidRejected: invalidOutputs.map(output => output instanceof arkType.errors),
		},
	}),
);
