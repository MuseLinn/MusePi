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
const MAX_SECONDS = 600;
const MIN_SAMPLES = SAMPLE_RATE / 2;
const HUD_SIZE = { width: 300, height: 190 };

/** Quantise float samples so streamed chunks stay inside one RPC frame. */
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

const CJK_CHAR = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/u;

function appendTranscript(base, addition) {
	const text = (addition ?? "").trim();
	if (!text) return base;
	if (base && !CJK_CHAR.test(base.at(-1)) && !CJK_CHAR.test(text[0])) return `${base} ${text}`;
	return `${base}${text}`;
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

		this.dictationTargets = new Map();
		this.createKeyMonitor = deps.createKeyMonitor;
		this.keyMonitor = null;
		this.trigger = "toggle";
		this.holdActive = false;
		this.holdInternalTarget = null;
		this.enabled = false;
		this.accelerator = "";
		this.settingsTimer = null;
		this.window = null;
		this.pendingState = null;
		this.loading = false;
		this.nativeModule = null;
		this.session = null;
		this.capture = null;
		this.sampleCount = 0;
		this.lastLevel = 0;
		this.sessionId = null;
		this.streamQueue = Promise.resolve();
		this.streamSegments = new Map();
		this.streamPartial = "";
		this.streamPartialId = null;
		this.startedAt = 0;
		this.recordTimer = null;
		this.escRegistered = false;
		this.transcript = "";
		this.phase = "hidden";
		this.locale = undefined;
		this.downloadKey = null;
		this.finishing = false;
		this.generation = 0;
		this.registered = null;
		this.hideTimer = null;
		this.language = undefined;
		this.modelKey = "balanced";
		this.speakerMode = "off";
		this.enhanceAudio = false;
		this.sttEnabled = true;
	}

	async start() {
		ipcMain.handle("dictation:action", (_event, payload) => this.action(payload?.type));
		ipcMain.handle("dictation:target", (event, payload) => this.setDictationTarget(event, payload));
		ipcMain.handle("dictation:status", () => ({
			enabled: this.enabled,
			accelerator: this.accelerator,
			registered: this.registered,
		}));
		this.subscribe(event => this.handleEvent(event));
		await this.syncSettings();
		this.settingsTimer = setInterval(() => void this.syncSettings(), 10_000);
		this.app?.on?.("will-quit", () => this.dispose());
	}

	async syncSettings() {
		if (!(await this.ensureDaemon())) return;
		const values = await this.request(
			"settings.get",
			{ keys: ["dictation.globalEnabled", "dictation.globalShortcut", "dictation.globalTrigger", "stt.enabled", "stt.language", "stt.modelName", "stt.speakerMode", "stt.enhanceAudio", "settings.locale"] },
			4000,
		);
		if (!values) return;
		if (typeof values["settings.locale"] === "string") this.locale = values["settings.locale"];
		this.language = typeof values["stt.language"] === "string" ? values["stt.language"] : undefined;
		this.modelKey = typeof values["stt.modelName"] === "string" && values["stt.modelName"].trim() ? values["stt.modelName"].trim() : "balanced";
		this.speakerMode = ["off", "prefer", "strict"].includes(values["stt.speakerMode"]) ? values["stt.speakerMode"] : "off";
		this.enhanceAudio = values["stt.enhanceAudio"] === true;
		const enabled = values["dictation.globalEnabled"] === true;
		const accelerator =
			typeof values["dictation.globalShortcut"] === "string" && values["dictation.globalShortcut"].trim()
				? values["dictation.globalShortcut"].trim()
				: "CommandOrControl+Alt+Space";
		const trigger = values["dictation.globalTrigger"] === "hold" ? "hold" : "toggle";
		if (enabled === this.enabled && accelerator === this.accelerator && trigger === this.trigger) return;
		this.unregisterShortcut();
		this.enabled = enabled;
		this.accelerator = accelerator;
		this.trigger = trigger;
		if (!enabled) {
			this.registered = null;
			return;
		}
		if (trigger === "hold") {
			try {
				if (process.platform !== "win32") throw new Error("hold-to-talk is only supported on Windows");
				const monitor = await this.createHoldMonitor(accelerator);
				if (!this.enabled || this.trigger !== "hold" || this.accelerator !== accelerator) {
					monitor.close();
					return;
				}
				this.keyMonitor = monitor;
				this.registered = true;
			} catch (err) {
				this.registered = false;
				this.log(`global dictation hold shortcut failed: ${err?.message ?? err}; using toggle fallback`);
				this.registerToggleShortcut(accelerator);
				this.registered = false;
			}
			return;
		}
		this.registerToggleShortcut(accelerator);
	}

	registerToggleShortcut(accelerator) {
		try {
			const ok = this.globalShortcut.register(accelerator, () => void this.toggle());
			this.registered = ok;
			this.log(`global dictation shortcut ${accelerator}: ${ok ? "registered" : "unavailable"}`);
		} catch (err) {
			this.registered = false;
			this.log(`global dictation shortcut failed: ${err?.message ?? err}`);
		}
	}

	async createHoldMonitor(accelerator) {
		const callback = event => this.handleHoldEvent(event, accelerator);
		if (this.createKeyMonitor) return this.createKeyMonitor(accelerator, callback);
		const native = await this.loadNative();
		if (!native?.DictationKeyMonitor) throw new Error("native hold-to-talk monitor unavailable");
		return new native.DictationKeyMonitor(accelerator, callback);
	}

	async handleHoldEvent(event, accelerator) {
		if (!this.enabled || this.trigger !== "hold" || this.accelerator !== accelerator) return;
		if (event === "press") {
			if (this.holdActive || this.loading || this.finishing || this.downloadKey || this.capture) return;
			this.holdActive = true;
			const target = this.routeInternalShortcut();
			if (target) {
				this.holdInternalTarget = target;
				return;
			}
			await this.begin();
			return;
		}
		if (event === "release") {
			if (!this.holdActive) return;
			this.holdActive = false;
			const target = this.holdInternalTarget;
			this.holdInternalTarget = null;
			if (target) {
				this.sendInternalTarget(target);
				return;
			}
			if (this.capture) this.finishRecording();
		}
	}

	unregisterShortcut() {
		this.keyMonitor?.close();
		this.keyMonitor = null;
		this.holdActive = false;
		this.holdInternalTarget = null;
		if (!this.accelerator) return;
		try {
			this.globalShortcut.unregister(this.accelerator);
		} catch {
			// already gone
		}
	}

	setDictationTarget(event, payload) {
		const sender = event.sender;
		const id = sender.id;
		const state = { focused: payload?.focused === true, active: payload?.active === true };
		if (!state.focused && !state.active) {
			this.dictationTargets.delete(id);
			return;
		}
		if (!this.dictationTargets.has(id)) {
			sender.once?.("destroyed", () => this.dictationTargets.delete(id));
		}
		this.dictationTargets.set(id, state);
	}

	sendInternalTarget(id) {
		const win = this.BrowserWindow.getAllWindows().find(candidate => candidate.webContents.id === id);
		if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false;
		win.webContents.send("dictation:toggle");
		return true;
	}

	routeInternalShortcut() {
		for (const [id, state] of this.dictationTargets) {
			if (state.active && this.sendInternalTarget(id)) return id;
		}
		const focused = this.BrowserWindow.getFocusedWindow();
		if (!focused) return null;
		const state = this.dictationTargets.get(focused.webContents.id);
		return state?.focused === true && this.sendInternalTarget(focused.webContents.id) ? focused.webContents.id : null;
	}

	async toggle() {
		if (this.loading || this.finishing || this.downloadKey) return;
		if (this.routeInternalShortcut()) return;
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
			this.modelKey = key || this.modelKey;
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
		this.sampleCount = 0;
		this.lastLevel = 0;
		this.transcript = "";
		this.generation += 1;
		const generation = this.generation;
		this.streamSegments.clear();
		this.streamPartial = "";
		this.streamPartialId = null;
		this.streamQueue = Promise.resolve();
		try {
			const started = await this.request(
				"voice.frontendStreamStart",
				{
					modelKey: this.modelKey,
					...(this.language && this.language !== "auto" ? { language: this.language } : {}),
					speakerMode: this.speakerMode,
					enhanceAudio: this.enhanceAudio,
				},
				45_000,
			);
			if (generation !== this.generation || !started?.sessionId) return;
			this.sessionId = started.sessionId;
			this.startedAt = Date.now();
			this.registerEscape();
			this.capture = new native.AudioCapture(SAMPLE_RATE, (error, samples) => {
				if (generation !== this.generation) return;
				if (error) {
					this.log(`dictation capture error: ${error.message}`);
					this.abortCapture();
					this.fail("globalDictation.failed", { sticky: true });
					return;
				}
				if (!samples || samples.length === 0) return;
				this.sampleCount += samples.length;
				this.lastLevel = rms(samples);
				this.queueStreamAudio(samples, generation);
				if (this.sampleCount >= MAX_SECONDS * SAMPLE_RATE) this.finishRecording();
			});
		} catch (err) {
			this.log(`dictation mic/stream failed: ${err?.message ?? err}`);
			this.clearStream();
			this.fail("globalDictation.micFailed", { sticky: true });
			return;
		}
		this.show({ phase: "recording", level: 0, seconds: 0, partialText: "" });
		this.recordTimer = setInterval(() => this.pushRecordingState(), 100);
		if (this.trigger === "hold" && !this.holdActive && generation === this.generation) {
			queueMicrotask(() => this.finishRecording());
		}
	}

	queueStreamAudio(samples, generation) {
		const sessionId = this.sessionId;
		const audio = quantizeSamples(samples);
		this.streamQueue = this.streamQueue.then(async () => {
			if (generation !== this.generation || sessionId !== this.sessionId) return;
			await this.request("voice.frontendStreamAudio", { sessionId, audio }, 180_000);
		});
		void this.streamQueue.catch(err => {
			if (generation !== this.generation) return;
			this.log(`dictation audio stream failed: ${err?.message ?? err}`);
			this.abortCapture();
			this.fail("globalDictation.failed", { sticky: true });
		});
	}

	pushRecordingState() {
		if (!this.capture) return;
		this.show({
			phase: "recording",
			level: this.lastLevel,
			seconds: Math.min(MAX_SECONDS, Math.floor((Date.now() - this.startedAt) / 1000)),
			partialText: this.displayTranscript(),
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
		const sessionId = this.sessionId;
		if (this.sampleCount < MIN_SAMPLES || !sessionId) {
			if (sessionId) void this.request("voice.frontendStreamCancel", { sessionId }).catch(() => {});
			this.clearStream();
			this.finishing = false;
			this.show({ phase: "error", message: "globalDictation.tooShort" });
			this.scheduleHide(1800);
			return;
		}
		void this.transcribeAndInsert(sessionId, this.generation)
			.catch(err => {
				this.log(`dictation transcribe failed: ${err?.message ?? err}`);
				this.fail("globalDictation.failed", { sticky: true });
			})
			.finally(() => {
				this.finishing = false;
			});
	}

	async transcribeAndInsert(sessionId, generation) {
		this.show({ phase: "transcribing", partialText: this.displayTranscript() });
		await this.streamQueue;
		if (generation !== this.generation || sessionId !== this.sessionId) return;
		const result = await this.request("voice.frontendStreamStop", { sessionId }, 180_000);
		if (generation !== this.generation) return;
		for (const [segmentId, segment] of (result?.results ?? []).entries()) {
			if (segment.text && segment.state !== "reject") this.streamSegments.set(segmentId, segment.text);
		}
		const text = (typeof result?.text === "string" ? result.text.trim() : "") || this.finalizedTranscript();
		this.clearStream();
		if (!text) {
			this.show({ phase: "error", message: "globalDictation.empty" });
			this.scheduleHide(1800);
			return;
		}
		this.transcript = text;
		this.show({ phase: "inserting", partialText: text });
		if (generation !== this.generation) return;
		const inserted = await this.typeIntoFocusedApp(text);
		if (inserted) {
			this.show({ phase: "done", partialText: text });
			this.scheduleHide(900);
			return;
		}
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

	finalizedTranscript() {
		return [...this.streamSegments.entries()]
			.sort(([left], [right]) => left - right)
			.reduce((text, [, segment]) => appendTranscript(text, segment), "");
	}

	displayTranscript() {
		return appendTranscript(this.finalizedTranscript(), this.streamPartial);
	}

	clearStream() {
		this.sessionId = null;
		this.streamSegments.clear();
		this.streamPartial = "";
		this.streamPartialId = null;
	}

	handleEvent(event) {
		const kind = event?.kind;
		const payload = event?.payload;
		if (!payload) return;
		if (payload.sessionId && payload.sessionId === this.sessionId) {
			if (payload.type === "voice.frontendPartial") {
				this.streamPartial = payload.state === "reject" ? "" : (payload.text ?? "");
				this.streamPartialId = payload.segmentId;
				this.pushRecordingState();
				return;
			}
			if (payload.type === "voice.frontendSegment") {
				if (payload.state === "reject") this.streamSegments.delete(payload.segmentId);
				else this.streamSegments.set(payload.segmentId, payload.text ?? "");
				if (this.streamPartialId === payload.segmentId) {
					this.streamPartial = "";
					this.streamPartialId = null;
				}
				this.pushRecordingState();
				return;
			}
		}
		if (!this.downloadKey) return;
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
		this.sampleCount = 0;
		this.lastLevel = 0;
	}

	cancel() {
		if (!this.capture && this.phase === "hidden") return;
		this.downloadKey = null;
		const sessionId = this.sessionId;
		if (sessionId) void this.request("voice.frontendStreamCancel", { sessionId }).catch(() => {});
		this.generation += 1;
		this.clearStream();
		this.abortCapture();
		this.show({ phase: "hidden" });
		this.hideHud();
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