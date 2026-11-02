/**
 * 能力缝声明（索引：docs/capability-seams.md「Android 模拟器插件」）：
 * - 名称+ns：`android-emulator` Cordis 插件、扩展隔离的 RPC 方法、
 *   `android_emulator` Agent 工具、`panel.tab.android-emulator` 插槽。
 * - 输入：ADB/Emulator 可执行文件配置、设备与 AVD 标识、设备像素手势、
 *   工作区内 APK、Activity、UI tree/logcat 查询。
 * - 输出：设备/AVD 清单、PNG 帧与模型可见截图、输入执行结果、UI tree、logcat、
 *   右侧面板交互。
 * - 生命周期：挂载时创建共享服务；面板订阅仅跟踪消费者；卸载取消引用并等待
 *   在途截图，只终止本插件启动的模拟器。
 * - 启停：普通插件启用/禁用与 Cordis fiber 一致；无全局常驻采集。
 * - 冲突：独占 `android-emulator.*` RPC 与同名工具；共享 ADB 服务，设备操作按
 *   各自命令执行，截图采集串行且仅缓存最新帧。
 * - 检视入口：`src/bundled-plugins/android-emulator/`、`docs/extensions-dev.md`。
 */
import type { ExtensionAPI, ExtensionRpcHandler } from "../../extensibility/extensions/types";
import { AndroidDeviceService } from "./android-service";
import { createAndroidEmulatorTool } from "./tools";

export const name = "musepi-android-emulator";
export const inject = [] as const;
export const provide = [] as const;

interface DeviceParams {
	device: string;
}

function params<T>(value: unknown): T {
	if (!value || typeof value !== "object") throw new Error("Android emulator parameters must be an object");
	return value as T;
}

function frameResult(frame: { device: string; png: Uint8Array; capturedAt: number }) {
	return {
		device: frame.device,
		capturedAt: frame.capturedAt,
		data: Buffer.from(frame.png).toString("base64"),
		mimeType: "image/png",
	};
}

export function apply(pi: ExtensionAPI): void {
	pi.setLabel("MusePi Android 模拟器");
	const ready = Promise.all([pi.config.get<string>("adbPath"), pi.config.get<string>("emulatorPath")]).then(
		([adbPath, emulatorPath]) =>
			new AndroidDeviceService({ adbPath: adbPath || undefined, emulatorPath: emulatorPath || undefined }),
	);
	const service = () => ready;
	const register = (
		method: string,
		handler: (service: AndroidDeviceService, value: unknown, cwd: string) => unknown | Promise<unknown>,
	) => {
		const rpc: ExtensionRpcHandler = async (value, ctx) => handler(await ready, value, ctx.cwd);
		pi.registerRpc(method, rpc);
	};

	register("devices", async android => {
		const [devices, avds] = await Promise.all([android.devices(), android.avds().catch(() => [])]);
		return { devices, avds };
	});
	register("start", async (android, value) => android.start(params<{ avd: string }>(value).avd));
	register("subscribe", android => ({ subscribers: android.subscribe() }));
	register("unsubscribe", android => ({ subscribers: android.unsubscribe() }));
	register("frame", async (android, value) => frameResult(await android.frame(params<DeviceParams>(value).device)));
	register("screenshot", async (android, value) =>
		frameResult(await android.frame(params<DeviceParams>(value).device, true)),
	);
	register("tap", async (android, value) => {
		const input = params<DeviceParams & { x: number; y: number }>(value);
		await android.tap(input.device, input.x, input.y);
		return { device: input.device };
	});
	register("swipe", async (android, value) => {
		const input = params<DeviceParams & { x: number; y: number; x2: number; y2: number; durationMs?: number }>(value);
		await android.swipe(input.device, { x: input.x, y: input.y }, { x: input.x2, y: input.y2 }, input.durationMs);
		return { device: input.device };
	});
	register("key", async (android, value) => {
		const input = params<DeviceParams & { key: string }>(value);
		await android.key(input.device, input.key);
		return { device: input.device };
	});
	register("text", async (android, value) => {
		const input = params<DeviceParams & { text: string }>(value);
		await android.text(input.device, input.text);
		return { device: input.device };
	});
	register("install", async (android, value, cwd) => {
		const input = params<DeviceParams & { apkPath: string }>(value);
		return android.install(input.device, cwd, input.apkPath);
	});
	register("launch", async (android, value) => {
		const input = params<DeviceParams & { component: string }>(value);
		await android.launch(input.device, input.component);
		return { device: input.device };
	});
	register("uiTree", async (android, value) => ({
		device: params<DeviceParams>(value).device,
		xml: await android.uiTree(params<DeviceParams>(value).device),
	}));
	register("logcat", async (android, value) => {
		const input = params<DeviceParams & { lines?: number; packageName?: string }>(value);
		return { device: input.device, logs: await android.logcat(input.device, input) };
	});

	pi.registerTool(createAndroidEmulatorTool(pi.arktype, service()));
	pi.registerToolView("android_emulator", {
		moduleUrl: "./ui/tool-view.tsx",
		label: "Android 模拟器",
	});
	pi.registerComponent({
		slot: "panel.tab.android-emulator",
		moduleUrl: "./ui/emulator-panel.tsx",
		label: "Android 模拟器",
		order: 30,
		availability: "on-demand",
	});
	pi.effect?.(() => {
		void ready.then(android => android.dispose());
	});
}

export default apply;
