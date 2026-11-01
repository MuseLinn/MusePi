import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AndroidDeviceService,
	type AndroidProcess,
	type AndroidProcessRunner,
	type AndroidRunResult,
	mapPoint,
	parseAdbDevices,
} from "./android-service";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function result(stdout: Uint8Array | string = "", exitCode = 0, stderr = ""): AndroidRunResult {
	return { stdout: typeof stdout === "string" ? new TextEncoder().encode(stdout) : stdout, stderr, exitCode };
}

class FakeRunner implements AndroidProcessRunner {
	calls: Array<{ command: string; args: string[] }> = [];
	responses: AndroidRunResult[] = [];
	started: Array<{ command: string; args: string[]; process: AndroidProcess & { killed: boolean } }> = [];
	onRun: ((call: { command: string; args: string[] }) => AndroidRunResult | Promise<AndroidRunResult>) | undefined;

	async run(command: string, args: string[]): Promise<AndroidRunResult> {
		const call = { command, args };
		this.calls.push(call);
		if (this.onRun) return this.onRun(call);
		return this.responses.shift() ?? result();
	}

	start(command: string, args: string[]): AndroidProcess {
		const process = {
			killed: false,
			kill() {
				this.killed = true;
			},
		};
		this.started.push({ command, args, process });
		return process;
	}
}

describe("ADB parsing and coordinates", () => {
	test("keeps only device rows and preserves authorization state", () => {
		expect(
			parseAdbDevices(
				`List of devices attached\nemulator-5554 device product:sdk model:Pixel_8 device:emu\nabc unauthorized transport_id:2\nxyz offline\nhost:1234 device\n\n`,
			),
		).toEqual([
			{ id: "emulator-5554", state: "device", model: "Pixel_8" },
			{ id: "abc", state: "unauthorized", model: null },
			{ id: "xyz", state: "offline", model: null },
			{ id: "host:1234", state: "device", model: null },
		]);
	});

	test("maps displayed image coordinates and rejects points outside the content", () => {
		const rect = { left: 100, top: 50, width: 200, height: 400 };
		const natural = { width: 1080, height: 2160 };
		expect(mapPoint(rect, natural, { x: 150, y: 150 })).toEqual({ x: 270, y: 540 });
		expect(mapPoint(rect, natural, { x: 99, y: 150 })).toBeNull();
		expect(mapPoint(rect, { width: 0, height: 2160 }, { x: 150, y: 150 })).toBeNull();
	});
});

describe("AndroidDeviceService", () => {
	test("returns PNG frames and shares one in-flight screencap", async () => {
		const runner = new FakeRunner();
		const pending = Promise.withResolvers<AndroidRunResult>();
		let captures = 0;
		runner.onRun = () => {
			captures += 1;
			return pending.promise;
		};
		const service = new AndroidDeviceService({ adbPath: "adb", runner });
		const first = service.frame("emulator-5554");
		const second = service.frame("emulator-5554");
		await Bun.sleep(0);
		expect(captures).toBe(1);
		pending.resolve(result(PNG));
		const [a, b] = await Promise.all([first, second]);
		expect(a.device).toBe("emulator-5554");
		expect(a.png).toEqual(PNG);
		expect(b.png).toEqual(PNG);
	});

	test("does not reuse a frame captured for another device", async () => {
		const runner = new FakeRunner();
		runner.responses = [result(PNG), result(Uint8Array.from([...PNG, 4]))];
		const service = new AndroidDeviceService({ adbPath: "adb", runner });
		const first = service.frame("emulator-5554");
		const second = service.frame("serial-2");
		const frames = await Promise.all([first, second]);
		expect(frames[0]!.device).toBe("emulator-5554");
		expect(frames[1]!.device).toBe("serial-2");
		expect(frames[1]!.png.at(-1)).toBe(4);
	});

	test("validates device input before executing it", async () => {
		const runner = new FakeRunner();
		const service = new AndroidDeviceService({ adbPath: "adb", runner });
		await expect(service.tap("bad device", 1, 2)).rejects.toThrow("device");
		await expect(service.tap("emulator-5554", -1, 2)).rejects.toThrow("coordinates");
		await expect(service.text("emulator-5554", "hello\nworld")).rejects.toThrow("single-line");
		await expect(service.key("emulator-5554", "NOT_A_KEY")).rejects.toThrow("key");
		expect(runner.calls).toHaveLength(0);
	});

	test("escapes printable text for the remote Android shell", async () => {
		const runner = new FakeRunner();
		const service = new AndroidDeviceService({ adbPath: "adb", runner });
		await service.text("emulator-5554", "a b'c");
		expect(runner.calls[0]!.args).toEqual(["-s", "emulator-5554", "shell", "input", "text", "'a%sb'\\''c'"]);
	});

	test("rejects APK paths outside the workspace", async () => {
		const root = await mkdtemp(join(tmpdir(), "musepi-android-service-"));
		try {
			await writeFile(join(root, "app-debug.apk"), "apk");
			const runner = new FakeRunner();
			const service = new AndroidDeviceService({ adbPath: "adb", runner });
			await expect(service.install("emulator-5554", root, "../outside.apk")).rejects.toThrow("workspace");
			await service.install("emulator-5554", root, "app-debug.apk");
			expect(runner.calls[0]!.args.slice(0, 5)).toEqual(["-s", "emulator-5554", "install", "-r", "-g"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("rejects uiautomator diagnostics instead of returning them as XML", async () => {
		const runner = new FakeRunner();
		runner.onRun = ({ args }) => {
			if (args.includes("uiautomator")) return result("ERROR: null root node returned by UiTestAutomationBridge.");
			if (args.includes("cat")) return result("cat: /sdcard/musepi-ui-tree.xml: No such file or directory");
			return result();
		};
		const service = new AndroidDeviceService({ adbPath: "adb", runner });
		await expect(service.uiTree("emulator-5554")).rejects.toThrow("UI hierarchy");
	});

	test("dispose is idempotent and kills only emulator processes it started", async () => {
		const runner = new FakeRunner();
		const service = new AndroidDeviceService({ adbPath: "adb", emulatorPath: "emulator", runner });
		await service.start("MusePi-Mobile-Test");
		expect(runner.started).toHaveLength(1);
		await service.dispose();
		await service.dispose();
		expect(runner.started[0]!.process.killed).toBe(true);
		await expect(service.frame("emulator-5554")).rejects.toThrow("disposed");
	});
});
