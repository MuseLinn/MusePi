import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import type { ComputerAction, ComputerSafetyCheck, ComputerToolCallMetadata, Model } from "@oh-my-pi/pi-ai";
import { isClaudeModelId } from "@oh-my-pi/pi-catalog/identity";
import type {
	DesktopAction,
	DesktopCapabilities,
	DesktopCapture,
	DesktopDisplay,
	DesktopSessionOptions,
} from "@oh-my-pi/pi-natives";
import { once, prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import { type Type, type } from "arktype";
import computerDescription from "../prompts/tools/computer.md" with { type: "text" };
import { truncateForPrompt } from "./approval";
import { type ComputerController, ComputerSupervisor, registerComputerController } from "./computer/supervisor";
import type { ToolSession } from "./index";
import { ToolError, throwIfAborted } from "./tool-errors";

// Image transports that cannot preserve native screenshot detail resize frames
// without returning transformed dimensions. Keep their native coordinate frames
// below the empirically verified threshold so pointer actions match what the
// model sees. Claude paths predate the resolved transport capability and retain
// their established model-family fallback.
const COORDINATE_SAFE_MAX_CAPTURE_WIDTH = 1280;
const COORDINATE_SAFE_MAX_CAPTURE_HEIGHT = 896;

function usesCoordinateSafeImageSizing(model: Model | undefined): boolean {
	if (!model) return false;
	const compat = model.compat;
	return (
		(!!compat && "supportsImageDetailOriginal" in compat && compat.supportsImageDetailOriginal === false) ||
		isClaudeModelId(model.id) ||
		(model.requestModelId !== undefined && isClaudeModelId(model.requestModelId)) ||
		(typeof model.name === "string" && /^claude(?:\s|$)/i.test(model.name))
	);
}

function captureOptions(session: ToolSession, coordinateSafeImageSizing: boolean): DesktopSessionOptions {
	const maxWidth = session.settings.get("computer.maxWidth");
	const maxHeight = session.settings.get("computer.maxHeight");
	return {
		backend: session.settings.get("computer.backend"),
		display: session.settings.get("computer.display"),
		maxWidth: coordinateSafeImageSizing ? Math.min(maxWidth, COORDINATE_SAFE_MAX_CAPTURE_WIDTH) : maxWidth,
		maxHeight: coordinateSafeImageSizing ? Math.min(maxHeight, COORDINATE_SAFE_MAX_CAPTURE_HEIGHT) : maxHeight,
	};
}

// Desktop actions cross the N-API boundary as i32; out-of-range JS numbers
// must fail closed here instead of truncating in the napi conversion.
const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

type ComputerSchemaPoint = {
	x: number;
	y: number;
};

type ComputerSchemaAction = {
	type: ComputerAction["type"];
	x?: number;
	y?: number;
	button?: "left" | "right" | "wheel" | "back" | "forward";
	path?: ComputerSchemaPoint[];
	keys?: string[] | null;
	scroll_x?: number;
	scroll_y?: number;
	text?: string;
};

export type ComputerParams = {
	actions?: ComputerSchemaAction[];
};

type IsSameType<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;
type ComputerSchema<Schema extends Type = Type<ComputerParams>> =
	IsSameType<ComputerParams, Schema["infer"]> extends true ? Schema : never;

const getComputerSchema: () => ComputerSchema = once(() => {
	const coordinateSchema = type("0 <= number.integer <= 2147483647");
	const scrollDeltaSchema = type("-2147483648 <= number.integer <= 2147483647");

	const pointSchema = type({
		x: coordinateSchema.describe("x pixel coordinate"),
		y: coordinateSchema.describe("y pixel coordinate"),
		"+": "reject",
	});

	const computerActionSchema = type({
		type: type(
			"'click' | 'double_click' | 'drag' | 'keypress' | 'move' | 'screenshot' | 'scroll' | 'type' | 'wait'",
		).describe("action kind"),
		"x?": coordinateSchema.describe(
			"x pixel coordinate in the most recent screenshot (click, double_click, move, scroll)",
		),
		"y?": coordinateSchema.describe(
			"y pixel coordinate in the most recent screenshot (click, double_click, move, scroll)",
		),
		"button?": type("'left' | 'right' | 'wheel' | 'back' | 'forward'").describe("mouse button; required for click"),
		"path?": pointSchema.array().atLeastLength(2).describe("waypoints from press to release; required for drag"),
		"keys?": type("string[] | null").describe(
			"key names (e.g. CTRL, SHIFT, ENTER, A); required chord for keypress, optional held modifiers for pointer actions",
		),
		"scroll_x?": scrollDeltaSchema.describe("horizontal scroll delta in pixels; required for scroll"),
		"scroll_y?": scrollDeltaSchema.describe(
			"vertical scroll delta in pixels, positive scrolls content down; required for scroll",
		),
		"text?": type("string").describe("literal text to type; required for type"),
		"+": "reject",
	});

	const computerSchema = type({
		"actions?": computerActionSchema
			.array()
			.describe("ordered actions executed as one batch; omit or pass [] to just capture a screenshot"),
		"+": "reject",
	});
	return computerSchema satisfies ComputerSchema<typeof computerSchema>;
});

export interface ComputerToolDetails {
	width: number;
	height: number;
	backend: DesktopCapture["backend"];
	displayServer?: string;
	capturePermission: string;
	inputPermission: string;
	displays: DesktopDisplay[];
	capabilities?: DesktopCapabilities;
	actions: ComputerAction["type"][];
}

export type ComputerControllerFactory = (options: DesktopSessionOptions) => ComputerController;

function isInt32(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX;
}

function isCoordinate(value: unknown): value is number {
	return isInt32(value) && value >= 0;
}

type AllowedFields = Record<string, true>;

const POINT_FIELDS: AllowedFields = { x: true, y: true };
const MOUSE_BUTTONS: AllowedFields = { left: true, right: true, wheel: true, back: true, forward: true };
const ACTION_FIELDS: Record<ComputerAction["type"], AllowedFields> = {
	click: { type: true, button: true, x: true, y: true, keys: true },
	double_click: { type: true, x: true, y: true, keys: true },
	drag: { type: true, path: true, keys: true },
	keypress: { type: true, keys: true },
	move: { type: true, x: true, y: true, keys: true },
	screenshot: { type: true },
	scroll: { type: true, x: true, y: true, scroll_x: true, scroll_y: true, keys: true },
	type: { type: true, text: true },
	wait: { type: true },
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fieldsForAction(actionType: string): AllowedFields | undefined {
	switch (actionType) {
		case "click":
		case "double_click":
		case "drag":
		case "keypress":
		case "move":
		case "screenshot":
		case "scroll":
		case "type":
		case "wait":
			return ACTION_FIELDS[actionType];
		default:
			return undefined;
	}
}

function hasOnlyFields(value: Record<string, unknown>, allowed: AllowedFields): boolean {
	return Object.keys(value).every(key => allowed[key] === true);
}

function isPoint(value: unknown): value is { x: number; y: number } {
	return isRecord(value) && hasOnlyFields(value, POINT_FIELDS) && isCoordinate(value.x) && isCoordinate(value.y);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

function modifierBit(value: string): number {
	switch (value.trim().toUpperCase()) {
		case "CTRL":
		case "CONTROL":
			return 1;
		case "SHIFT":
			return 2;
		case "ALT":
		case "OPTION":
			return 4;
		case "META":
		case "CMD":
		case "COMMAND":
		case "SUPER":
		case "WINDOWS":
			return 8;
		default:
			return 0;
	}
}

function isModifierArray(value: unknown): value is string[] | null | undefined {
	if (value == null) return true;
	if (!isStringArray(value)) return false;
	let seen = 0;
	for (const entry of value) {
		for (const component of entry.split("+")) {
			const bit = modifierBit(component);
			if (bit === 0 || (seen & bit) !== 0) return false;
			seen |= bit;
		}
	}
	return true;
}

function isKeypressArray(value: unknown): value is string[] {
	return (
		isStringArray(value) &&
		value.length > 0 &&
		value.every(key => key.split("+").every(component => component.trim().length > 0))
	);
}

function isComputerAction(value: unknown): value is ComputerAction {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	const action = value;
	const actionType = value.type;
	const allowed = fieldsForAction(actionType);
	if (!allowed || !hasOnlyFields(action, allowed)) return false;
	switch (actionType) {
		case "click":
			return (
				isCoordinate(action.x) &&
				isCoordinate(action.y) &&
				typeof action.button === "string" &&
				MOUSE_BUTTONS[action.button] === true &&
				isModifierArray(action.keys)
			);
		case "double_click":
			return isCoordinate(action.x) && isCoordinate(action.y) && isModifierArray(action.keys);
		case "drag":
			return (
				Array.isArray(action.path) &&
				action.path.length >= 2 &&
				action.path.every(isPoint) &&
				isModifierArray(action.keys)
			);
		case "keypress":
			return isKeypressArray(action.keys);
		case "move":
			return isCoordinate(action.x) && isCoordinate(action.y) && isModifierArray(action.keys);
		case "screenshot":
		case "wait":
			return true;
		case "scroll":
			return (
				isCoordinate(action.x) &&
				isCoordinate(action.y) &&
				isInt32(action.scroll_x) &&
				isInt32(action.scroll_y) &&
				isModifierArray(action.keys)
			);
		case "type":
			return typeof action.text === "string";
		default:
			return false;
	}
}

function parseActions(value: unknown): ComputerAction[] {
	// Missing or empty action batches degrade to a plain screenshot so a
	// function-calling model can observe the screen before acting.
	if (value == null) return [{ type: "screenshot" }];
	if (!Array.isArray(value)) throw new ToolError("Computer call requires an array of actions");
	if (value.length === 0) return [{ type: "screenshot" }];
	if (!value.every(isComputerAction)) throw new ToolError("Computer call contains an invalid action");
	return value;
}

function toDesktopAction(action: ComputerAction): DesktopAction {
	switch (action.type) {
		case "click":
			return {
				type: "click",
				x: action.x,
				y: action.y,
				button: action.button,
				...(action.keys ? { keys: action.keys } : {}),
			};
		case "double_click":
			return {
				type: "double_click",
				x: action.x,
				y: action.y,
				...(action.keys ? { keys: action.keys } : {}),
			};
		case "drag":
			return { type: "drag", path: action.path, ...(action.keys ? { keys: action.keys } : {}) };
		case "keypress":
			return { type: "keypress", keys: action.keys };
		case "move":
			return { type: "move", x: action.x, y: action.y, ...(action.keys ? { keys: action.keys } : {}) };
		case "screenshot":
			return { type: "screenshot" };
		case "scroll":
			return {
				type: "scroll",
				x: action.x,
				y: action.y,
				scroll_x: action.scroll_x,
				scroll_y: action.scroll_y,
				...(action.keys ? { keys: action.keys } : {}),
			};
		case "type":
			return { type: "type", text: action.text };
		case "wait":
			return { type: "wait" };
	}
}

function callMetadata(context: AgentToolContext | undefined): ComputerToolCallMetadata | undefined {
	const metadata = context?.toolCall?.providerMetadata;
	return metadata?.type === "computer" ? metadata : undefined;
}

export function computerApproval(args: unknown): ToolApprovalDecision {
	const actions =
		args && typeof args === "object" && "actions" in args ? (args as { actions?: unknown }).actions : undefined;
	if (actions == null) return "read";
	if (!Array.isArray(actions)) return "exec";
	return actions.every(action => {
		if (!action || typeof action !== "object") return false;
		const actionType = (action as { type?: unknown }).type;
		return actionType === "screenshot" || actionType === "wait";
	})
		? "read"
		: "exec";
}

function modifierSummary(keys: unknown): string {
	return isStringArray(keys) && keys.length > 0 ? ` keys=${JSON.stringify(keys)}` : "";
}

function approvalActionSummary(actions: unknown): string[] {
	if (!Array.isArray(actions)) return ["Actions: unavailable"];
	const lines = actions.slice(0, 12).map((value, index) => {
		if (!value || typeof value !== "object") return `${index + 1}. invalid`;
		const action = value as Record<string, unknown>;
		const type = typeof action.type === "string" ? action.type : "invalid";
		let detail: string;
		switch (type) {
			case "click":
				detail = `click button=${String(action.button)} at (${String(action.x)}, ${String(action.y)})${modifierSummary(action.keys)}`;
				break;
			case "double_click":
				detail = `double_click at (${String(action.x)}, ${String(action.y)})${modifierSummary(action.keys)}`;
				break;
			case "drag":
				detail = `drag path=${Array.isArray(action.path) ? action.path.map(point => (isPoint(point) ? `(${point.x}, ${point.y})` : "invalid")).join(" -> ") : "invalid"}${modifierSummary(action.keys)}`;
				break;
			case "keypress":
				detail = `keypress keys=${JSON.stringify(action.keys)}`;
				break;
			case "move":
				detail = `move to (${String(action.x)}, ${String(action.y)})${modifierSummary(action.keys)}`;
				break;
			case "scroll":
				detail = `scroll at (${String(action.x)}, ${String(action.y)}) delta=(${String(action.scroll_x)}, ${String(action.scroll_y)})${modifierSummary(action.keys)}`;
				break;
			case "type":
				detail = `type text=${JSON.stringify(action.text)}`;
				break;
			case "screenshot":
			case "wait":
				detail = type;
				break;
			default:
				detail = type;
		}
		return truncateForPrompt(sanitizeText(`${index + 1}. ${detail}`).replace(/[\r\n\t]+/g, " "), 240);
	});
	if (actions.length > 12) lines.push(`+${actions.length - 12} more actions`);
	return truncateForPrompt(lines.join("\n"), 2_000).split("\n");
}

export class ComputerTool implements AgentTool<ComputerSchema, ComputerToolDetails> {
	readonly name = "computer";
	readonly native = { type: "computer" } as const;
	readonly label = "Computer";
	readonly loadMode = "essential" as const;
	readonly concurrency = "exclusive" as const;
	readonly summary = "Capture and control the host desktop through native OS APIs";
	get parameters(): ComputerSchema {
		return getComputerSchema();
	}
	readonly strict = false;
	readonly approval = computerApproval;
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const actions = args && typeof args === "object" ? (args as { actions?: unknown }).actions : undefined;
		return approvalActionSummary(actions);
	};
	/**
	 * Settings snapshot used to create the tool's current controller; refreshed
	 * when a model switch crosses the coordinate-safe sizing boundary. Surfaced
	 * by `/computer status`.
	 */
	effectiveConfiguration: Readonly<DesktopSessionOptions>;
	readonly #createController: ComputerControllerFactory;
	#controller: ComputerController;
	#unregisterOwner: () => void;
	#usesCoordinateSafeImageSizing: boolean;
	#closed = false;
	#description?: string;

	constructor(
		readonly session: ToolSession,
		createController: ComputerControllerFactory = options => new ComputerSupervisor(options),
	) {
		this.#createController = createController;
		this.#usesCoordinateSafeImageSizing = usesCoordinateSafeImageSizing(session.getActiveModel?.());
		this.effectiveConfiguration = Object.freeze(captureOptions(session, this.#usesCoordinateSafeImageSizing));
		this.#controller = createController(this.effectiveConfiguration);
		this.#unregisterOwner = registerComputerController(
			session.getEvalKernelOwnerId?.() ?? undefined,
			this.#controller,
		);
	}
	get description(): string {
		this.#description ??= prompt.render(computerDescription);
		return this.#description;
	}

	async #refreshControllerForModel(): Promise<void> {
		const nextUsesCoordinateSafeImageSizing = usesCoordinateSafeImageSizing(this.session.getActiveModel?.());
		if (nextUsesCoordinateSafeImageSizing === this.#usesCoordinateSafeImageSizing) return;

		const previous = this.#controller;
		const nextOptions = Object.freeze(captureOptions(this.session, nextUsesCoordinateSafeImageSizing));
		const next = this.#createController(nextOptions);
		this.#unregisterOwner();
		this.#controller = next;
		this.#unregisterOwner = registerComputerController(this.session.getEvalKernelOwnerId?.() ?? undefined, next);
		this.#usesCoordinateSafeImageSizing = nextUsesCoordinateSafeImageSizing;
		this.effectiveConfiguration = nextOptions;
		await previous.close();
	}

	async execute(
		_toolCallId: string,
		params: ComputerParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ComputerToolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<ComputerToolDetails>> {
		throwIfAborted(signal);
		if (this.#closed) throw new ToolError("Computer session is closed");
		const metadata = callMetadata(context);
		const actions = parseActions(metadata?.actions ?? params.actions);
		const pendingSafetyChecks: ComputerSafetyCheck[] = metadata?.pendingSafetyChecks ?? [];
		if (pendingSafetyChecks.length > 0 && context?.providerSafetyApproved !== true) {
			throw new ToolError("Provider safety checks require interactive approval before computer input");
		}
		await this.#refreshControllerForModel();
		throwIfAborted(signal);
		const capture = await this.#controller.execute(actions.map(toDesktopAction), signal);
		throwIfAborted(signal);
		const data = Buffer.from(capture.data).toBase64();
		return {
			content: [{ type: "image", data, mimeType: "image/png", detail: "original" }],
			details: {
				width: capture.width,
				height: capture.height,
				backend: capture.backend,
				displayServer: capture.displayServer,
				capturePermission: capture.capturePermission,
				inputPermission: capture.inputPermission,
				displays: capture.displays,
				capabilities: this.#controller.capabilities,
				actions: actions.map(action => action.type),
			},
			...(metadata
				? {
						providerMetadata: {
							type: "computer" as const,
							screenshot: { type: "computer_screenshot" as const, image_url: `data:image/png;base64,${data}` },
							acknowledgedSafetyChecks: pendingSafetyChecks,
						},
					}
				: {}),
		};
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#unregisterOwner();
		await this.#controller.close();
	}
}
