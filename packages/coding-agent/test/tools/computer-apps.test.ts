import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type DesktopApp,
	desktopEntryName,
	launchCommand,
	listInstalledApps,
	resolveApp,
} from "../../src/tools/computer/apps";

const app = (name: string, id = `/apps/${name}`): DesktopApp => ({ name, id, kind: "shortcut" });

describe("installed app discovery", () => {
	it("reads Start Menu shortcuts and names them without the extension", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-apps-"));
		const programs = path.join(root, "Microsoft", "Windows", "Start Menu", "Programs");
		await fs.mkdir(programs, { recursive: true });
		await fs.writeFile(path.join(programs, "Notion.lnk"), "");
		await fs.writeFile(path.join(programs, "notes.txt"), "");
		await fs.mkdir(path.join(programs, "Tools"), { recursive: true });
		await fs.writeFile(path.join(programs, "Tools", "Terminal.exe"), "");

		const apps = await listInstalledApps({ platform: "win32", env: { ProgramData: root }, home: root });
		expect(apps.map(entry => entry.name)).toEqual(["Notion", "Terminal"]);
		expect(apps.every(entry => entry.kind === "shortcut")).toBe(true);

		const missing = await listInstalledApps({
			platform: "win32",
			env: { ProgramData: path.join(root, "nope") },
			home: root,
		});
		expect(missing).toEqual([]);
	});

	it("prefers the unlocalized Name= in a freedesktop entry", () => {
		expect(desktopEntryName("[Desktop Entry]\nName[zh_CN]=编辑器\nName=Editor\nExec=editor")).toBe("Editor");
		expect(desktopEntryName("[Desktop Entry]\nExec=editor")).toBeNull();
	});
});

describe("launch target resolution", () => {
	it("matches exact id, exact name, then unique case-insensitive name", () => {
		const apps = [app("Notion", "/a/notion.lnk"), app("Visual Studio Code", "/a/code.lnk")];
		expect(resolveApp(apps, "/a/notion.lnk").name).toBe("Notion");
		expect(resolveApp(apps, "Visual Studio Code").id).toBe("/a/code.lnk");
		expect(resolveApp(apps, "notion").id).toBe("/a/notion.lnk");
	});

	it("refuses ambiguity instead of guessing", () => {
		const apps = [app("Terminal", "/a/terminal.lnk"), app("Terminal", "/b/terminal.lnk")];
		expect(() => resolveApp(apps, "terminal")).toThrow(/multiple apps/i);
	});

	it("suggests prefixes when nothing matches", () => {
		expect(() => resolveApp([app("Notion")], "noti")).toThrow(/candidates: Notion/);
	});

	it("uses the platform handler for the resolved path", () => {
		expect(launchCommand("win32", "C:\\x y\\Notion.lnk")).toEqual([
			"cmd.exe",
			"/c",
			"start",
			"",
			"C:\\x y\\Notion.lnk",
		]);
		expect(launchCommand("darwin", "/Applications/Notion.app")).toEqual(["open", "/Applications/Notion.app"]);
		expect(launchCommand("linux", "/usr/share/applications/code.desktop")).toEqual([
			"xdg-open",
			"/usr/share/applications/code.desktop",
		]);
	});
});

afterAll(async () => {
	// Temp roots are small; leaving them to the OS keeps the test free of
	// ordering assumptions about which case created what.
});
