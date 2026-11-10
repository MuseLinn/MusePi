import { AbilityConstant, Configuration, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit';
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
 * Window state lives here, not in the page: avoid areas, IME height and the
 * system colour mode are window/config events, and the page's `harmonyNative`
 * bridge must answer synchronously — so all of them are published into
 * AppStorage and the page reads the last value.
 *
 * Immersive layout follows Huawei's "窗口全屏布局方案": full-screen must be
 * requested AFTER loadContent has attached the page, otherwise the component
 * tree can still be laid out inside the safe area and the window background
 * shows through as white strips above/below the WebView.
 */
export default class EntryAbility extends UIAbility {
	private win: window.Window | null = null;
	private onAvoidAreaChange: ((options: window.AvoidAreaOptions) => void) | null = null;
	private onKeyboardHeightChange: ((height: number) => void) | null = null;
	private onWindowSizeChange: ((size: window.Size) => void) | null = null;

	onCreate(want: Want, _launchParam: AbilityConstant.LaunchParam): void {
		hilog.info(DOMAIN, TAG, 'onCreate');
		this.publishColorMode(this.context.config.colorMode);
		const uri = want?.uri ?? '';
		if (uri.startsWith('musepi://')) {
			AppStorage.setOrCreate('pendingDeepLink', uri);
		}
	}

	/** System light/dark flip — page mirrors it through __harmonyColorMode. */
	onConfigurationUpdate(newConfig: Configuration): void {
		this.publishColorMode(newConfig.colorMode);
	}

	private publishColorMode(mode: number | undefined): void {
		const dark = mode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
		AppStorage.setOrCreate('systemColorMode', dark ? 'dark' : 'light');
		// Boot value only; afterwards the page's own resolved scheme wins
		// (the user may override the system inside the app).
		if (AppStorage.get<boolean>('themeDark') === undefined) {
			AppStorage.setOrCreate('themeDark', dark);
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
		windowStage.loadContent('pages/Index', (err) => {
			if (err.code) {
				hilog.error(DOMAIN, TAG, 'loadContent failed: %{public}s', JSON.stringify(err));
				return;
			}
			try {
				const win = windowStage.getMainWindowSync();
				this.win = win;
				// 1. Window-level immersive layout (after content is attached).
				win.setWindowLayoutFullScreen(true).catch((e: BusinessError) => {
					hilog.warn(DOMAIN, TAG, 'layoutFullScreen failed: %{public}s', JSON.stringify(e));
				});
				// 2. Transparent status bar + readable system icons, matching
				//    the page's scheme (see Index.setThemeColor).
				this.applySystemBarStyle(win);
				// 3. Avoid areas + dynamic window events.
				this.publishInsets(win);
				this.subscribeWindowEvents(win);
			} catch (e) {
				hilog.warn(DOMAIN, TAG, 'main window setup failed: %{public}s', JSON.stringify(e));
			}
		});
	}

	/** Keep the status bar transparent and its content readable on both schemes. */
	private applySystemBarStyle(win: window.Window): void {
		const dark = AppStorage.get<boolean>('themeDark') ?? true;
		win.setWindowSystemBarProperties({
			statusBarColor: '#00000000',
			statusBarContentColor: dark ? '#E5FFFFFF' : '#FF1A1A1A',
			navigationBarColor: '#00000000',
			navigationBarContentColor: dark ? '#E5FFFFFF' : '#FF1A1A1A',
		}).catch((e: BusinessError) => {
			hilog.warn(DOMAIN, TAG, 'systemBarProperties failed: %{public}s', JSON.stringify(e));
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
			if (this.onWindowSizeChange) win.off('windowSizeChange', this.onWindowSizeChange);
		} catch (e) {
			hilog.warn(DOMAIN, TAG, 'off window events failed: %{public}s', JSON.stringify(e));
		}
		this.onAvoidAreaChange = null;
		this.onKeyboardHeightChange = null;
		this.onWindowSizeChange = null;
		this.win = null;
	}

	/**
	 * Publish status-bar and navigation-indicator insets as a JSON string the
	 * page's `getSystemBars()` can return without awaiting anything.
	 *
	 * TYPE_SYSTEM carries the status bar; the gesture bar lives in
	 * TYPE_NAVIGATION_INDICATOR (not TYPE_SYSTEM.bottomRect), which is why the
	 * old code often reported a zero bottom inset. Wide foldables also grow
	 * these areas when unfolded, so re-read on every avoid-area/size change.
	 */
	private publishInsets(win: window.Window): void {
		try {
			const sys = win.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
			const nav = win.getWindowAvoidArea(window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR);
			const density = display.getDefaultDisplaySync().densityPixels;
			const scale = density > 0 ? density : 1;
			const topPx = Math.max(sys.topRect.height, 0);
			const bottomPx = Math.max(nav.bottomRect.height, sys.bottomRect.height, 0);
			const json = JSON.stringify({
				top: Math.round(topPx / scale),
				bottom: Math.round(bottomPx / scale),
			});
			AppStorage.setOrCreate('systemInsets', json);
		} catch (e) {
			// avoid areas unreachable — the page's env() fallback stands
			hilog.warn(DOMAIN, TAG, 'avoid area failed: %{public}s', JSON.stringify(e));
		}
	}

	/**
	 * Window events the page cannot subscribe to itself: rotation/cutout/fold
	 * changes, the soft keyboard and window resizing. The IME height also
	 * drives "back dismisses the keyboard first" in `Index.onBackPress()`.
	 */
	private subscribeWindowEvents(win: window.Window): void {
		this.onAvoidAreaChange = (_options: window.AvoidAreaOptions): void => {
			this.publishInsets(win);
		};
		this.onKeyboardHeightChange = (height: number): void => {
			AppStorage.setOrCreate('imeHeightPx', height);
		};
		this.onWindowSizeChange = (_size: window.Size): void => {
			this.publishInsets(win);
		};
		try {
			win.on('avoidAreaChange', this.onAvoidAreaChange);
			win.on('keyboardHeightChange', this.onKeyboardHeightChange);
			win.on('windowSizeChange', this.onWindowSizeChange);
		} catch (e) {
			hilog.warn(DOMAIN, TAG, 'window events failed: %{public}s', JSON.stringify(e));
		}
	}
}
