/**
 * Global dictation (Codex parity): a system shortcut records the default
 * microphone in the Electron main process, the daemon transcribes locally, and
 * the transcript is typed into whichever application has focus.
 *
 * Everything here is opt-in (`dictation.globalEnabled`). The recording never
 * focuses a MusePi window — the HUD is shown with `showInactive`, so the
 * text lands in the app the user was already using. When the native input
 * bridge cannot deliver the text, the transcript is copied to the clipboard
 * and the HUD offers the manual-paste recovery Codex uses; that is a failure
 * path, not a second mode.
 *
 * Native pieces come from `@musepi/pi-natives`:
 *   - `AudioCapture(16000)` — default microphone, mono f32
 *   - `DesktopSession.typeText("desktop", …)` — the same keyboard bridge the
 *     computer tool uses. Newer builds expose a control lease; when they do it
 *     is taken and released around the insertion.
 */
const { ipcMain } = require("electron");

const SAMPLE_RATE = 16_000;
const MAX_SECONDS = 30;
const MIN_SAMPLES = SAMPLE_RATE / 2;
const HUD_SIZE = { width: 340, height: 92 };

/** Quantise float samples so a 30 s clip stays inside one RPC frame. */
function quantizeSamples(samples) {
	const out = new Array(samples.length);
	for (let i = 0; i < samples.length; i += 1) out[i] = Math.round(samples[i] * 1000) / 1000;
	return out;
}

function rms(samples) {
	if (samples.length === 0) return 0;
	let sum = 0;
	for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
	return Math.min(1, Math.sqrt(sum / samples.length) * 3);
}

class GlobalDictation {
	constructor(deps) {
		this.BrowserWindow = deps.BrowserWindow;
		this.globalShortcut = deps.globalShortcut;
		this.screen = deps.screen;
		this.clipboard = deps.clipboard;
		this.shell = deps.shell;
		this.path = deps.path;
		this.distDir = deps.distDir;
		this.preloadPath = deps.preloadPath;
		this.request = deps.request;
		this.subscribe = deps.subscribe;
		this.ensureDaemon = deps.ensureDaemon;
		this.log = deps.log ?? (() => {});
		this.app = deps.app;

		this.enabled = false;
		this.accelerator = "";
		this.settingsTimer = null;
		this.window = null;
		this.pendingState = null;
		this.loading = false;
		this.nativeModule = null;
		this.session = null;
		this.capture = null;
		this.chunks = [];
		this.sampleCount = 0;
		this.startedAt = 0;
		this.recordTimer = null;
		this.escRegistered = false;
		this.transcript = "";
		this.phase = "hidden";
		this.locale = undefined;
		this.downloadKey = null;
		this.finishing = false;
		this.generation = 0;
		this.hideTimer = null;
		this.language = undefined;
		this.sttEnabled = true;
	}

	async start() {
		ipcMain.handle("dictation:action", (_event, payload) => this.action(payload?.type));
		this.subscribe(event => this.handleEvent(event));
		await this.syncSettings();
		this.settingsTimer = setInterval(() => void this.syncSettings(), 10_000);
		this.app?.on?.("will-quit", () => this.dispose());
	}

	async syncSettings() {
		if (!(await this.ensureDaemon())) return;
		const values = await this.request(
			"settings.get",
			{ keys: ["dictation.globalEnabled", "dictation.globalShortcut", "stt.enabled", "stt.language", "settings.locale"] },
			4000,
		);
		if (!values) return;
		if (typeof values["settings.locale"] === "string") this.locale = values["settings.locale"];
		this.language = typeof values["stt.language"] === "string" ? values["stt.language"] : undefined;
		const enabled = values["dictation.globalEnabled"] === true;
		const accelerator =
			typeof values["dictation.globalShortcut"] === "string" && values["dictation.globalShortcut"].trim()
				? values["dictation.globalShortcut"].trim()
				: "CommandOrControl+Shift+Space";
		if (enabled === this.enabled && accelerator === this.accelerator) return;
		this.unregisterShortcut();
		this.enabled = enabled;
		this.accelerator = accelerator;
		if (!enabled) return;
		try {
			const ok = this.globalShortcut.register(accelerator, () => void this.toggle());
			this.log(`global dictation shortcut ${accelerator}: ${ok ? "registered" : "unavailable"}`);
		} catch (err) {
			this.log(`global dictation shortcut failed: ${err?.message ?? err}`);
		}
	}

	unregisterShortcut() {
		if (!this.accelerator) return;
		try {
			this.globalShortcut.unregister(this.accelerator);
		} catch {
			// already gone
		}
	}

	async toggle() {
		if (this.loading || this.finishing || this.downloadKey) return;
		if (this.capture) {
			this.finishRecording();
			return;
		}
		await this.begin();
	}

	async begin() {
		
		if (!(await this.ensureDaemon())) {
			this.fail("globalDictation.noDaemon", { sticky: true });
			return;
		}
		this.loading = true;
		try {
			const status = await this.request("stt.modelStatus", {}, 6000);
			const key = status?.defaultKey ?? status?.models?.[0]?.key;
			const cached = status?.models?.find(model => model.key === key)?.cached ?? status?.defaultCached ?? false;
			if (!key) {
				this.fail("globalDictation.failed", { sticky: true });
				return;
			}
			if (!cached) {
				this.downloadKey = key;
				this.show({ phase: "downloading", percent: 0 });
				void this.request("stt.modelDownload", { modelKey: key }, 120_000);
				return; // the download event starts the recording
			}
			await this.startCapture();
		} finally {
			this.loading = false;
		}
	}

	async startCapture() {
		const native = await this.loadNative();
		if (!native) {
			this.fail("globalDictation.failed", { sticky: true });
			return;
		}
		this.chunks = [];
		this.sampleCount = 0;
		this.transcript = "";
		this.generation += 1;
		this.startedAt = Date.now();
		this.registerEscape();
		try {
			this.capture = new native.AudioCapture(SAMPLE_RATE, (error, samples) => {
				if (error) {
					this.log(`dictation capture error: ${error.message}`);
					this.abortCapture();
					this.fail("globalDictation.failed", { sticky: true });
					return;
				}
				if (!samples || samples.length === 0) return;
				this.chunks.push(samples);
				this.sampleCount += samples.length;
				if (this.sampleCount >= MAX_SECONDS * SAMPLE_RATE) this.finishRecording();
			});
		} catch (err) {
			this.log(`dictation mic failed: ${err?.message ?? err}`);
			this.fail("globalDictation.micFailed", { sticky: true });
			return;
		}
		this.show({ phase: "recording", level: 0, seconds: 0 });
		this.recordTimer = setInterval(() => this.pushRecordingState(), 100);
	}

	pushRecordingState() {
		if (!this.capture) return;
		const last = this.chunks[this.chunks.length - 1];
		this.show({
			phase: "recording",
			level: last ? rms(last) : 0,
			seconds: Math.min(MAX_SECONDS, Math.floor((Date.now() - this.startedAt) / 1000)),
		});
	}

	finishRecording() {
		if (!this.capture || this.finishing) return;
		this.finishing = true;
		this.unregisterEscape();
		if (this.recordTimer) clearInterval(this.recordTimer);
		this.recordTimer = null;
		try {
			this.capture.stop();
		} catch {
			// capture already ended
		}
		this.capture = null;
		const samples = this.flatten();
		this.chunks = [];
		if (samples.length < MIN_SAMPLES) {
			this.finishing = false;
			this.show({ phase: "error", message: "globalDictation.tooShort" });
			this.scheduleHide(1800);
			return;
		}
		void this.transcribeAndInsert(samples, this.generation)
			.catch(err => {
				this.log(`dictation transcribe failed: ${err?.message ?? err}`);
				this.fail("globalDictation.failed", { sticky: true });
			})
			.finally(() => {
				this.finishing = false;
			});
	}

	async transcribeAndInsert(samples, generation) {
		this.show({ phase: "transcribing" });
		const result = await this.request(
			"stt.transcribe",
			{ audio: quantizeSamples(samples), ...(this.language && this.language !== "auto" ? { language: this.language } : {}) },
			180_000,
		);
		if (generation !== this.generation) return;
		const text = typeof result?.text === "string" ? result.text.trim() : "";
		if (!text) {
			this.show({ phase: "error", message: "globalDictation.empty" });
			this.scheduleHide(1800);
			return;
		}
		this.transcript = text;
		this.show({ phase: "inserting" });
		if (generation !== this.generation) return;
		const inserted = await this.typeIntoFocusedApp(text);
		if (inserted) {
			this.show({ phase: "done" });
			this.scheduleHide(900);
			return;
		}
		// Codex's recovery: the text is in the clipboard and the HUD explains
		// how to paste it, instead of silently dropping the transcript.
		try {
			this.clipboard.writeText(text);
		} catch {
			// clipboard unavailable; the HUD still offers copy
		}
		this.show({ phase: "error", message: "globalDictation.pasteFailed", copy: true, settings: process.platform === "darwin" });
	}

	async typeIntoFocusedApp(text) {
		const native = await this.loadNative();
		if (!native) return false;
		try {
			this.session ||= new native.DesktopSession();
			const session = this.session;
			const hasLease = typeof session.acquireControl === "function";
			if (hasLease) {
				try {
					await session.acquireControl();
				} catch (err) {
					this.log(`dictation control lease refused: ${err?.message ?? err}`);
					return false;
				}
			}
			try {
				await session.typeText("desktop", text, { deliveryMode: "foreground" });
			} finally {
				if (hasLease) {
					try {
						session.releaseControl();
					} catch {
						// lease already gone
					}
				}
			}
			return true;
		} catch (err) {
			this.log(`dictation type failed: ${err?.message ?? err}`);
			return false;
		}
	}

	async loadNative() {
		if (this.nativeModule !== null) return this.nativeModule;
		try {
			this.nativeModule = await import("@musepi/pi-natives");
		} catch (err) {
			this.log(`dictation native load failed: ${err?.message ?? err}`);
			this.nativeModule = false;
		}
		return this.nativeModule || null;
	}

	handleEvent(event) {
		const kind = event?.kind;
		const payload = event?.payload;
		if (!this.downloadKey || !payload) return;
		if (kind !== "stt.downloadProgress" && kind !== "stt.downloadDone") return;
		if (payload.modelKey !== this.downloadKey) return;
		if (kind === "stt.downloadDone") {
			this.downloadKey = null;
			this.show({ phase: "downloading", percent: 100 });
			void this.startCapture().then(() => this.loadingDone());
			return;
		}
		const percent = Number.isFinite(payload.percent) ? payload.percent : 0;
		this.show({ phase: "downloading", percent });
	}

	loadingDone() {
		// begin() set loading for the preparation phase only.
	}

	abortCapture() {
		this.unregisterEscape();
		if (this.recordTimer) clearInterval(this.recordTimer);
		this.recordTimer = null;
		try {
			this.capture?.stop();
		} catch {
			// already stopped
		}
		this.capture = null;
		this.chunks = [];
		this.sampleCount = 0;
	}

	cancel() {
		if (!this.capture && this.phase === "hidden") return;
		this.generation += 1;
		this.downloadKey = null;
		this.abortCapture();
		this.show({ phase: "hidden" });
		this.hideHud();
	}

	flatten() {
		let total = 0;
		for (const chunk of this.chunks) total += chunk.length;
		const out = new Float32Array(total);
		let offset = 0;
		for (const chunk of this.chunks) {
			out.set(chunk, offset);
			offset += chunk.length;
		}
		return out;
	}

	registerEscape() {
		if (this.escRegistered) return;
		try {
			this.escRegistered = this.globalShortcut.register("Escape", () => this.cancel());
		} catch {
			this.escRegistered = false;
		}
	}

	unregisterEscape() {
		if (!this.escRegistered) return;
		try {
			this.globalShortcut.unregister("Escape");
		} catch {
			// already gone
		}
		this.escRegistered = false;
	}

	fail(key, opts = {}) {
		this.show({ phase: "error", message: key, copy: this.transcript.trim().length > 0, settings: process.platform === "darwin" });
		if (!opts.sticky) this.scheduleHide(2400);
	}

	scheduleHide(ms) {
		if (this.hideTimer) clearTimeout(this.hideTimer);
		this.hideTimer = setTimeout(() => {
			this.hideTimer = null;
			if (this.phase === "recording" || this.phase === "transcribing" || this.phase === "inserting") return;
			this.hideHud();
		}, ms);
	}

	action(type) {
		if (type === "cancel") {
			this.cancel();
			return;
		}
		if (type === "close") {
			this.abortCapture();
			this.hideHud();
			return;
		}
		if (type === "copy" && this.transcript) {
			try {
				this.clipboard.writeText(this.transcript);
			} catch {
				// clipboard unavailable
			}
			this.show({ phase: "done", message: "globalDictation.copied" });
			this.scheduleHide(1200);
			return;
		}
		if (type === "settings" && process.platform === "darwin") {
			void this.shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
			this.hideHud();
		}
	}

	show(state) {
		if (state.phase === "hidden") {
			this.phase = "hidden";
			return;
		}
		this.phase = state.phase;
		if (this.hideTimer && state.phase !== "error") {
			// a new phase supersedes a pending auto-hide
			clearTimeout(this.hideTimer);
			this.hideTimer = null;
		}
		const win = this.hud();
		if (!win) return;
		const payload = { ...state, locale: this.locale };
		if (win.webContents.isLoading()) {
			this.pendingState = payload;
			return;
		}
		win.webContents.send("dictation:state", payload);
		this.reveal(win);
	}

	reveal(win) {
		if (!win.isVisible()) {
			this.positionHud(win);
			win.showInactive();
		}
	}

	positionHud(win) {
		const cursor = this.screen.getCursorScreenPoint();
		const display = this.screen.getDisplayNearestPoint(cursor);
		const work = display.workArea;
		const x = Math.round(work.x + (work.width - HUD_SIZE.width) / 2);
		const y = Math.round(work.y + work.height - HUD_SIZE.height - 28);
		win.setPosition(x, y);
	}

	hud() {
		if (this.window && !this.window.isDestroyed()) return this.window;
		const win = new this.BrowserWindow({
			width: HUD_SIZE.width,
			height: HUD_SIZE.height,
			title: "MusePi Dictation",
			frame: false,
			transparent: true,
			backgroundColor: "#00000000",
			alwaysOnTop: true,
			skipTaskbar: true,
			resizable: false,
			fullscreenable: false,
			focusable: false,
			show: false,
			hasShadow: false,
			webPreferences: {
				preload: this.preloadPath,
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				backgroundThrottling: false,
			},
		});
		win.setAlwaysOnTop(true, "pop-up-menu");
		win.loadFile(this.path.join(this.distDir, "dictation.html"));
		win.webContents.on("did-finish-load", () => {
			if (this.pendingState) {
				win.webContents.send("dictation:state", this.pendingState);
				this.pendingState = null;
				this.reveal(win);
			}
		});
		this.window = win;
		return win;
	}

	hideHud() {
		this.phase = "hidden";
		if (this.window && !this.window.isDestroyed()) this.window.hide();
	}

	dispose() {
		this.unregisterShortcut();
		this.unregisterEscape();
		this.abortCapture();
		if (this.settingsTimer) clearInterval(this.settingsTimer);
		if (this.hideTimer) clearTimeout(this.hideTimer);
		try {
			this.session?.close?.();
		} catch {
			// session already closed
		}
		if (this.window && !this.window.isDestroyed()) this.window.destroy();
	}
}

module.exports = { GlobalDictation, quantizeSamples, rms, MIN_SAMPLES, MAX_SECONDS, SAMPLE_RATE };