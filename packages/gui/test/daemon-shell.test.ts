import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
// @ts-expect-error — untyped CJS module (electron/, outside tsconfig include)
import { daemonCommand, WEB_PORT_FILE } from "../electron/daemon.cjs";

const SETTINGS = path.join(os.homedir(), ".musepi", "agent", "settings.json");
const SETTINGS_GLOBAL = path.join(os.homedir(), ".musepi", "settings.json");

afterEach(async () => {
	await fs.rm(SETTINGS, { force: true });
	await fs.rm(SETTINGS_GLOBAL, { force: true });
	await fs.rm(WEB_PORT_FILE, { force: true });
});

/** daemonCommand gates --web-port on the desktop-shell extension: default
 *  OFF (the compat path loads desktop-web, the collab client — not the full
 *  working GUI), enabled ONLY by an explicit shell.enabled === true. */
describe("daemon.cjs daemonCommand — desktop-shell gating (opt-in)", () => {
	it("omits --web-port by default (shell disabled → local bundle)", () => {
		const { args } = daemonCommand(8300);
		expect(args).not.toContain("--web-port");
	});

	it("includes --web-port 0 when shell.enabled=true in agent settings", async () => {
		await fs.mkdir(path.dirname(SETTINGS), { recursive: true });
		await fs.writeFile(SETTINGS, JSON.stringify({ "shell.enabled": true }));
		const { args } = daemonCommand(8300);
		expect(args).toContain("--web-port");
	});

	it("shell.enabled=true wins in ~/.musepi/settings.json", async () => {
		await fs.mkdir(path.dirname(SETTINGS_GLOBAL), { recursive: true });
		await fs.writeFile(SETTINGS_GLOBAL, JSON.stringify({ "shell.enabled": true }));
		const { args } = daemonCommand(8300);
		expect(args).toContain("--web-port");
	});
});
