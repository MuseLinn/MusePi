import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { CollabHost } from "@musepi/pi-coding-agent/collab/host";
import { resetSettingsForTest, Settings } from "@musepi/pi-coding-agent/config/settings";
import { initTheme } from "@musepi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@musepi/pi-coding-agent/modes/types";
import {
	type BuiltinSlashCommandRuntime,
	executeBuiltinSlashCommand,
	lookupBuiltinSlashCommand,
} from "@musepi/pi-coding-agent/slash-commands/builtin-registry";
import { CollabQrCodeComponent } from "@musepi/pi-coding-agent/slash-commands/helpers/collab-qrcode";
import { Spacer } from "@musepi/pi-tui";

/**
 * `/pair` is how a TUI user binds the MusePi mobile app: the app's connect
 * screen scans a QR (or takes a pasted link), so the command must hand over the
 * share's web link as a scannable code. Two failure modes are user-visible and
 * worth pinning:
 *
 * - reusing a running share must NOT tear it down and start another (a restart
 *   would rotate the room key under the guests already connected);
 * - the command has to be discoverable at all — before it existed, the only
 *   path to the QR was `/collab lan`, whose description reads as session
 *   *sharing*, which is not what someone looking to bind a phone searches for.
 */

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
});

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(() => {
	resetSettingsForTest();
});

function fakeHost(): NonNullable<InteractiveModeContext["collabHost"]> {
	return {
		link: "relay.example.com/r/full-control",
		viewLink: "relay.example.com/r/read-only",
		webLink: "https://192.168.1.5:7655/#wss://192.168.1.5:7655/r/room.key",
		webViewLink: "https://192.168.1.5:7655/#wss://192.168.1.5:7655/r/room.viewkey",
		participants: [{ name: "host", role: "host" }],
	} as unknown as NonNullable<InteractiveModeContext["collabHost"]>;
}

function createRuntimeHarness(options?: {
	collabHost?: NonNullable<InteractiveModeContext["collabHost"]>;
	guest?: boolean;
}) {
	const setText = vi.fn();
	const showStatus = vi.fn();
	const showError = vi.fn();
	const present = vi.fn();
	const ctx = {
		editor: { setText },
		showStatus,
		showError,
		present,
		settings: { get: vi.fn(() => "") },
		collabHost: options?.collabHost,
		collabGuest: options?.guest ? { readOnly: false } : undefined,
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		setText,
		showStatus,
		showError,
		present,
		runtime: { ctx } as BuiltinSlashCommandRuntime,
	};
}

describe("/pair slash command (mobile app binding)", () => {
	it("reuses a running share and prints a scannable QR instead of starting another", async () => {
		const startSpy = vi.spyOn(CollabHost.prototype, "start");
		const harness = createRuntimeHarness({ collabHost: fakeHost() });

		const handled = await executeBuiltinSlashCommand("/pair", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		// Reuse, not restart: a second share would rotate the room key.
		expect(startSpy).not.toHaveBeenCalled();
		const presented = harness.present.mock.calls[0]?.[0] as readonly unknown[];
		expect(presented[0]).toBeInstanceOf(Spacer);
		expect(presented[1]).toBeInstanceOf(CollabQrCodeComponent);
		const component = presented[1] as CollabQrCodeComponent;
		expect(component.url).toBe("https://192.168.1.5:7655/#wss://192.168.1.5:7655/r/room.key");
		expect(component.render(120).join("\n")).toMatch(/\x1b\[(?:47|40)m/);
	});

	it("is registered as a discoverable command with a pairing state line", async () => {
		const spec = lookupBuiltinSlashCommand("pair");
		expect(spec).toBeDefined();
		const hosting = spec?.getTuiAutocompleteDescription?.({ ctx: { collabHost: fakeHost() } } as
			| BuiltinSlashCommandRuntime
			| never) as string | undefined;
		expect(hosting?.startsWith("Pair:")).toBe(true);
		const idle = spec?.getTuiAutocompleteDescription?.({ ctx: {} } as BuiltinSlashCommandRuntime) as
			| string
			| undefined;
		expect(idle?.startsWith("Pair:")).toBe(true);
		expect(idle).not.toBe(hosting);
	});

	it("cannot hand a guest a host QR — the dispatcher keeps pairing host-only", async () => {
		const harness = createRuntimeHarness({ guest: true });

		const handled = await executeBuiltinSlashCommand("/pair", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showStatus.mock.calls[0]?.[0]).toContain("host-only");
		expect(harness.present).not.toHaveBeenCalled();
	});
});
