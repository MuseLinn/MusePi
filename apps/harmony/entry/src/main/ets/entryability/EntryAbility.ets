import { AbilityConstant, Configuration, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { display, window } from '@kit.ArkUI';
// `BusinessError` is a type, not a global: every AsyncCallback below needs it.
import { BusinessError } from '@kit.BasicServicesKit';
import { foldFormOf, Insets, FoldForm } from '../common/window-model';

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
 * Window state lives here, not in the page: avoid areas, IME height, the
 * system colour mode, the window size and the fold form are window/config
 * events, and the page's `harmonyNative` bridge must answer synchronously — so
 * all of them are published into AppStorage and the page reads the last value.
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
	private onFoldStatusChange: ((status: display.FoldStatus) => void) | null = null;

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
				// 3. Avoid areas, window size and the fold form.
				this.publishInsets(win);
				this.publishMetrics(win);
				this.publishFoldForm();
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
		if (win) {
			try {
				if (this.onAvoidAreaChange) win.off('avoidAreaChange', this.onAvoidAreaChange);
				if (this.onKeyboardHeightChange) win.off('keyboardHeightChange', this.onKeyboardHeightChange);
				if (this.onWindowSizeChange) win.off('windowSizeChange', this.onWindowSizeChange);
			} catch (e) {
				hilog.warn(DOMAIN, TAG, 'off window events failed: %{public}s', JSON.stringify(e));
			}
		}
		// The fold listener is display-scoped, not window-scoped: it must be
		// removed with the same function reference that registered it.
		if (this.onFoldStatusChange && display.isFoldable()) {
			try {
				display.off('foldStatusChange', this.onFoldStatusChange);
			} catch (e) {
				hilog.warn(DOMAIN, TAG, 'off fold status failed: %{public}s', JSON.stringify(e));
			}
		}
		this.onAvoidAreaChange = null;
		this.onKeyboardHeightChange = null;
		this.onWindowSizeChange = null;
		this.onFoldStatusChange = null;
		this.win = null;
	}

	/**
	 * Publish the four avoid-area edges in vp as a JSON string the page's
	 * `getSystemBars()` can return without awaiting anything.
	 *
	 * All four edges matter, not just the vertical pair: in landscape a
	 * punch-hole sits on the *side*, and an unfolded foldable can grow these
	 * areas on any edge. The page consumes them as `--safe-left` /
	 * `--safe-right`, which were previously always 0 from this shell.
	 *
	 * TYPE_SYSTEM carries the status bar, the gesture bar lives in
	 * TYPE_NAVIGATION_INDICATOR (not TYPE_SYSTEM.bottomRect) and the camera
	 * cutout in TYPE_CUTOUT — so each edge takes the largest of the three.
	 */
	private publishInsets(win: window.Window): void {
		try {
			const system = win.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
			const nav = win.getWindowAvoidArea(window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR);
			const cutout = win.getWindowAvoidArea(window.AvoidAreaType.TYPE_CUTOUT);
			const density = display.getDefaultDisplaySync().densityPixels;
			const scale = density > 0 ? density : 1;
			const toVp = (px: number): number => (px > 0 ? Math.round(px / scale) : 0);
			const insets: Insets = {
				top: toVp(Math.max(system.topRect.height, cutout.topRect.height, 0)),
				bottom: toVp(Math.max(nav.bottomRect.height, system.bottomRect.height, 0)),
				left: toVp(Math.max(cutout.leftRect.width, system.leftRect.width, 0)),
				right: toVp(Math.max(cutout.rightRect.width, system.rightRect.width, 0)),
			};
			AppStorage.setOrCreate('systemInsets', JSON.stringify(insets));
		} catch (e) {
			// avoid areas unreachable — the page's env() fallback stands
			hilog.warn(DOMAIN, TAG, 'avoid area failed: %{public}s', JSON.stringify(e));
		}
	}

	/**
	 * Publish the window size in vp for the *first* layout pass.
	 *
	 * The page derives everything from `onAreaChange`, but that fires after the
	 * first frame: without a seeded value an unfolded foldable or a tablet
	 * paints one frame of phone chrome (bottom bar) before switching to the
	 * rail, which reads as a jump on every cold start.
	 */
	private publishMetrics(win: window.Window): void {
		try {
			const rect = win.getWindowProperties().windowRect;
			const density = display.getDefaultDisplaySync().densityPixels;
			const scale = density > 0 ? density : 1;
			AppStorage.setOrCreate('windowSizeVp', JSON.stringify({
				width: Math.round(rect.width / scale),
				height: Math.round(rect.height / scale),
			}));
		} catch (e) {
			hilog.warn(DOMAIN, TAG, 'window metrics failed: %{public}s', JSON.stringify(e));
		}
	}

	/**
	 * Publish the fold form and keep it current.
	 *
	 * Width alone already covers folded ↔ expanded (they differ in vp), so this
	 * is not what drives the chrome. It exists for the states width cannot
	 * describe: hover mode (half folded) has almost the width of the expanded
	 * screen, and the sheets must land in the lower pane instead of straddling
	 * the crease — see Index.sheetOptions().
	 */
	private publishFoldForm(): void {
		let form: FoldForm = 'unknown';
		try {
			if (display.isFoldable()) {
				form = foldFormOf(display.getFoldStatus());
			}
		} catch (e) {
			hilog.warn(DOMAIN, TAG, 'fold status failed: %{public}s', JSON.stringify(e));
		}
		AppStorage.setOrCreate('foldForm', form);
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
		this.onWindowSizeChange = (size: window.Size): void => {
			this.publishInsets(win);
			this.publishMetrics(win);
			// Split screen, a free window and an unfolded foldable all arrive
			// here; the fold form can flip without moving the avoid areas.
			this.publishFoldForm();
		};
		try {
			win.on('avoidAreaChange', this.onAvoidAreaChange);
			win.on('keyboardHeightChange', this.onKeyboardHeightChange);
			win.on('windowSizeChange', this.onWindowSizeChange);
		} catch (e) {
			hilog.warn(DOMAIN, TAG, 'window events failed: %{public}s', JSON.stringify(e));
		}
		if (display.isFoldable()) {
			this.onFoldStatusChange = (status: display.FoldStatus): void => {
				AppStorage.setOrCreate('foldForm', foldFormOf(status));
				// A hinge turning moves the avoid areas on some products.
				this.publishInsets(win);
			};
			try {
				display.on('foldStatusChange', this.onFoldStatusChange);
			} catch (e) {
				hilog.warn(DOMAIN, TAG, 'fold listener failed: %{public}s', JSON.stringify(e));
			}
		}
	}
}
