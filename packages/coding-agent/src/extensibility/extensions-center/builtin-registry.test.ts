import { describe, expect, it } from "bun:test";
import { BUILTIN_EXTENSIONS, builtinExtensionEntries } from "./builtin-registry";

/** Desktop shell extension (dsh-desktop parity): the Electron shell is a
 *  first-class extension — extensions.list reports it, and setEnabled toggles
 *  it (mirrored on shell.enabled). The builtin registry is its home. */
describe("builtin registry — desktop shell", () => {
	it("declares the desktop-shell builtin (kind desktop-shell, id desktop-shell:shell)", () => {
		const def = BUILTIN_EXTENSIONS.find(d => d.kind === "desktop-shell");
		expect(def).toBeDefined();
		expect(def?.name).toBe("shell");
		expect(def?.displayName).toContain("Shell");
		expect(def?.settingsMirror?.key).toBe("shell.enabled");
	});

	it("emits an active desktop-shell entry by default", () => {
		const entries = builtinExtensionEntries(new Set());
		const shell = entries.find(e => e.id === "desktop-shell:shell");
		expect(shell).toBeDefined();
		expect(shell?.kind).toBe("desktop-shell");
		expect(shell?.state).toBe("active");
		expect(shell?.path).toBe(""); // read-only builtin, no file to reload
	});

	it("disables the shell when its id is in disabledExtensions", () => {
		const entries = builtinExtensionEntries(new Set(["desktop-shell:shell"]));
		const shell = entries.find(e => e.id === "desktop-shell:shell");
		expect(shell?.state).toBe("disabled");
		expect(shell?.disabledReason).toBe("item-disabled");
	});
});
