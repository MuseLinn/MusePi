import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { display, window } from '@kit.ArkUI';
// `BusinessError` is a type, not a global: every AsyncCallback below needs it.
import { BusinessError } from '@kit.BasicServicesKit';

const TAG: string = 'MusePiEntry';
const DOMAIN: number = 0x0000;

/**
 * MusePi WebView shell entry ability.
 *
 * Deep links (`musepi://connect?link=<collab link>`) arrive as Want URIs:
 * - Cold start: onCreate stores the URI in AppStorage; the page's JS drains
 *   it via harmonyNative.consumeDeepLink() once the bridge is up.
 * - Warm start: onNewWant updates the same AppStorage key; the Index page
 *   watches it (@StorageLink + @Watch) and pushes into the page via
 *   runJavaScript('window.__harmonyDeepLink("...")').
 *
 * Window state lives here, not in the page: avoid areas and the IME height are
 * window events, and the page's `harmonyNative` bridge must answer
 * synchronously — so both are published into AppStorage and the page reads the
 * last value (systemInsets / imeHeightPx).
 */
export default class EntryAbility extends UIAbility {
	private win: window.Window | null = null;
	private onAvoidAreaChange: ((options: window.AvoidAreaOptions) => void) | null = null;
	private onKeyboardHeightChange: ((height: number) => void) | null = null;

	onCreate(want: Want, _launchParam: AbilityConstant.LaunchParam): void {
		hilog.info(DOMAIN, TAG, 'onCreate');
		const uri = want?.uri ?? '';
		if (uri.startsWith('musepi://')) {
			AppStorage.setOrCreate('pendingDeepLink', uri);
		}
	}

	onNewWant(want: Want, _launchParam: AbilityConstant.LaunchParam): void {
		hilog.info(DOMAIN, TAG, 'onNewWant');
		const uri = want?.uri ?? '';
		if (uri.startsWith('musepi://')) {
			// Index watches this key and pushes into the live page.
			AppStorage.setOrCreate('pendingDeepLink', uri);
		}
	}

	onWindowStageCreate(windowStage: window.WindowStage): void {
		hilog.info(DOMAIN, TAG, 'onWindowStageCreate');
		windowStage.getMainWindow((err: BusinessError, win: window.Window) => {
			if (err) {
				hilog.error(DOMAIN, TAG, 'getMainWindow failed: %{public}s', JSON.stringify(err));
				return;
			}
			this.win = win;
			// Immersive: draw under the system bars from the first frame.
			win.setWindowLayoutFullScreen(true).catch((e: BusinessError) => {
				hilog.warn(DOMAIN, TAG, 'layoutFullScreen failed: %{public}s', JSON.stringify(e));
			});
			this.publishInsets(win);
			this.subscribeWindowEvents(win);
		});
		windowStage.loadContent('pages/Index', (err) => {
			if (err.code) {
				hilog.error(DOMAIN, TAG, 'loadContent failed: %{public}s', JSON.stringify(err));
			}
		});
	}

	onWindowStageDestroy(): void {
		const win = this.win;
		if (!win) {
			return;
		}
		try {
			if (this.onAvoidAreaChange) win.off('avoidAreaChange', this.onAvoidAreaChange);
			if (this.onKeyboardHeightChange) win.off('keyboardHeightChange', this.onKeyboardHeightChange);
		} catch (e) {
			hilog.warn(DOMAIN, TAG, 'off window events failed: %{public}s', JSON.stringify(e));
		}
		this.onAvoidAreaChange = null;
		this.onKeyboardHeightChange = null;
		this.win = null;
	}

	/**
	 * Publish the status-bar and navigation insets as a JSON string the page's
	 * `getSystemBars()` can return without awaiting anything.
	 */
	private publishInsets(win: window.Window): void {
		try {
			const sys = win.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
			const density = display.getDefaultDisplaySync().densityPixels;
			const scale = density > 0 ? density : 1;
			const json = JSON.stringify({
				top: Math.round(sys.topRect.height / scale),
				bottom: Math.round(sys.bottomRect.height / scale),
			});
			AppStorage.setOrCreate('systemInsets', json);
		} catch (e) {
			// avoid areas unreachable — keep the page's fixed allowance
			hilog.warn(DOMAIN, TAG, 'avoid area failed: %{public}s', JSON.stringify(e));
		}
	}

	/**
	 * Window events the page cannot subscribe to itself: rotation/cutout changes
	 * and the soft keyboard. The IME height also drives "back dismisses the
	 * keyboard first" in `Index.onBackPress()`.
	 */
	private subscribeWindowEvents(win: window.Window): void {
		this.onAvoidAreaChange = (_options: window.AvoidAreaOptions): void => {
			this.publishInsets(win);
		};
		this.onKeyboardHeightChange = (height: number): void => {
			AppStorage.setOrCreate('imeHeightPx', height);
		};
		try {
			win.on('avoidAreaChange', this.onAvoidAreaChange);
			win.on('keyboardHeightChange', this.onKeyboardHeightChange);
		} catch (e) {
			hilog.warn(DOMAIN, TAG, 'window events failed: %{public}s', JSON.stringify(e));
		}
	}
}
