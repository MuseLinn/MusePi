import "./happy-dom-shim"; // MUST be first: the component graph defines DOM-bound modules at evaluation time.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getLocaleSnapshot, setLocale, t } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
	type BootPhase,
	BootRecoveryActions,
	bootPhaseLabel,
	exportDiagnostics,
	readRendererErrorLog,
	restartApplication,
	StartupSplash,
	useSlowBoot,
} from "../src/components/StartupSplash";

const ERROR_LOG_KEY = "musepi-gui-error-log";
const PHASES: BootPhase[] = ["probe", "spawn", "gate", "connect"];

const originalLocale = getLocaleSnapshot();
setLocale("en-US");
afterAll(() => setLocale(originalLocale === "zh-CN" ? "zh-CN" : "en-US"));

type ElectronBridge = NonNullable<Window["electronAPI"]>;

/** Install a partial bridge; the real one is only present inside the shell. */
function installBridge(partial: Partial<ElectronBridge>): void {
	(window as unknown as { electronAPI?: Partial<ElectronBridge> }).electronAPI = partial;
}

function fakeStorage(raw: string | null): Pick<Storage, "getItem"> {
	return { getItem: () => raw };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	localStorage.removeItem(ERROR_LOG_KEY);
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	delete (window as unknown as { electronAPI?: Partial<ElectronBridge> }).electronAPI;
});

describe("startup splash stages", () => {
	it("gives every boot stage its own label and shows the current one", () => {
		const labels = PHASES.map(phase => bootPhaseLabel(phase));
		expect(new Set(labels).size).toBe(PHASES.length);

		const html = renderToStaticMarkup(<StartupSplash phase="spawn" />);
		expect(html).toContain(labels[PHASES.indexOf("spawn")]);
		expect(html).toContain('role="status"');
	});

	it("stays brand-only before the slow-start gate opens", () => {
		const html = renderToStaticMarkup(<StartupSplash phase="probe" />);
		expect(html).not.toContain("gui-btn");
		expect(html).toContain("<progress");
	});

	it("offers both recovery actions once the start is slow", () => {
		const html = renderToStaticMarkup(<StartupSplash phase="gate" slow />);
		expect(html).toContain(t("general.bootTakingLongerThan"));
		expect(html).toContain(t("general.bootExportDiagnostics"));
		expect(html).toContain(t("general.bootRestartApp"));
		expect(html.match(/<button/g)?.length).toBe(2);
	});
});

describe("useSlowBoot", () => {
	function Probe({ enabled, delayMs }: { enabled: boolean; delayMs: number }) {
		const slow = useSlowBoot(enabled, delayMs);
		return <span data-slow={slow ? "1" : "0"} />;
	}

	const slowFlag = (): string | null => host.querySelector("[data-slow]")?.getAttribute("data-slow") ?? null;

	it("flips only after the delay and resets when the boot ends", async () => {
		act(() => root.render(<Probe enabled delayMs={30} />));
		expect(slowFlag()).toBe("0");

		await act(async () => {
			await Bun.sleep(60);
		});
		expect(slowFlag()).toBe("1");

		act(() => root.render(<Probe enabled={false} delayMs={30} />));
		expect(slowFlag()).toBe("0");
	});

	it("restarts the window when a new boot begins", async () => {
		act(() => root.render(<Probe enabled delayMs={40} />));
		await act(async () => {
			await Bun.sleep(60);
		});
		expect(slowFlag()).toBe("1");

		act(() => root.render(<Probe enabled={false} delayMs={40} />));
		act(() => root.render(<Probe enabled delayMs={40} />));
		expect(slowFlag()).toBe("0");

		await act(async () => {
			await Bun.sleep(60);
		});
		expect(slowFlag()).toBe("1");
	});
});

describe("renderer error ring", () => {
	it("treats missing, corrupt, and non-array storage as an empty history", () => {
		expect(readRendererErrorLog(fakeStorage(null))).toEqual([]);
		expect(readRendererErrorLog(fakeStorage("{not json"))).toEqual([]);
		expect(readRendererErrorLog(fakeStorage('{"a":1}'))).toEqual([]);
		expect(readRendererErrorLog(null)).toEqual([]);
	});

	it("keeps only string entries in order and caps the history", () => {
		expect(readRendererErrorLog(fakeStorage('["boom",1,"later",null]'))).toEqual(["boom", "later"]);

		const many = Array.from({ length: 120 }, (_, index) => `e${index}`);
		const kept = readRendererErrorLog(fakeStorage(JSON.stringify(many)));
		expect(kept.length).toBe(100);
		expect(kept[0]).toBe("e20");
		expect(kept.at(-1)).toBe("e119");
	});
});

describe("diagnostics export", () => {
	it("sends the recorded errors and returns the written path", async () => {
		const calls: { errors: string[] }[] = [];
		installBridge({
			diagnosticsExport: async input => {
				calls.push(input);
				return { ok: true, path: "/downloads/musepi-diagnostics.txt" };
			},
		});
		localStorage.setItem(ERROR_LOG_KEY, JSON.stringify(["uncaught: boom"]));

		expect(await exportDiagnostics()).toEqual({ ok: true, path: "/downloads/musepi-diagnostics.txt" });
		expect(calls).toEqual([{ errors: ["uncaught: boom"] }]);
	});

	it("maps a failing bridge to an error result", async () => {
		installBridge({
			diagnosticsExport: async () => {
				throw new Error("downloads is read-only");
			},
		});
		expect(await exportDiagnostics()).toEqual({ ok: false, error: "downloads is read-only" });
	});

	it("reports the missing shell instead of pretending to export", async () => {
		expect(await exportDiagnostics()).toEqual({ ok: false, error: t("general.bootDiagnosticsUnavailable") });
		expect(await restartApplication()).toBe(false);
	});
});

describe("recovery controls", () => {
	it("shows the export path and asks the shell to restart", async () => {
		let restarted = 0;
		installBridge({
			diagnosticsExport: async () => ({ ok: true, path: "/downloads/musepi-diagnostics.txt" }),
			appRestart: async () => {
				restarted++;
				return { ok: true };
			},
		});
		act(() => root.render(<BootRecoveryActions />));

		const buttons = [...host.querySelectorAll("button")];
		expect(buttons.map(button => button.textContent)).toEqual([
			t("general.bootExportDiagnostics"),
			t("general.bootRestartApp"),
		]);

		await act(async () => {
			buttons[0]?.click();
		});
		expect(host.textContent).toContain(
			t("general.bootDiagnosticsSaved", { path: "/downloads/musepi-diagnostics.txt" }),
		);
		expect(restarted).toBe(0);

		await act(async () => {
			buttons[1]?.click();
		});
		expect(restarted).toBe(1);
		expect(host.textContent).toContain(t("general.bootRestarting"));
	});

	it("re-enables the controls when the restart IPC rejects", async () => {
		installBridge({
			diagnosticsExport: async () => ({ ok: true, path: "/downloads/musepi-diagnostics.txt" }),
			appRestart: async () => {
				throw new Error("ipc closed");
			},
		});
		act(() => root.render(<BootRecoveryActions />));

		await act(async () => {
			host.querySelectorAll("button")[1]?.click();
		});

		expect(host.textContent).toContain(t("general.bootRestartFailed", { error: "ipc closed" }));
		expect([...host.querySelectorAll("button")].every(button => !button.disabled)).toBe(true);
	});
});
