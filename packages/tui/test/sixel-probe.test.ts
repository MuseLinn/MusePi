import { afterEach, describe, expect, it } from "bun:test";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL, TUI } from "@musepi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

type MutableTerminalInfo = {
	imageProtocol: ImageProtocol | null;
};

const terminalInfo = TERMINAL as unknown as MutableTerminalInfo;
const originalProtocol = TERMINAL.imageProtocol;
const originalWtSession = Bun.env.WT_SESSION;
const originalWslDistro = Bun.env.WSL_DISTRO_NAME;
const originalWslInterop = Bun.env.WSL_INTEROP;
const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function restoreIsTty(
	stream: NodeJS.ReadStream | NodeJS.WriteStream,
	descriptor: PropertyDescriptor | undefined,
): void {
	if (descriptor) {
		Object.defineProperty(stream, "isTTY", descriptor);
		return;
	}
	delete (stream as unknown as { isTTY?: boolean }).isTTY;
}

describe("TUI SIXEL capability probe", () => {
	afterEach(() => {
		setTerminalImageProtocol(originalProtocol);
		terminalInfo.imageProtocol = originalProtocol;
		if (originalWtSession === undefined) delete Bun.env.WT_SESSION;
		else Bun.env.WT_SESSION = originalWtSession;
		if (originalWslDistro === undefined) delete Bun.env.WSL_DISTRO_NAME;
		else Bun.env.WSL_DISTRO_NAME = originalWslDistro;
		if (originalWslInterop === undefined) delete Bun.env.WSL_INTEROP;
		else Bun.env.WSL_INTEROP = originalWslInterop;
		restoreIsTty(process.stdin, stdinIsTtyDescriptor);
		restoreIsTty(process.stdout, stdoutIsTtyDescriptor);
	});

	it("enables SIXEL only after positive terminal capability response", () => {
		if (process.platform !== "win32") return;
		setTerminalImageProtocol(null);
		terminalInfo.imageProtocol = null;
		Bun.env.WT_SESSION = "test-wt-session";
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		terminal.sendInput("\x1b[?1;2;4c");

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
		tui.stop();
	});

	it("enables SIXEL when DA and graphics replies are coalesced in one chunk", () => {
		if (process.platform !== "win32") return;
		setTerminalImageProtocol(null);
		terminalInfo.imageProtocol = null;
		Bun.env.WT_SESSION = "test-wt-session";
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		terminal.sendInput("\x1b[?1;2;4c\x1b[?2;1;0S");

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
		tui.stop();
	});

	it("enables SIXEL when DA reply arrives split across chunks", () => {
		if (process.platform !== "win32") return;
		setTerminalImageProtocol(null);
		terminalInfo.imageProtocol = null;
		Bun.env.WT_SESSION = "test-wt-session";
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		terminal.sendInput("\x1b[?1;2;");
		terminal.sendInput("4c");

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
		tui.stop();
	});

	it("keeps SIXEL disabled when capability responses are negative", () => {
		if (process.platform !== "win32") return;
		setTerminalImageProtocol(null);
		terminalInfo.imageProtocol = null;
		Bun.env.WT_SESSION = "test-wt-session";
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		terminal.sendInput("\x1b[?1;2c");
		terminal.sendInput("\x1b[?2;0;0S");

		expect(TERMINAL.imageProtocol).toBeNull();
		tui.stop();
	});

	it("enables SIXEL under WSL + Windows Terminal (process.platform is linux)", () => {
		// Regression for #6009: inside WSL, process.platform reports "linux" even
		// though the host is Windows Terminal. The probe used to gate on
		// process.platform === "win32", so WSL sessions never negotiated SIXEL and
		// fell back to the text image card. It now gates on isConPTYHosted(), which
		// treats WSL (WSL_DISTRO_NAME/WSL_INTEROP) as a Windows host.
		if (process.platform !== "linux") return;
		setTerminalImageProtocol(null);
		terminalInfo.imageProtocol = null;
		Bun.env.WT_SESSION = "test-wt-session";
		Bun.env.WSL_DISTRO_NAME = "Ubuntu";
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		terminal.sendInput("\x1b[?1;2;4c");

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
		tui.stop();
	});
});
