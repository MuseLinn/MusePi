import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export { mapPoint } from "./geometry";

export interface AndroidDevice {
	id: string;
	state: string;
	model: string | null;
}

export interface AndroidFrame {
	device: string;
	png: Uint8Array;
	capturedAt: number;
}

export interface AndroidRunResult {
	stdout: Uint8Array;
	stderr: string;
	exitCode: number;
}

export interface AndroidProcess {
	kill(): void;
}

export interface AndroidProcessRunner {
	run(command: string, args: string[], options?: { timeoutMs?: number }): Promise<AndroidRunResult>;
	start(command: string, args: string[]): AndroidProcess;
}

export interface AndroidServiceOptions {
	adbPath?: string;
	emulatorPath?: string;
	runner?: AndroidProcessRunner;
}

interface Point {
	x: number;
	y: number;
}

class BunAndroidProcessRunner implements AndroidProcessRunner {
	async run(command: string, args: string[], options: { timeoutMs?: number } = {}): Promise<AndroidRunResult> {
		const child = Bun.spawn([command, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 30_000);
		try {
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).arrayBuffer(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			return { stdout: new Uint8Array(stdout), stderr, exitCode };
		} finally {
			clearTimeout(timer);
		}
	}

	start(command: string, args: string[]): AndroidProcess {
		const child = Bun.spawn([command, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		return { kill: () => child.kill() };
	}
}

export function parseAdbDevices(output: string): AndroidDevice[] {
	return output
		.split(/\r?\n/)
		.slice(1)
		.flatMap(line => {
			const fields = line.trim().split(/\s+/);
			if (fields.length < 2 || !fields[0] || fields[1] === "attached") return [];
			return [
				{
					id: fields[0],
					state: fields[1]!,
					model: fields.find(field => field.startsWith("model:"))?.slice(6) ?? null,
				},
			];
		});
}

function assertDevice(device: string): void {
	if (!/^[A-Za-z0-9._:-]+$/.test(device)) throw new Error("Invalid Android device ID");
}

function assertPoint(point: Point): void {
	if (
		!Number.isFinite(point.x) ||
		!Number.isFinite(point.y) ||
		point.x < 0 ||
		point.y < 0 ||
		point.x > 20_000 ||
		point.y > 20_000
	) {
		throw new Error("Invalid Android coordinates");
	}
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

const KEY_EVENTS: Record<string, string> = {
	BACK: "KEYCODE_BACK",
	HOME: "KEYCODE_HOME",
	RECENTS: "KEYCODE_APP_SWITCH",
	ENTER: "KEYCODE_ENTER",
	DELETE: "KEYCODE_DEL",
	POWER: "KEYCODE_POWER",
	VOLUME_UP: "KEYCODE_VOLUME_UP",
	VOLUME_DOWN: "KEYCODE_VOLUME_DOWN",
	DPAD_UP: "KEYCODE_DPAD_UP",
	DPAD_DOWN: "KEYCODE_DPAD_DOWN",
	DPAD_LEFT: "KEYCODE_DPAD_LEFT",
	DPAD_RIGHT: "KEYCODE_DPAD_RIGHT",
};

export class AndroidDeviceService {
	#adbPath: string;
	#emulatorPath: string;
	#runner: AndroidProcessRunner;
	#ownedProcesses = new Set<AndroidProcess>();
	#capture: Promise<AndroidFrame> | null = null;
	#latest: AndroidFrame | null = null;
	#subscribers = 0;
	#disposed = false;

	constructor(options: AndroidServiceOptions = {}) {
		this.#adbPath = options.adbPath ?? "adb";
		this.#emulatorPath = options.emulatorPath ?? "emulator";
		this.#runner = options.runner ?? new BunAndroidProcessRunner();
	}

	get subscribers(): number {
		return this.#subscribers;
	}

	subscribe(): number {
		this.#assertActive();
		this.#subscribers += 1;
		return this.#subscribers;
	}

	unsubscribe(): number {
		this.#subscribers = Math.max(0, this.#subscribers - 1);
		return this.#subscribers;
	}

	async devices(): Promise<AndroidDevice[]> {
		return parseAdbDevices(await this.#text(this.#adbPath, ["devices", "-l"]));
	}

	async avds(): Promise<string[]> {
		const output = await this.#text(this.#emulatorPath, ["-list-avds"]);
		return output
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(Boolean);
	}

	async start(avd: string): Promise<{ avd: string; booted: boolean }> {
		this.#assertActive();
		if (!/^[A-Za-z0-9._-]+$/.test(avd)) throw new Error("Invalid Android AVD name");
		const process = this.#runner.start(this.#emulatorPath, ["-avd", avd]);
		this.#ownedProcesses.add(process);
		try {
			await this.#execute(
				this.#adbPath,
				["wait-for-device", "shell", 'while [[ -z "$(getprop sys.boot_completed)" ]]; do sleep 1; done'],
				120_000,
			);
			return { avd, booted: true };
		} catch (error) {
			process.kill();
			this.#ownedProcesses.delete(process);
			throw error;
		}
	}

	async frame(device: string, force = false): Promise<AndroidFrame> {
		assertDevice(device);
		this.#assertActive();
		if (!force && this.#latest?.device === device && Date.now() - this.#latest.capturedAt < 250) return this.#latest;
		if (this.#capture) await this.#capture;
		if (!force && this.#latest?.device === device) return this.#latest;
		this.#assertActive();
		this.#capture = this.#captureFrame(device);
		try {
			return await this.#capture;
		} finally {
			this.#capture = null;
		}
	}

	async tap(device: string, x: number, y: number): Promise<void> {
		assertPoint({ x, y });
		await this.#adb(device, ["shell", "input", "tap", String(Math.round(x)), String(Math.round(y))]);
	}

	async swipe(device: string, from: Point, to: Point, durationMs = 300): Promise<void> {
		assertPoint(from);
		assertPoint(to);
		if (!Number.isFinite(durationMs) || durationMs < 50 || durationMs > 10_000)
			throw new Error("Invalid swipe duration");
		await this.#adb(device, [
			"shell",
			"input",
			"swipe",
			...[from.x, from.y, to.x, to.y, durationMs].map(value => String(Math.round(value))),
		]);
	}

	async key(device: string, key: string): Promise<void> {
		const event = KEY_EVENTS[key.toUpperCase()];
		if (!event) throw new Error("Unsupported Android key");
		await this.#adb(device, ["shell", "input", "keyevent", event]);
	}

	async text(device: string, text: string): Promise<void> {
		if (!text.length || text.length > 4096 || /[^\x20-\x7e]/.test(text)) {
			throw new Error("Android text must be non-empty, single-line printable ASCII (4096 characters maximum)");
		}
		const escaped = text.replaceAll("%", "%25").replaceAll(" ", "%s");
		await this.#adb(device, ["shell", "input", "text", shellQuote(escaped)]);
	}

	async install(device: string, cwd: string, apkPath: string): Promise<{ packagePath: string }> {
		if (!apkPath.toLowerCase().endsWith(".apk")) throw new Error("An .apk path is required");
		const root = await realpath(cwd);
		const candidate = resolve(root, apkPath);
		this.#assertInside(root, candidate);
		const packagePath = await realpath(candidate);
		this.#assertInside(root, packagePath);
		if (!(await stat(packagePath)).isFile()) throw new Error("APK path is not a file");
		await this.#adb(device, ["install", "-r", "-g", packagePath], 120_000);
		return { packagePath };
	}

	async launch(device: string, component: string): Promise<void> {
		if (!/^[A-Za-z0-9._]+\/[A-Za-z0-9._$]+$/.test(component))
			throw new Error("Invalid Android package/activity component");
		await this.#adb(device, ["shell", "am", "start", "-W", "-n", component], 30_000);
	}

	async uiTree(device: string): Promise<string> {
		const remote = "/sdcard/musepi-ui-tree.xml";
		const dump = new TextDecoder().decode(await this.#adb(device, ["shell", "uiautomator", "dump", remote], 30_000));
		const output = await this.#adb(device, ["exec-out", "cat", remote]);
		const xml = new TextDecoder().decode(output);
		if (!xml.includes("<hierarchy")) {
			const detail = xml.trim() || dump.trim() || "no hierarchy root";
			throw new Error(`Android UI hierarchy unavailable: ${detail}`);
		}
		return xml;
	}

	async logcat(device: string, options: { lines?: number; packageName?: string } = {}): Promise<string> {
		const lines = options.lines ?? 200;
		if (!Number.isInteger(lines) || lines < 1 || lines > 2000)
			throw new Error("Log lines must be between 1 and 2000");
		const args = ["logcat", "-d", "-t", String(lines)];
		if (options.packageName) {
			if (!/^[A-Za-z0-9._]+$/.test(options.packageName)) throw new Error("Invalid Android package name");
			const pid = (await this.#text(this.#adbPath, ["-s", device, "shell", "pidof", options.packageName])).trim();
			if (!/^\d+$/.test(pid)) throw new Error("The Android package has no running process");
			args.push(`--pid=${pid}`);
		}
		return this.#text(this.#adbPath, ["-s", device, ...args]);
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#subscribers = 0;
		if (this.#capture) await this.#capture.catch(() => undefined);
		this.#latest = null;
		for (const process of this.#ownedProcesses) process.kill();
		this.#ownedProcesses.clear();
	}

	async #captureFrame(device: string): Promise<AndroidFrame> {
		const stdout = await this.#adb(device, ["exec-out", "screencap", "-p"], 30_000);
		const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
		if (stdout.length < 8 || stdout.length > 30_000_000 || signature.some((byte, index) => stdout[index] !== byte)) {
			throw new Error("ADB returned an invalid or oversized PNG screenshot");
		}
		this.#latest = { device, png: stdout, capturedAt: Date.now() };
		return this.#latest;
	}

	async #adb(device: string, args: string[], timeoutMs?: number): Promise<Uint8Array> {
		assertDevice(device);
		this.#assertActive();
		return this.#execute(this.#adbPath, ["-s", device, ...args], timeoutMs);
	}

	async #text(command: string, args: string[]): Promise<string> {
		return new TextDecoder().decode(await this.#execute(command, args));
	}

	async #execute(command: string, args: string[], timeoutMs?: number): Promise<Uint8Array> {
		this.#assertActive();
		const result = await this.#runner.run(command, args, { timeoutMs });
		if (result.exitCode !== 0) {
			const detail =
				result.stderr.trim() || new TextDecoder().decode(result.stdout).trim() || `exit code ${result.exitCode}`;
			throw new Error(`Android command failed: ${detail}`);
		}
		return result.stdout;
	}

	#assertInside(root: string, candidate: string): void {
		const path = relative(root, candidate);
		if (
			!path ||
			path === ".." ||
			path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
			isAbsolute(path)
		) {
			throw new Error("APK must be inside the current workspace");
		}
	}

	#assertActive(): void {
		if (this.#disposed) throw new Error("Android emulator plugin is disposed");
	}
}
