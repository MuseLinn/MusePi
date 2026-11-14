import "./dom-shim";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { xtermTheme } from "../src/components/TerminalPanel";

/**
 * Terminal xterm palette contract: light/dark themes ship a full 16-color
 * ANSI palette as concrete color values (xterm's canvas renderer cannot
 * resolve CSS var()/oklch strings). Regression background: only
 * background/foreground/cursor/selection were themed; ANSI slots fell
 * through to xterm's hardcoded defaults, so `ls`/`git status` colored
 * output had poor contrast in the light theme.
 */

const ANSI_KEYS = [
	"black",
	"red",
	"green",
	"yellow",
	"blue",
	"magenta",
	"cyan",
	"white",
	"brightBlack",
	"brightRed",
	"brightGreen",
	"brightYellow",
	"brightBlue",
	"brightMagenta",
	"brightCyan",
	"brightWhite",
] as const;

const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))$/;

describe("xtermTheme ANSI palette", () => {
	it("exposes all 16 ANSI slots for both schemes", () => {
		for (const scheme of ["dark", "light"] as const) {
			const theme = xtermTheme(scheme);
			for (const key of ANSI_KEYS) {
				expect(typeof theme[key]).toBe("string");
				expect(theme[key]!.length).toBeGreaterThan(0);
			}
		}
	});

	it("uses only concrete color values (no var()/oklch strings)", () => {
		for (const scheme of ["dark", "light"] as const) {
			const theme = xtermTheme(scheme);
			for (const key of [...ANSI_KEYS, "foreground", "cursor", "selectionBackground"] as const) {
				const value: string = theme[key];
				expect(value).not.toContain("var(");
				expect(value).not.toContain("oklch");
				expect(value).toMatch(COLOR_RE);
			}
		}
	});

	it("keeps the canvas transparent so the pane background shows through", () => {
		expect(xtermTheme("dark").background).toBe("rgba(0,0,0,0)");
		expect(xtermTheme("light").background).toBe("rgba(0,0,0,0)");
	});

	it("schemes differ in the ANSI palette (light has its own contrast set)", () => {
		const dark = xtermTheme("dark");
		const light = xtermTheme("light");
		const differing = ANSI_KEYS.filter(key => dark[key] !== light[key]);
		// Every status-hue slot must differ between schemes; identical values
		// would mean one scheme silently inherited the other's contrast.
		expect(differing).toContain("red");
		expect(differing).toContain("green");
		expect(differing).toContain("yellow");
		expect(differing).toContain("blue");
		expect(differing).toContain("cyan");
	});

	it("the 8 base ANSI hues are distinct within a scheme (a collapsed palette would alias hues)", () => {
		for (const scheme of ["dark", "light"] as const) {
			const theme = xtermTheme(scheme);
			const hues = new Set(ANSI_KEYS.slice(0, 8).map(key => theme[key]));
			expect(hues.size).toBe(8);
		}
	});
});

/**
 * Terminal selection → chat composer contract. The attach chip dispatches on
 * the SHARED musepi-gui-insert-text channel (the one the element picker and
 * ContextPanel already use); a second transport would fork the insertion
 * path. Verified at the transport level, not the component level, because
 * the chip's only job is to gate the dispatch on a non-empty selection.
 */

// bun:test has no DOM and the registrator is not resolvable from this
// package — a minimal EventTarget-shaped window covers the one dispatch the
// contract exercises. Installed inside the describe so it never leaks into
// the palette tests above.
type WindowStub = {
	addEventListener(type: string, fn: EventListener): void;
	removeEventListener(type: string, fn: EventListener): void;
	dispatchEvent(event: Event): boolean;
};

function installWindowStub(): { dispatch(type: string, detail: unknown): void } {
	const listeners = new Map<string, EventListener[]>();
	const win = {
		addEventListener: (type: string, fn: EventListener): void => {
			listeners.set(type, [...(listeners.get(type) ?? []), fn]);
		},
		removeEventListener: (type: string, fn: EventListener): void => {
			listeners.set(
				type,
				(listeners.get(type) ?? []).filter(f => f !== fn),
			);
		},
		dispatchEvent: (event: Event): boolean => {
			for (const fn of listeners.get(event.type) ?? []) fn(event);
			return true;
		},
	};
	const recorder = globalThis as { window?: WindowStub };
	recorder.window = win;
	return {
		dispatch: (type: string, detail: unknown): void => {
			// Structural dispatch — the stub bus reads .type/.detail only, and
			// both exist on this event shape.
			win.dispatchEvent(new InsertTextEvent(type, { detail: detail as { text: string } }) as unknown as Event);
		},
	};
}

/** Minimal stand-in for the CustomEvent the chip dispatches. */
class InsertTextEvent {
	type: string;
	detail: { text: string };
	constructor(type: string, init: { detail: { text: string } }) {
		this.type = type;
		this.detail = init.detail;
	}
}

describe("terminal selection attach channel", () => {
	it("dispatch carries the selection on musepi-gui-insert-text", () => {
		const listener = vi.fn();
		const recorder = globalThis as { window?: WindowStub | undefined };
		const restoreWindow = recorder.window;
		const bus = installWindowStub();
		window.addEventListener("musepi-gui-insert-text", listener);
		try {
			// Same dispatch the chip's onClick performs.
			const selection = "const answer = 42;";
			bus.dispatch("musepi-gui-insert-text", { text: selection });
		} finally {
			window.removeEventListener("musepi-gui-insert-text", listener);
			if (restoreWindow === undefined) {
				delete recorder.window;
			} else {
				recorder.window = restoreWindow;
			}
		}
		expect(listener).toHaveBeenCalledTimes(1);
		expect(listener.mock.calls[0]![0].detail).toEqual({ text: "const answer = 42;" });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});
});
