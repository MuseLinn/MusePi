import type { ReactNode } from "react";
import { mapPoint, type ScreenRect } from "../geometry";
import "./emulator-panel.css";

declare const React: {
	createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => ReactNode;
	useEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => void;
	useRef: <T>(initial: T) => { current: T };
	useState: <T>(initial: T) => [T, (value: T | ((current: T) => T)) => void];
};

interface ScreenImage {
	readonly naturalWidth: number;
	readonly naturalHeight: number;
	getBoundingClientRect(): ScreenRect;
	setPointerCapture?(pointerId: number): void;
}

interface ScreenPointerEvent {
	readonly button: number;
	readonly pointerId: number;
	readonly clientX: number;
	readonly clientY: number;
	readonly currentTarget: ScreenImage;
}

interface AndroidDevice {
	id: string;
	state: string;
	model: string | null;
}

interface Frame {
	device: string;
	data: string;
	mimeType: string;
	capturedAt: number;
}

interface PanelProps {
	extensionCall?: (method: string, params?: unknown) => Promise<unknown>;
	sessionId?: string | null;
	cwd?: string;
	panelTab?: { target: string | null };
}

interface Gesture {
	pointerId: number;
	x: number;
	y: number;
	lastX: number;
	lastY: number;
	startedAt: number;
	moved: boolean;
}

const NAMESPACE = "android-emulator";
const DICTIONARIES: Record<string, Record<string, string>> = {
	"zh-CN": {
		title: "Android 模拟器",
		device: "设备",
		avd: "本地 AVD",
		refresh: "刷新设备",
		start: "启动并等待开机",
		loading: "正在连接 Android 设备…",
		empty: "未发现设备。请启动模拟器或连接已启用 ADB 的设备。",
		unavailable: "此面板需要扩展 RPC 连接。",
		back: "返回",
		home: "主页",
		recents: "最近任务",
		textPlaceholder: "输入单行 ASCII 文本",
		sendText: "发送文本",
		apkPlaceholder: "工作区内的 app-debug.apk",
		install: "安装 APK",
		componentPlaceholder: "包名/.MainActivity",
		launch: "启动 Activity",
		screenshot: "下载截图",
		inspect: "读取 UI 树",
		logcat: "读取日志",
		packagePlaceholder: "可选包名，用于过滤日志",
		debug: "应用调试",
		screenAlt: "Android 设备实时画面，可点按或滑动",
	},
	"en-US": {
		title: "Android Emulator",
		device: "Device",
		avd: "Local AVD",
		refresh: "Refresh devices",
		start: "Start and wait for boot",
		loading: "Connecting to Android devices…",
		empty: "No devices found. Start an emulator or connect an ADB-enabled device.",
		unavailable: "This panel requires the extension RPC connection.",
		back: "Back",
		home: "Home",
		recents: "Recents",
		textPlaceholder: "Single-line ASCII text",
		sendText: "Send text",
		apkPlaceholder: "app-debug.apk inside the workspace",
		install: "Install APK",
		componentPlaceholder: "package/.MainActivity",
		launch: "Launch activity",
		screenshot: "Download screenshot",
		inspect: "Read UI tree",
		logcat: "Read logcat",
		packagePlaceholder: "Optional package name for log filtering",
		debug: "App debugging",
		screenAlt: "Live Android screen; tap or swipe to operate",
	},
};

function t(key: string): string {
	return window.MusePiI18n?.bind(NAMESPACE)(key) ?? DICTIONARIES["zh-CN"]![key] ?? key;
}

export function apply(ctx: { effect(dispose: () => void): void }): void {
	window.MusePiI18n?.register(NAMESPACE, DICTIONARIES);
	ctx.effect(() => window.MusePiI18n?.unregister(NAMESPACE));
}

export function AndroidEmulatorPanel({ extensionCall, panelTab }: PanelProps): ReactNode {
	const h = React.createElement;
	const [devices, setDevices] = React.useState<AndroidDevice[]>([]);
	const [avds, setAvds] = React.useState<string[]>([]);
	const [device, setDevice] = React.useState(panelTab?.target ?? "");
	const [avd, setAvd] = React.useState("");
	const [frame, setFrame] = React.useState<Frame | null>(null);
	const [error, setError] = React.useState("");
	const [busy, setBusy] = React.useState(false);
	const [loaded, setLoaded] = React.useState(false);
	const [text, setText] = React.useState("");
	const [apkPath, setApkPath] = React.useState("app-debug.apk");
	const [component, setComponent] = React.useState("");
	const [packageName, setPackageName] = React.useState("");
	const [output, setOutput] = React.useState("");
	const image = React.useRef<ScreenImage | null>(null);
	const gesture = React.useRef<Gesture | null>(null);

	const refresh = async () => {
		if (!extensionCall) return;
		try {
			const result = (await extensionCall("devices")) as { devices: AndroidDevice[]; avds: string[] };
			setDevices(result.devices);
			setAvds(result.avds);
			setDevice(current =>
				result.devices.some(item => item.id === current)
					? current
					: ((result.devices.find(item => item.state === "device") ?? result.devices[0])?.id ?? ""),
			);
			setAvd(current => current || result.avds[0] || "");
			setError("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLoaded(true);
		}
	};

	React.useEffect(() => {
		if (!extensionCall) return;
		void extensionCall("subscribe").catch(() => undefined);
		void refresh();
		return () => {
			void extensionCall("unsubscribe").catch(() => undefined);
		};
	}, [extensionCall]);

	React.useEffect(() => {
		if (!extensionCall || !device) {
			setFrame(null);
			return;
		}
		let active = true;
		let timer: Parameters<typeof clearTimeout>[0] | undefined;
		const poll = async () => {
			try {
				const next = (await extensionCall("frame", { device })) as Frame;
				if (active && next.device === device) setFrame(next);
			} catch (cause) {
				if (active) setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				if (active) timer = setTimeout(poll, 1000);
			}
		};
		void poll();
		return () => {
			active = false;
			if (timer !== undefined) clearTimeout(timer);
		};
	}, [extensionCall, device]);

	const perform = async (method: string, params: Record<string, unknown> = {}, showOutput = false) => {
		if (!extensionCall || busy) return;
		setBusy(true);
		setError("");
		try {
			const result = (await extensionCall(method, { device, ...params })) as { xml?: string; logs?: string };
			if (showOutput) setOutput(result.xml ?? result.logs ?? "");
			if (method === "text") setText("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};

	const point = (event: ScreenPointerEvent) => {
		const target = image.current;
		return target
			? mapPoint(
					target.getBoundingClientRect(),
					{ width: target.naturalWidth, height: target.naturalHeight },
					{ x: event.clientX, y: event.clientY },
				)
			: null;
	};

	const pointerDown = (event: ScreenPointerEvent) => {
		if (event.button !== 0 || !point(event)) return;
		event.currentTarget.setPointerCapture?.(event.pointerId);
		gesture.current = {
			pointerId: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			lastX: event.clientX,
			lastY: event.clientY,
			startedAt: Date.now(),
			moved: false,
		};
	};

	const pointerMove = (event: ScreenPointerEvent) => {
		const current = gesture.current;
		if (!current || current.pointerId !== event.pointerId) return;
		current.lastX = event.clientX;
		current.lastY = event.clientY;
		current.moved ||= Math.hypot(event.clientX - current.x, event.clientY - current.y) >= 6;
	};

	const pointerUp = (event: ScreenPointerEvent) => {
		const current = gesture.current;
		gesture.current = null;
		if (!current || current.pointerId !== event.pointerId) return;
		const start = point({ ...event, clientX: current.x, clientY: current.y });
		const end = point({ ...event, clientX: current.lastX, clientY: current.lastY });
		if (!start || !end) return;
		if (current.moved) {
			void perform("swipe", {
				x: start.x,
				y: start.y,
				x2: end.x,
				y2: end.y,
				durationMs: Math.min(2000, Math.max(100, Date.now() - current.startedAt)),
			});
		} else {
			void perform("tap", { x: start.x, y: start.y });
		}
	};

	if (!extensionCall) return h("div", { className: "android-emulator-state", role: "alert" }, t("unavailable"));
	const disabled = busy || !device;
	const src = frame ? `data:${frame.mimeType};base64,${frame.data}` : undefined;

	return h(
		"main",
		{ className: "android-emulator" },
		h(
			"header",
			{ className: "android-emulator-header" },
			h("h2", null, t("title")),
			h(
				"label",
				null,
				h("span", null, t("device")),
				h(
					"select",
					{
						value: device,
						onChange: (event: { target: { value: string } }) => setDevice(event.target.value),
						"aria-label": t("device"),
					},
					!devices.length && h("option", { value: "" }, "—"),
					devices.map(item =>
						h(
							"option",
							{ key: item.id, value: item.id },
							`${item.model ?? item.id} · ${item.id} · ${item.state}`,
						),
					),
				),
			),
			h("button", { type: "button", onClick: () => void refresh(), disabled: busy }, t("refresh")),
			h(
				"label",
				null,
				h("span", null, t("avd")),
				h(
					"select",
					{
						value: avd,
						onChange: (event: { target: { value: string } }) => setAvd(event.target.value),
						"aria-label": t("avd"),
					},
					!avds.length && h("option", { value: "" }, "—"),
					avds.map(item => h("option", { key: item, value: item }, item)),
				),
			),
			h(
				"button",
				{ type: "button", onClick: () => void perform("start", { avd }), disabled: busy || !avd },
				t("start"),
			),
		),
		error && h("div", { className: "android-emulator-error", role: "alert" }, error),
		h(
			"section",
			{ className: "android-emulator-stage", "aria-label": t("title") },
			src
				? h("img", {
						ref: image,
						className: "android-emulator-screen",
						src,
						alt: t("screenAlt"),
						draggable: false,
						onPointerDown: pointerDown,
						onPointerMove: pointerMove,
						onPointerUp: pointerUp,
						onPointerCancel: () => {
							gesture.current = null;
						},
					})
				: h("div", { className: "android-emulator-state" }, loaded ? t("empty") : t("loading")),
		),
		h(
			"nav",
			{ className: "android-emulator-nav", "aria-label": "Android" },
			h("button", { type: "button", disabled, onClick: () => void perform("key", { key: "BACK" }) }, t("back")),
			h("button", { type: "button", disabled, onClick: () => void perform("key", { key: "HOME" }) }, t("home")),
			h(
				"button",
				{ type: "button", disabled, onClick: () => void perform("key", { key: "RECENTS" }) },
				t("recents"),
			),
		),
		h(
			"section",
			{ className: "android-emulator-controls", "aria-label": t("debug") },
			h(
				"div",
				{ className: "android-emulator-row" },
				h("input", {
					value: text,
					onChange: (event: { target: { value: string } }) => setText(event.target.value),
					placeholder: t("textPlaceholder"),
					"aria-label": t("textPlaceholder"),
				}),
				h(
					"button",
					{ type: "button", disabled: disabled || !text, onClick: () => void perform("text", { text }) },
					t("sendText"),
				),
			),
			h(
				"div",
				{ className: "android-emulator-row" },
				h("input", {
					value: apkPath,
					onChange: (event: { target: { value: string } }) => setApkPath(event.target.value),
					placeholder: t("apkPlaceholder"),
					"aria-label": t("apkPlaceholder"),
				}),
				h(
					"button",
					{ type: "button", disabled, onClick: () => void perform("install", { apkPath }) },
					t("install"),
				),
			),
			h(
				"div",
				{ className: "android-emulator-row" },
				h("input", {
					value: component,
					onChange: (event: { target: { value: string } }) => setComponent(event.target.value),
					placeholder: t("componentPlaceholder"),
					"aria-label": t("componentPlaceholder"),
				}),
				h(
					"button",
					{ type: "button", disabled, onClick: () => void perform("launch", { component }) },
					t("launch"),
				),
			),
			h(
				"div",
				{ className: "android-emulator-row" },
				h("input", {
					value: packageName,
					onChange: (event: { target: { value: string } }) => setPackageName(event.target.value),
					placeholder: t("packagePlaceholder"),
					"aria-label": t("packagePlaceholder"),
				}),
				h("button", { type: "button", disabled, onClick: () => void perform("uiTree", {}, true) }, t("inspect")),
				h(
					"button",
					{
						type: "button",
						disabled,
						onClick: () => void perform("logcat", { packageName: packageName || undefined }, true),
					},
					t("logcat"),
				),
			),
			src &&
				h(
					"a",
					{ className: "android-emulator-download", href: src, download: `${device}-screenshot.png` },
					t("screenshot"),
				),
			output && h("pre", { className: "android-emulator-output", tabIndex: 0 }, output),
		),
	);
}

export default AndroidEmulatorPanel;

declare const window: {
	MusePiI18n?: {
		register(namespace: string, dictionaries: Record<string, Record<string, string>>): void;
		unregister(namespace: string): void;
		bind(namespace: string): (key: string) => string;
	};
};
