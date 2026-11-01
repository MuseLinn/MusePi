import type { AgentToolResult } from "@musepi/pi-agent-core";
import type { ExtensionAPI, ToolDefinition } from "../../extensibility/extensions/types";
import type { AndroidDeviceService } from "./android-service";

interface AndroidToolParams {
	action:
		| "devices"
		| "start"
		| "screenshot"
		| "tap"
		| "swipe"
		| "key"
		| "text"
		| "ui_tree"
		| "install"
		| "launch"
		| "logcat";
	device?: string;
	avd?: string;
	x?: number;
	y?: number;
	x2?: number;
	y2?: number;
	durationMs?: number;
	key?: string;
	text?: string;
	apkPath?: string;
	component?: string;
	packageName?: string;
	lines?: number;
}

function required(value: string | undefined, name: string): string {
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function number(value: number | undefined, name: string): number {
	if (value === undefined) throw new Error(`${name} is required`);
	return value;
}

export function createAndroidEmulatorTool(
	schema: ExtensionAPI["arktype"],
	service: AndroidDeviceService | Promise<AndroidDeviceService>,
): ToolDefinition {
	return {
		name: "android_emulator",
		label: "Android Emulator",
		description:
			"Inspect and operate an Android device or emulator. Use screenshots, UI hierarchy and logcat together to verify mobile apps after installation or changes.",
		parameters: schema({
			action: schema(
				"'devices' | 'start' | 'screenshot' | 'tap' | 'swipe' | 'key' | 'text' | 'ui_tree' | 'install' | 'launch' | 'logcat'",
			),
			device: "string?",
			avd: "string?",
			x: "number?",
			y: "number?",
			x2: "number?",
			y2: "number?",
			durationMs: "number?",
			key: "string?",
			text: "string?",
			apkPath: "string?",
			component: "string?",
			packageName: "string?",
			lines: "number?",
		}),
		approval: "exec",
		loadMode: "discoverable",
		async execute(
			_toolCallId,
			rawParams,
			_signal,
			_onUpdate,
			ctx,
		): Promise<AgentToolResult<Record<string, unknown>>> {
			const params = rawParams as AndroidToolParams;
			try {
				const android = await service;
				const device = params.device;
				switch (params.action) {
					case "devices": {
						const [devices, avds] = await Promise.all([android.devices(), android.avds().catch(() => [])]);
						return {
							content: [{ type: "text", text: JSON.stringify({ devices, avds }, null, 2) }],
							details: { action: params.action, devices, avds },
						};
					}
					case "start": {
						const started = await android.start(required(params.avd, "avd"));
						return {
							content: [{ type: "text", text: `Started and booted ${started.avd}.` }],
							details: { action: params.action, ...started },
						};
					}
					case "screenshot": {
						const id = required(device, "device");
						const frame = await android.frame(id, true);
						return {
							content: [
								{ type: "text", text: `Captured ${id}.` },
								{ type: "image", data: Buffer.from(frame.png).toString("base64"), mimeType: "image/png" },
							],
							details: {
								action: params.action,
								device: id,
								capturedAt: frame.capturedAt,
								panelTab: {
									surface: "ext:panel.tab.android-emulator",
									target: id,
									dedupeKey: id,
									label: `Android · ${id}`,
								},
							},
						};
					}
					case "tap":
						await android.tap(required(device, "device"), number(params.x, "x"), number(params.y, "y"));
						break;
					case "swipe":
						await android.swipe(
							required(device, "device"),
							{ x: number(params.x, "x"), y: number(params.y, "y") },
							{ x: number(params.x2, "x2"), y: number(params.y2, "y2") },
							params.durationMs,
						);
						break;
					case "key":
						await android.key(required(device, "device"), required(params.key, "key"));
						break;
					case "text":
						await android.text(required(device, "device"), required(params.text, "text"));
						break;
					case "ui_tree": {
						const xml = await android.uiTree(required(device, "device"));
						return { content: [{ type: "text", text: xml }], details: { action: params.action, device } };
					}
					case "install": {
						const installed = await android.install(
							required(device, "device"),
							ctx.cwd,
							required(params.apkPath, "apkPath"),
						);
						return {
							content: [{ type: "text", text: `Installed ${installed.packagePath} on ${device}.` }],
							details: { action: params.action, device, ...installed },
						};
					}
					case "launch":
						await android.launch(required(device, "device"), required(params.component, "component"));
						break;
					case "logcat": {
						const logs = await android.logcat(required(device, "device"), {
							lines: params.lines,
							packageName: params.packageName,
						});
						return {
							content: [{ type: "text", text: logs || "No matching logcat lines." }],
							details: { action: params.action, device, packageName: params.packageName },
						};
					}
				}
				return {
					content: [{ type: "text", text: `Android ${params.action} completed on ${device}.` }],
					details: { ...params },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					details: { action: params.action },
					isError: true,
				};
			}
		},
	};
}
