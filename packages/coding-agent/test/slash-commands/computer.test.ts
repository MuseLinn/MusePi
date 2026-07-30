import { describe, expect, it, vi } from "bun:test";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import type { DesktopSessionOptions } from "@oh-my-pi/pi-natives";

function acpRuntime(options?: {
	enabled?: boolean;
	applyResult?: boolean;
	supportsComputerUse?: boolean;
	codex?: boolean;
	azure?: boolean;
	baseUrl?: string;
}) {
	const store = {
		"computer.enabled": options?.enabled ?? false,
		"computer.backend": "auto",
		"computer.display": "all",
		"computer.maxWidth": 1920,
		"computer.maxHeight": 1200,
	};
	const get = vi.fn((path: string) => store[path as keyof typeof store]);
	const override = vi.fn((path: string, value: boolean) => {
		if (path === "computer.enabled") store[path] = value;
	});
	const set = vi.fn();
	let controllerConfiguration: Readonly<DesktopSessionOptions> | undefined = options?.enabled
		? {
				backend: store["computer.backend"],
				display: store["computer.display"],
				maxWidth: store["computer.maxWidth"],
				maxHeight: store["computer.maxHeight"],
			}
		: undefined;
	const setComputerToolEnabled = vi.fn(async (enabled: boolean) => {
		if (enabled && !controllerConfiguration) {
			controllerConfiguration = {
				backend: store["computer.backend"],
				display: store["computer.display"],
				maxWidth: store["computer.maxWidth"],
				maxHeight: store["computer.maxHeight"],
			};
		}
		return options?.applyResult ?? true;
	});
	const getEnabledToolNames = vi.fn(() => (store["computer.enabled"] ? ["computer"] : []));
	const getToolByName = vi.fn(() =>
		controllerConfiguration ? { name: "computer", effectiveConfiguration: controllerConfiguration } : undefined,
	);
	const output = vi.fn();
	const model = options?.azure
		? {
				provider: "azure",
				id: "gpt-5.5",
				api: "azure-openai-responses",
				baseUrl: options.baseUrl ?? "",
				supportsComputerUse: options.supportsComputerUse ?? false,
			}
		: options?.codex
			? {
					provider: "openai-codex",
					id: "gpt-5.6-sol",
					api: "openai-codex-responses",
					supportsComputerUse: options.supportsComputerUse ?? false,
				}
			: {
					provider: "google",
					id: "gemini-2.5-flash",
					api: "google-generative-ai",
					supportsComputerUse: options?.supportsComputerUse ?? false,
				};
	const runtime = {
		session: {
			settings: { get, override, set },
			setComputerToolEnabled,
			getEnabledToolNames,
			model,
			getToolByName,
		},
		output,
	} as unknown as SlashCommandRuntime;
	return { get, override, set, setComputerToolEnabled, getEnabledToolNames, getToolByName, output, runtime, store };
}

describe("/computer slash command", () => {
	it("toggles a disabled session on: slate refresh first, then session-only override", async () => {
		const h = acpRuntime({ enabled: false });

		const result = await executeAcpBuiltinSlashCommand("/computer", h.runtime);

		expect(result).toEqual({ consumed: true });
		expect(h.setComputerToolEnabled).toHaveBeenCalledWith(true);
		expect(h.override).toHaveBeenCalledWith("computer.enabled", true);
		expect(h.set).not.toHaveBeenCalled();
		expect(h.output).toHaveBeenCalledWith(
			"Computer use enabled for this session. Computer use: enabled · tool: active · backend: auto · display: all · capture: 1920×1200 · model: google/gemini-2.5-flash · exposure: function",
		);
	});

	it("toggles an enabled session off", async () => {
		const h = acpRuntime({ enabled: true });

		await executeAcpBuiltinSlashCommand("/computer", h.runtime);

		expect(h.setComputerToolEnabled).toHaveBeenCalledWith(false);
		expect(h.override).toHaveBeenCalledWith("computer.enabled", false);
		expect(h.output).toHaveBeenCalledWith("Computer use disabled for this session.");
	});

	it("honors explicit on/off regardless of current state", async () => {
		const on = acpRuntime({ enabled: true });
		await executeAcpBuiltinSlashCommand("/computer on", on.runtime);
		expect(on.setComputerToolEnabled).toHaveBeenCalledWith(true);
		expect(on.override).toHaveBeenCalledWith("computer.enabled", true);

		const off = acpRuntime({ enabled: false });
		await executeAcpBuiltinSlashCommand("/computer off", off.runtime);
		expect(off.setComputerToolEnabled).toHaveBeenCalledWith(false);
		expect(off.override).toHaveBeenCalledWith("computer.enabled", false);
	});

	it("reports status without touching the tool slate or settings", async () => {
		const h = acpRuntime({ enabled: true });

		await executeAcpBuiltinSlashCommand("/computer status", h.runtime);

		expect(h.setComputerToolEnabled).not.toHaveBeenCalled();
		expect(h.override).not.toHaveBeenCalled();
		expect(h.output).toHaveBeenCalledWith(
			"Computer use: enabled · tool: active · backend: auto · display: all · capture: 1920×1200 · model: google/gemini-2.5-flash · exposure: function",
		);
	});

	it("reports the existing controller snapshot and labels changed settings for the next session", async () => {
		const h = acpRuntime({ enabled: true });
		h.store["computer.display"] = "display-2";
		h.store["computer.maxWidth"] = 1600;
		h.store["computer.maxHeight"] = 900;

		await executeAcpBuiltinSlashCommand("/computer status", h.runtime);

		expect(h.output).toHaveBeenCalledWith(
			"Computer use: enabled · tool: active · backend: auto · display: all · capture: 1920×1200 · next-session settings: backend=auto, display=display-2, capture=1600×900 · model: google/gemini-2.5-flash · exposure: function",
		);
	});

	it("reports subscription Codex computer exposure as a callable function", async () => {
		const h = acpRuntime({ enabled: true, codex: true });

		await executeAcpBuiltinSlashCommand("/computer status", h.runtime);

		expect(h.output).toHaveBeenCalledWith(
			"Computer use: enabled · tool: active · backend: auto · display: all · capture: 1920×1200 · model: openai-codex/gpt-5.6-sol · exposure: function",
		);
	});

	it("reports explicit Codex native opt-in without masking the override", async () => {
		const h = acpRuntime({ enabled: true, codex: true, supportsComputerUse: true });

		await executeAcpBuiltinSlashCommand("/computer status", h.runtime);

		expect(h.output).toHaveBeenCalledWith(
			"Computer use: enabled · tool: active · backend: auto · display: all · capture: 1920×1200 · model: openai-codex/gpt-5.6-sol · exposure: native",
		);
	});

	it("reports an Azure custom gateway override as function exposure", async () => {
		const previous = process.env.AZURE_OPENAI_BASE_URL;
		process.env.AZURE_OPENAI_BASE_URL = "https://gateway.example/openai/v1";
		try {
			const h = acpRuntime({ enabled: true, azure: true, supportsComputerUse: true });

			await executeAcpBuiltinSlashCommand("/computer status", h.runtime);

			expect(h.output).toHaveBeenCalledWith(
				"Computer use: enabled · tool: active · backend: auto · display: all · capture: 1920×1200 · model: azure/gpt-5.5 · exposure: function",
			);
		} finally {
			if (previous === undefined) delete process.env.AZURE_OPENAI_BASE_URL;
			else process.env.AZURE_OPENAI_BASE_URL = previous;
		}
	});

	it("leaves the override untouched when the session cannot build the tool", async () => {
		const h = acpRuntime({ enabled: false, applyResult: false });

		await executeAcpBuiltinSlashCommand("/computer on", h.runtime);

		expect(h.setComputerToolEnabled).toHaveBeenCalledWith(true);
		expect(h.override).not.toHaveBeenCalled();
		expect(h.output).toHaveBeenCalledWith("Computer use is unavailable in this session.");
	});

	it("rejects unknown arguments with usage", async () => {
		const h = acpRuntime();

		await executeAcpBuiltinSlashCommand("/computer bogus", h.runtime);

		expect(h.setComputerToolEnabled).not.toHaveBeenCalled();
		expect(h.output).toHaveBeenCalledWith("Usage: /computer [on|off|status]");
	});
});
