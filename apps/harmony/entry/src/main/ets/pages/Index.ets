import { webview } from '@kit.ArkWeb';
import { curves, display, uiMaterial, window } from '@kit.ArkUI';
import { notificationManager } from '@kit.NotificationKit';
import { abilityAccessCtrl, bundleManager, ConfigurationConstant, Permissions } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { deviceInfo } from '@kit.BasicServicesKit';
import { liveViewManager } from '@kit.LiveViewKit';
import { scanBarcode, scanCore } from '@kit.ScanKit';
import BuildProfile from 'BuildProfile';
import {
	ChromeLayout,
	Insets,
	WindowMetrics,
	clampPaneWidth,
	listPaneWidthOf,
	metricsOf,
	parseInsets,
} from '../common/window-model';
import { PREF_KEYS, PrefsStore } from '../common/prefs';
import { MuseSettings, animateSettingsPush } from '../components/MuseSettings';

/**
 * MusePi WebView shell — loads the client-core mobile bundle from rawfile and
 * exposes the `harmonyNative` javaScriptProxy bridge (same surface the page
 * expects; see packages/client-core/src/lib/capacitor.ts).
 *
 * Bridge contract (all methods synchronous, JSON-string returns):
 * - getSystemBars(): '{"top":<vp>,"bottom":<vp>,"left":<vp>,"right":<vp>}'
 * - getColorMode(): '"dark"' | '"light"' — authoritative OS colour mode
 * - setThemeColor(dark) — page scheme → window background + system bar icons
 * - getBadge(): '{"count":<n>}' — launcher badge number
 * - setBadgeCount(n) / clearBadge() — badge updates
 * - consumeDeepLink(): pending `musepi://` URI or '' (drained once)
 * - setBackDepth(n) — page's back-layer depth, mirrored for `onBackPress`
 * - getChromeLayout(): '"bottom"' | '"rail"'
 * - getWindowForm(): '{"width":"md","height":"flat","fold":"expanded","rail":84}'
 *
 * Native → page pushes (via runJavaScript):
 * - window.__harmonyDeepLink("<uri>")  — warm-start deep links
 * - window.__harmonyKeyboard(<vp>)     — IME height changes
 * - window.__harmonyColorMode("<mode>")— system light/dark flips
 * - window.__harmonyChrome(layout, railWidth, bottomReserve)
 * - window.__harmonyWindow(formJson)   — breakpoint / fold form changes
 *
 * Window state (insets, IME height, colour mode, size, fold form) is published
 * by EntryAbility into AppStorage: all of them are window/config events, and
 * this bridge must answer synchronously, so the page mirrors the last value
 * instead of querying.
 *
 * Back key: `onBackPress()` below walks the native settings stack, then the
 * IME, then the page's layer stack (`window.__harmonyBack()`), then falls
 * through to the system.
 */
/**
 * Live View scenario id. HarmonyOS only renders a Live View whose `event`
 * matches a scenario approved in AppGallery Connect, so this is a placeholder
 * MusePi would register; an unapproved value just resolves to "disabled".
 */
const MUSEPI_LIVE_VIEW_EVENT: string = 'MUSEPI_AGENT_SESSION';

/** Bar content height, per the HarmonyOS floating tab bar spec. */
const BAR_HEIGHT: number = 56;
/** Breathing room above the bar and between the bar and the gesture area. */
const BAR_GAP: number = 8;
/** Launcher-bar height (`BAR_HEIGHT`) plus both gaps — never the raw bar. */
const BAR_BLOCK: number = BAR_HEIGHT + BAR_GAP * 2;
/** Rail row rhythm; 72vp keeps a 44vp-plus touch target with label. */
const RAIL_ROW_MIN: number = 64;
/** Hit strip for the session-column divider (the visible grip is 3vp). */
const PANE_HANDLE: number = 14;

/**
 * One row of the native session sheet. Every string arrives already localized
 * by the page (title, shortened path, message count, relative time), so the
 * sheet renders text and reports the chosen id — it owns no session state and
 * no translations.
 */
interface HarmonySessionRow {
	id: string;
	title: string;
	cwd: string;
	meta: string;
	when: string;
	current: boolean;
	working: boolean;
}

/** One destination in the side rail shown on tablet / unfolded / landscape. */
interface MuseSideTab {
	index: number;
	icon: Resource;
	label: Resource;
}

/** Payload of `openSessionsSheet` / `setSessions`. */
interface HarmonySessionPayload {
	current: string;
	sessions: HarmonySessionRow[];
}

/**
 * One saved computer of the native connect page. The page pushes public
 * metadata only — the collab link (with its E2E key and write token) never
 * leaves the page; tapping a row reports the id back and the page resolves
 * the credential and connects.
 */
interface ConnectHostRow {
	id: string;
	label: string;
	/** Relay hint or the computer's own name — the distinguishing subtitle. */
	subtitle: string;
}

/** Mirror of the page's connect guide state, pushed via `setConnectInfo`. */
interface ConnectInfoPayload {
	skipped: boolean;
	offline: boolean;
	error: string;
}

/** Window size in vp as seeded by EntryAbility before the first layout pass. */
interface MuseWindowSizeVp {
	width?: number;
	height?: number;
}

/** Form pushed to the page so its CSS can pick its own reading column. */
interface MuseWindowForm {
	width: string;
	height: string;
	fold: string;
	rail: number;
}

/** Shape of the javaScriptProxy bridge the page calls. */
interface MuseBridgeObject {
	getSystemBars: () => string;
	getColorMode: () => string;
	setThemeColor: (dark: boolean) => void;
	setAccentColor: (hex: string) => void;
	getPrefs: () => string;
	setPref: (key: string, value: string) => void;
	setAccentPalette: (json: string) => void;
	getBadge: () => string;
	setBadgeCount: (count: number) => void;
	clearBadge: () => void;
	consumeDeepLink: () => string;
	setBackDepth: (depth: number) => void;
	setActiveTab: (index: number) => void;
	getChromeLayout: () => string;
	getWindowForm: () => string;
	setTabBarVisible: (visible: boolean) => void;
	openCameraSettings: () => void;
	getCameraDiagnostics: () => string;
	setTabBarMaterial: (style: number) => void;
	openPairSheet: () => void;
	openLinkSheet: () => void;
	closeConnectSheet: () => void;
	openSessionsSheet: (payload: string) => void;
	setSessions: (payload: string) => void;
	setConnectInfo: (payload: string) => void;
	setHosts: (payload: string) => void;
	setLiveView: (active: boolean, title: string, detail: string) => void;
}

@Entry
@Component
struct Index {
	controller: webview.WebviewController = new webview.WebviewController();
	@StorageLink('pendingDeepLink') @Watch('onDeepLinkChanged') pendingDeepLink: string = '';
	/** Four-arm inset JSON published by EntryAbility from the window avoid areas. */
	@StorageLink('systemInsets') @Watch('onInsetsChanged') systemInsets: string =
		'{"top":0,"bottom":0,"left":0,"right":0}';
	/** Window size in vp, seeded by EntryAbility for the first layout pass. */
	@StorageLink('windowSizeVp') windowSizeVp: string = '';
	/** OS colour mode, published by EntryAbility on boot / config change. */
	@StorageLink('systemColorMode') @Watch('onSystemColorModeChanged') systemColorMode: string = 'dark';
	/** Foldable form (`unknown|folded|expanded|half|dual`), published by EntryAbility. */
	@StorageLink('foldForm') @Watch('onFoldFormChanged') foldForm: string = 'unknown';
	/** Resolved page scheme — drives the native window background + bar icons. */
	@StorageLink('themeDark') themeDark: boolean = true;
	/** Soft-keyboard height in px (0 = no IME), published by EntryAbility. */
	@StorageLink('imeHeightPx') @Watch('onImeChanged') imeHeightPx: number = 0;
	private badgeCount: number = 0;
	/** API level of the running device — gates symbols newer than the floor. */
	private readonly apiLevel: number = deviceInfo.sdkApiVersion;
	/** HarmonyOS Live View（实况窗）session capsule. */
	private liveViewId: number = 20261110;
	private liveViewRunning: boolean = false;
	private liveViewStarted: boolean = false;
	/** Layer depth mirrored from the page (`harmonyNative.setBackDepth`). */
	private backDepth: number = 0;
	/** Main window, used for the system-bar style after a theme flip. */
	private hostWindow: window.Window | null = null;
	/**
	 * Bottom tab bar destination (0 connect / 1 chat / 2 settings). The page is
	 * the source of truth — it owns the connect/session state — so this mirrors
	 * `window.__musepiTab` pushes and reports user taps back through
	 * `harmonyNative.setActiveTab`.
	 */
	@State activeTab: number = 0;
	/**
	 * The destination the WebView is actually showing.
	 *
	 * Settings is a native overlay now, so tapping 设置 highlights the bar
	 * without moving the page — and closing the overlay has to restore the
	 * highlight to whatever the page still displays. Two numbers, because one
	 * would leave the bar pointing at a page that is not on screen.
	 */
	@State webTab: number = 0;
	/** Native settings overlay (HarmonyOS owns settings; the page does not). */
	@State @Watch('onSettingsOpenChanged') settingsOpen: boolean = false;
	/**
	 * Which level of the settings stack is showing (`hub` or one of its
	 * sections). Owned here rather than inside the overlay because the back KEY
	 * is handled by this page: closing the whole overlay from a section would
	 * skip the level the user expects to land on first.
	 */
	@State settingsPage: string = 'hub';
	/** `{theme,brand,mono,ocean,jade}` → hex, pushed by the page so the accent
	 *  swatches show the colour they will actually apply. */
	@State accentPalette: string = '{}';
	/** Full-screen overlays (QR scanner) hide the chrome; page pushes this. */
	@State tabBarVisible: boolean = true;
	/**
	 * Current window form. Width and aspect ratio only — no device list: fold
	 * state, orientation, split screen and a resized free window all arrive as
	 * the same area change, and every one of them deserves the same answer.
	 */
	@State metrics: WindowMetrics = metricsOf(360, 780);
	/** Bar material thickness (0 REGULAR / 1 THICK / 2 THIN / 3 ULTRA_THIN). */
	@State materialStyle: number = 0;
	/**
	 * Remembered session-column width in vp. 0 means "whatever the breakpoint
	 * prescribes" — a drag is a deliberate act, so it sticks across launches,
	 * while a window that never dragged keeps adapting to its width.
	 */
	@State paneWidthPref: number = 0;
	/** Width at drag start: the pan delta is absolute, so it needs an origin. */
	private paneDragFrom: number = 0;
	/** True while the divider is being dragged (grip grows, tints). */
	@State paneDragging: boolean = false;
	/** "What's new" card, shown once per version (see `maybeShowWhatsNew`). */
	@State whatsNewOpen: boolean = false;
	private appVersion: string = '';
	/** Connect-form sheet: '' closed, 'pair' pair code, 'link' remote link.
	 * A modal sheet replaces the web accordion — expanding a card in place made
	 * the whole guide jump between one and two rows. */
	@State sheetKind: string = '';
	@State sheetVisible: boolean = false;
	@State pairCode: string = '';
	@State pairHost: string = '';
	@State linkUrl: string = '';
	@State linkName: string = '';
	/** Native session switcher: rows fed by the page, one intent sent back. */
	@State sessionSheetOpen: boolean = false;
	@State sessionRows: HarmonySessionRow[] = [];
	@State sessionQuery: string = '';
	/** Filter typed into the wide-window list column (not the sheet's). */
	@State paneQuery: string = '';
	/** Connect guide mirror (skipped / offline / error), pushed by the page. */
	@State connectSkipped: boolean = false;
	@State connectOffline: boolean = false;
	@State connectError: string = '';
	/** Saved computers of the native connect page, pushed by the page. */
	@State connectHosts: ConnectHostRow[] = [];
	private tabsController: TabsController = new TabsController();
	/** True while the page itself is moving the bar, so onChange is not echoed back. */
	private tabFromPage: boolean = false;
	/**
	 * Localized "selected" announcement, resolved once.
	 *
	 * `accessibilityDescription` has separate `string` and `Resource`
	 * overloads, so a `Resource | ''` ternary matches neither; resolving to a
	 * plain string here keeps the hand-built rail semantically selectable for
	 * a screen reader instead of silent.
	 */
	private selectedLabel: string = '';

	aboutToAppear(): void {
		this.loadAccessibilityLabels();
		// Seed the window form before the first frame. `onAreaChange` only fires
		// after layout, so without this an unfolded foldable or a tablet paints
		// one frame of phone chrome and then jumps to the rail.
		this.seedWindowSize();
		// Settings live here now: open the preference store before the first
		// overlay build, otherwise the first open would show defaults and the
		// user's choice would appear to reset.
		const prefsCtx = this.getUIContext().getHostContext();
		if (prefsCtx) {
			PrefsStore.init(prefsCtx);
			this.themeDark = PrefsStore.get('theme', 'system') === 'dark' ||
				(PrefsStore.get('theme', 'system') === 'system' && this.themeDark);
			this.materialStyle = Number(PrefsStore.get('tabBarMaterial', '0'));
			this.paneWidthPref = Number(PrefsStore.get('paneWidth', '0')) || 0;
			try {
				this.appVersion = bundleManager.getBundleInfoForSelfSync(0).versionName;
			} catch (e) {
				this.appVersion = '';
			}
			this.maybeShowWhatsNew();
		}
		// Debug builds expose the WebView to the Chrome DevTools Protocol so an
		// attached inspector can read the DOM and console that ArkUI's layout
		// dump cannot show. Release builds keep the surface closed.
		if (BuildProfile.DEBUG) {
			webview.WebviewController.setWebDebuggingAccess(true);
		}
		webview.WebviewController.initializeWebEngine();
		const ctx = this.getUIContext().getHostContext();
		if (!ctx) {
			console.warn('[musepi] host context unavailable — bar style keeps its boot value');
			return;
		}
		window.getLastWindow(ctx).then((win: window.Window) => {
			this.hostWindow = win;
			this.applySystemBarStyle(this.themeDark);
		}).catch((e: BusinessError) => {
			console.warn(`[musepi] main window unavailable: ${JSON.stringify(e)}`);
		});
	}

	private seedWindowSize(): void {
		try {
			const parsed: MuseWindowSizeVp = JSON.parse(this.windowSizeVp) as MuseWindowSizeVp;
			const width = typeof parsed.width === 'number' ? parsed.width : 0;
			const height = typeof parsed.height === 'number' ? parsed.height : 0;
			if (width > 0 && height > 0) {
				this.metrics = metricsOf(width, height);
			}
		} catch (e) {
			// No seed (documented zero) — onAreaChange supplies the real value.
		}
	}

	private loadAccessibilityLabels(): void {
		try {
			const res = this.getUIContext().getHostContext()?.resourceManager;
			if (res) {
				this.selectedLabel = res.getStringSync($r('app.string.a11y_selected').id);
			}
		} catch (e) {
			// Resource manager unavailable — the state simply goes unannounced.
			this.selectedLabel = '';
		}
	}

	/** Warm-start deep link landed while the page is live — push it in. */
	onDeepLinkChanged(): void {
		const uri = this.pendingDeepLink;
		if (uri === '' || uri === undefined) {
			return;
		}
		this.pushDeepLink(uri);
	}

	/** OS scheme changed while the app was running — let the page follow it. */
	onSystemColorModeChanged(): void {
		const mode = this.systemColorMode === 'light' ? 'light' : 'dark';
		this.controller.runJavaScript(`window.__harmonyColorMode && window.__harmonyColorMode("${mode}")`)
			.catch(() => {});
	}

	/**
	 * Insets changed (rotation, cutout, fold, split screen).
	 *
	 * The chrome geometry is inset-aware (bar clearance, rail padding) and the
	 * page reserves a different bottom strip, so both have to be re-pushed —
	 * `systemInsets` is the only thing that changes when a phone rotates
	 * without the window resizing.
	 */
	onInsetsChanged(): void {
		this.pushChromeLayout();
	}

	/**
	 * Fold form changed.
	 *
	 * The chrome itself is width-driven on purpose, but a hinge turning without
	 * a size change (some products report it late) still has to reach the page:
	 * it decides whether a modal may straddle the crease.
	 */
	onFoldFormChanged(): void {
		this.pushWindowForm();
	}

	/**
	 * IME height changed (window event, forwarded through AppStorage).
	 *
	 * The page sizes the composer from `--mp-keyboard-inset` — the shell keeps
	 * the WebView at full height, exactly like the Android shell's
	 * `Keyboard resize: 'none'`.
	 */
	onImeChanged(): void {
		const vp = this.pxToVp(this.imeHeightPx);
		this.controller.runJavaScript(`window.__harmonyKeyboard && window.__harmonyKeyboard(${vp})`)
			.catch(() => {});
	}

	/**
	 * Hardware/gesture back.
	 *
	 * Same idea as the Android shell's `setupAndroidBackHandler` — the app's own
	 * layers first, the system last — with the native settings overlay ahead of
	 * both: it is a destination painted over the page, so nothing in the page
	 * can be the topmost layer while it is open. HarmonyOS gives this callback
	 * only a synchronous answer, while `runJavaScript` is async — so both facts
	 * it needs are already mirrored natively: the IME height from the window
	 * event, and the layer depth from `harmonyNative.setBackDepth` (pushed on
	 * every register/unregister).
	 *
	 * Returning `false` hands the press back to the system (background the
	 * ability), which is what "back on the root screen" should do.
	 */
	onBackPress(): boolean {
		// The native settings overlay is the topmost layer: back walks its own
		// stack before the page sees the key, exactly like a system app. A
		// section goes back to the hub; the hub closes settings. A docked page
		// has no hub of its own (the list is always beside the section), so
		// there back closes the overlay directly.
		if (this.settingsOpen) {
			if (!this.settingsWide() && this.settingsPage !== 'hub') {
				animateSettingsPush(this.getUIContext(), () => {
					this.settingsPage = 'hub';
				});
				return true;
			}
			this.settingsOpen = false;
			return true;
		}
		if (this.imeHeightPx > 0) {
			// Blurring inside the page dismisses the IME without an IMEKit
			// dependency — same primitive the Android shell uses.
			this.controller
				.runJavaScript('(function(){var e=document.activeElement;if(e&&e.blur){e.blur();}return "1";})()')
				.catch(() => {});
			return true;
		}
		if (this.backDepth > 0) {
			this.controller.runJavaScript('window.__harmonyBack && window.__harmonyBack()')
				.catch(() => {});
			return true;
		}
		return false;
	}

	/** Page-side mirror of the back-layer depth (see capacitor.ts). */
	private setBackDepth(depth: number): void {
		this.backDepth = depth;
	}

	/**
	 * ArkWeb refuses CORS requests from `resource://rawfile/` (opaque origin),
	 * which is exactly what Vite's `crossorigin` module script and stylesheet
	 * emit — the page opens, every asset is blocked, and #root stays empty.
	 * Serve the same rawfile assets from a private https origin instead: the
	 * requests are same-origin, and the shell still decides what is reachable.
	 * See Huawei guide "解决Web组件本地资源跨域问题", method one.
	 */
	private readonly origin: string = 'https://musepi.local';

	/** MIME type for a hashed Vite asset (or any other rawfile). */
	private mimeFor(path: string): string {
		const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
		switch (ext) {
			case 'html': return 'text/html';
			case 'js':
			case 'mjs': return 'text/javascript';
			case 'css': return 'text/css';
			case 'json':
			case 'map': return 'application/json';
			case 'webmanifest': return 'application/manifest+json';
			case 'woff2': return 'font/woff2';
			case 'woff': return 'font/woff';
			case 'ttf': return 'font/ttf';
			case 'png': return 'image/png';
			case 'jpg':
			case 'jpeg': return 'image/jpeg';
			case 'svg': return 'image/svg+xml';
			case 'ico': return 'image/x-icon';
			case 'txt': return 'text/plain';
			default: return 'application/octet-stream';
		}
	}

	private pushDeepLink(uri: string): void {
		const escaped = uri.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
		this.controller.runJavaScript(`window.__harmonyDeepLink && window.__harmonyDeepLink("${escaped}")`)
			.then(() => {
				// Delivered: drain the stash so a later page reload cannot replay
				// a link the user has already acted on. A push that never resolved
				// (page not ready) leaves it for `onPageEnd`/`consumeDeepLink()`.
				if ((AppStorage.get<string>('pendingDeepLink') ?? '') === uri) {
					AppStorage.setOrCreate('pendingDeepLink', '');
				}
			})
			.catch(() => {
				// page not ready — leave stashed; consumeDeepLink() drains on mount
			});
	}

	/** px → vp (vp == CSS px in ArkWeb, matching the Android shell's dp). */
	private pxToVp(px: number): number {
		try {
			const d = display.getDefaultDisplaySync();
			const density = d.densityPixels > 0 ? d.densityPixels : 1;
			return Math.round(px / density);
		} catch (e) {
			// Display unreachable — 1:1 is the documented ArkWeb default.
			return Math.round(px);
		}
	}

	private systemBars(): string {
		return this.systemInsets;
	}

	private getColorMode(): string {
		return this.systemColorMode === 'light' ? 'light' : 'dark';
	}

	/** Page flipped its theme: keep the window background and bar icons in sync. */
	private setThemeColor(dark: boolean): void {
		AppStorage.setOrCreate('themeDark', dark);
		this.applySystemBarStyle(dark);
		// The immersive light-sense material samples the SYSTEM colour mode,
		// not the page's data-theme. Forcing dark in the app while the OS was
		// light left a white material bar on a dark page, so pin the app-level
		// colour mode to the page's resolved scheme.
		this.applyAppColorMode(dark);
	}

	/** Pin the app-level colour mode to the page's resolved scheme. */
	private applyAppColorMode(dark: boolean): void {
		const ctx = this.getUIContext().getHostContext();
		if (!ctx) {
			return;
		}
		try {
			ctx.getApplicationContext().setColorMode(
				dark
					? ConfigurationConstant.ColorMode.COLOR_MODE_DARK
					: ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT,
			);
		} catch (e) {
			console.warn(`[musepi] setColorMode failed: ${JSON.stringify(e)}`);
		}
	}

	private applySystemBarStyle(dark: boolean): void {
		const win = this.hostWindow;
		if (!win) return;
		win.setWindowSystemBarProperties({
			statusBarColor: '#00000000',
			statusBarContentColor: dark ? '#E5FFFFFF' : '#FF1A1A1A',
			navigationBarColor: '#00000000',
			navigationBarContentColor: dark ? '#E5FFFFFF' : '#FF1A1A1A',
		}).catch((e: BusinessError) => {
			console.warn(`[musepi] system bar style failed: ${JSON.stringify(e)}`);
		});
	}

	/**
	 * App-level grant for one device permission.
	 *
	 * The system dialog carries the reason declared for the permission in
	 * `module.json5`, so the caller has to name the permission it actually
	 * needs: a voice-only capture request that asked for CAMERA made the
	 * microphone dialog explain QR scanning.
	 *
	 * An existing grant is checked first: `requestPermissionsFromUser()`
	 * returns -1 without a dialog once the user has denied it, which surfaced
	 * as a silent NotAllowedError on the page.
	 */
	private async ensurePermission(permission: Permissions): Promise<boolean> {
		try {
			const ctx = this.getUIContext().getHostContext();
			if (!ctx) return false;
			const atManager = abilityAccessCtrl.createAtManager();
			try {
				const status = atManager.checkAccessTokenSync(ctx.applicationInfo.accessTokenId, permission);
				if (status === abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED) {
					return true;
				}
			} catch {
				// checkAccessTokenSync unavailable — fall through to the request
			}
			const result = await atManager.requestPermissionsFromUser(ctx, [permission]);
			return result.authResults.length > 0 && result.authResults[0] === 0;
		} catch (e) {
			console.warn(`[musepi] ${permission} request failed: ${JSON.stringify(e)}`);
			return false;
		}
	}

	/**
	 * Camera grant for the QR scanner.
	 *
	 * ArkWeb needs BOTH the app-level CAMERA user grant and the web
	 * PermissionRequest grant before getUserMedia can feed the scanner; only
	 * our private bundled origin is ever granted, so a remote page cannot
	 * reach device resources through this shell.
	 */
	private async ensureCameraPermission(): Promise<boolean> {
		const granted = await this.ensurePermission('ohos.permission.CAMERA');
		AppStorage.setOrCreate('cameraAuthResult', granted ? '[0]' : '[-1]');
		return granted;
	}

	/** Microphone grant for voice input. Same two-gate rule as the camera: this
	 *  is the user's decision, `onPermissionRequest` is the page's. */
	private ensureMicrophonePermission(): Promise<boolean> {
		return this.ensurePermission('ohos.permission.MICROPHONE');
	}

	/**
	 * Resolve one web capture request against the app-level grants.
	 *
	 * `getAccessibleResource()` returns every device the page asked for in one
	 * list, but each entry is a separate HarmonyOS permission with its own
	 * dialog: the request is answered per resource, and a resource the user
	 * refused denies the whole request (ArkWeb has no per-resource deny, and
	 * `getUserMedia` treats a partial grant as a failed stream).
	 */
	private async grantWebCapture(request: PermissionRequest, resources: string[],
		needsCamera: boolean, needsMic: boolean): Promise<void> {
		try {
			const cameraGranted = !needsCamera || await this.ensureCameraPermission();
			const micGranted = !needsMic || await this.ensureMicrophonePermission();
			if (!cameraGranted || !micGranted) {
				request.deny();
				return;
			}
			request.grant(resources);
		} catch (e) {
			console.warn(`[musepi] capture grant failed: ${JSON.stringify(e)}`);
			request.deny();
		}
	}

	/**
	 * Opens the system permission page for the camera. Used when the user has
	 * already denied the dialog: from then on HarmonyOS returns -1 without
	 * showing it again, so the page needs an explicit way back in.
	 */
	openCameraSettings(): void {
		const ctx = this.getUIContext().getHostContext();
		if (!ctx) return;
		abilityAccessCtrl.createAtManager()
			.requestPermissionOnSetting(ctx, ['ohos.permission.CAMERA'])
			.catch((e: BusinessError) => {
				console.warn(`[musepi] open camera settings failed: ${JSON.stringify(e)}`);
			});
	}

	/** Diagnostic readout: what origin asked for the camera, and the shell's
	 *  last camera decision (`[0]` granted, `[-1]` not). Empty strings when
	 *  nothing has asked yet. */
	getCameraDiagnostics(): string {
		return JSON.stringify({
			origin: AppStorage.get<string>('cameraOrigin') ?? '',
			auth: AppStorage.get<string>('cameraAuthResult') ?? '',
		});
	}

	private getBadge(): string {
		return JSON.stringify({ count: this.badgeCount });
	}

	private setBadgeCount(count: number): void {
		this.badgeCount = count;
		// Launcher badge support varies by device; a rejected promise just
		// leaves the number web-side, which is where it is displayed.
		notificationManager.setBadgeNumber(count).catch((e: BusinessError) => {
			console.warn(`[musepi] badge update failed: ${JSON.stringify(e)}`);
		});
	}

	private clearBadge(): void {
		this.setBadgeCount(0);
	}

	/**
	 * Live View（实况窗）— the status-bar capsule that keeps a running agent
	 * session visible while the app is in the background.
	 *
	 * Two gates, both silent:
	 *  1. `liveViewManager.isLiveViewEnabled()` — false until the app's Live View
	 *     entitlement is opened in AppGallery Connect and the user allows it.
	 *  2. The `event` value must be a scenario the review approved; the constant
	 *     below is the placeholder MusePi would register.
	 * When either gate is closed every call resolves to a no-op, so the shell
	 * behaves exactly as it does without Live View.
	 */
	private syncLiveView(active: boolean, title: string, detail: string): void {
		if (active === this.liveViewRunning) {
			if (active) {
				this.pushLiveView(title, detail, false);
			}
			return;
		}
		this.liveViewRunning = active;
		this.pushLiveView(title, detail, !active);
	}

	private pushLiveView(title: string, detail: string, stop: boolean): void {
		const view: liveViewManager.LiveView = {
			id: this.liveViewId,
			event: MUSEPI_LIVE_VIEW_EVENT,
			liveViewData: {
				primary: {
					title: title,
					content: [{ text: detail }],
					// KeepTime 0: dismissal is immediate once the turn ends.
					keepTime: 0,
				},
			},
		};
		liveViewManager.isLiveViewEnabled()
			.then((enabled: boolean) => {
				if (!enabled) {
					return;
				}
				if (stop) {
					return liveViewManager.stopLiveView(view);
				}
				return this.liveViewStarted
					? liveViewManager.updateLiveView(view)
					: liveViewManager.startLiveView(view);
			})
			.then(() => {
				if (!stop) {
					this.liveViewStarted = true;
				}
			})
			.catch((e: BusinessError) => {
				// Missing entitlement / unsupported device — expected, not an error.
				console.warn(`[musepi] live view skipped: ${JSON.stringify(e)}`);
			});
	}

	private consumeDeepLink(): string {
		const uri = AppStorage.get<string>('pendingDeepLink') ?? '';
		if (uri !== '') {
			AppStorage.setOrCreate('pendingDeepLink', '');
		}
		return uri;
	}

	/**
	 * Page → native: mirror the page's destination in the bottom tab bar.
	 * The page owns connect/session state, so it decides which destination is
	 * active; the bar only reflects it (and stays silent about the echo).
	 */
	setActiveTab(index: number): void {
		if (index < 0 || index > 2) {
			return;
		}
		this.webTab = index;
		if (this.settingsOpen) {
			// The overlay owns the screen; the bar keeps pointing at it.
			return;
		}
		if (index === this.activeTab) {
			return;
		}
		this.tabFromPage = true;
		this.activeTab = index;
		this.tabsController.changeIndex(index);
	}

	/**
	 * One destination switch from the chrome (rail or bottom bar).
	 *
	 * Settings is a native overlay: it never moves the WebView, so the bar keeps
	 * highlighting 设置 while the page stays on whatever it was showing. Every
	 * other destination restores the highlight to the page's real tab.
	 */
	private activateTab(index: number): void {
		if (index < 0 || index > 2) {
			return;
		}
		if (index === 2) {
			this.settingsOpen = true;
			this.activeTab = 2;
			this.tabsController.changeIndex(2);
			return;
		}
		const wasSettings = this.settingsOpen;
		this.settingsOpen = false;
		if (!wasSettings && index === this.activeTab) {
			return;
		}
		this.activeTab = index;
		this.webTab = index;
		this.tabsController.changeIndex(index);
		this.pushTab(index);
	}

	/** Closing the overlay returns the bar to the page's own destination, and
	 *  the next open starts on the hub again (the state used to reset by
	 *  unmounting with the overlay). */
	onSettingsOpenChanged(): void {
		if (this.settingsOpen) {
			return;
		}
		this.settingsPage = 'hub';
		if (this.activeTab !== this.webTab) {
			this.activeTab = this.webTab;
			this.tabsController.changeIndex(this.webTab);
		}
	}

	/* ---- preferences ---------------------------------------------------- */

	/** Every stored preference, for the page to adopt on mount. */
	getPrefs(): string {
		return PrefsStore.snapshot(PREF_KEYS);
	}

	/**
	 * Page → native mirror of one preference.
	 *
	 * Android still writes these from the WebView; HarmonyOS writes them here.
	 * Keeping the write path in one place means the store never disagrees with
	 * what the page is rendering.
	 */
	setPref(key: string, value: string): void {
		if (PREF_KEYS.indexOf(key) < 0) {
			return;
		}
		PrefsStore.set(key, value);
		if (key === 'tabBarMaterial') {
			this.materialStyle = Number(value);
		}
	}

	/**
	 * Native → page: apply one preference.
	 *
	 * The theme flips the shell's own surfaces too, and it must not wait for
	 * the page to re-emit `setThemeColor` — a light settings page over a dark
	 * rail is exactly the mismatch that looks like a bug. The page remains the
	 * renderer; the shell only takes the value it just wrote.
	 *
	 * The bar material is the same rule in the other direction: the bar is
	 * native, so the settings page's own choice has to reach `currentMaterial`
	 * immediately. Only the page echoes `setTabBarMaterial`, which is the
	 * WebView's path — waiting for it left the pill on the old thickness until
	 * the next launch.
	 */
	private applyPref(key: string, value: string): void {
		if (key === 'theme') {
			this.themeDark = value === 'dark' || (value === 'system' && this.systemColorMode === 'dark');
			// `backgroundBlurStyle` and the system materials pick their mask from
			// the APP colour mode, not from our tints: without this the sidebar
			// stayed a dark glass slab on a light page.
			this.applyAppColorMode(this.themeDark);
			// Bar icons belong to the same decision: the page no longer pushes
			// the scheme, so the shell has to repaint them itself.
			this.applySystemBarStyle(this.themeDark);
		}
		if (key === 'tabBarMaterial') {
			const style = Number(value);
			if (style >= 0 && style <= 3) {
				this.materialStyle = style;
			}
		}
		const js = `window.__musepiPref && window.__musepiPref(${JSON.stringify(key)}, ${JSON.stringify(value)})`;
		this.controller.runJavaScript(js).catch((e: BusinessError) => {
			console.warn(`[musepi] pref push failed: ${JSON.stringify(e)}`);
		});
	}

	/** Page → native: the resolved colour of each accent preset. */
	setAccentPalette(json: string): void {
		this.accentPalette = json;
	}

	private pushTab(index: number): void {
		const name = index === 0 ? 'connect' : index === 1 ? 'chat' : 'settings';
		this.controller
			.runJavaScript(`window.__musepiTab && window.__musepiTab("${name}")`)
			.catch((e: BusinessError) => {
				console.warn(`[musepi] tab push failed: ${JSON.stringify(e)}`);
			});
	}

	/* ---- window form ---------------------------------------------------- */

	/** Insets in vp, re-parsed on read: they change on rotation and folding. */
	private insets(): Insets {
		return parseInsets(this.systemInsets);
	}

	/**
	 * The floating bar is the navigation on EVERY form factor (the shell no
	 * longer owns a rail), so this is pinned to `bottom`: the page always
	 * reserves the bar's strip, and the bar itself always rides above the
	 * settings page. `metrics.layout` still says `rail` on wide windows — it
	 * is a leftover from the hand-drawn side rail and must not leak into the
	 * page-facing answer or the bar's stacking.
	 */
	private chromeLayout(): ChromeLayout {
		return 'bottom';
	}

	/**
	 * Rail width the page must clear: the rail itself plus any left cutout, so
	 * one number describes the whole left gutter (see shell.css).
	 */
	/** Window-space left gutter owned by native chrome. */
	private chromeInset(): number {
		return this.chromeLayout() === 'rail' ? this.railTotalWidth() : 0;
	}

	/** The gutter the content sits beside: the draggable session column. */
	private railTotalWidth(): number {
		return this.listPaneWidth();
	}

	/**
	 * Bottom strip the bar occupies: gesture inset + gap + bar + gap.
	 *
	 * This is the number the page reserves for its composer, and it is
	 * computed here rather than hard-coded in CSS so the strip the bar paints
	 * and the strip the composer leaves are the same strip.
	 */
	private bottomChromeHeight(): number {
		return this.insets().bottom + BAR_BLOCK;
	}

	/** Root area change — the only signal fold, rotation, split and resize share. */
	private applyWindowArea(width: Length, height: Length): void {
		const w = parseFloat(`${width}`);
		const h = parseFloat(`${height}`);
		if (!(w > 0) || !(h > 0)) {
			return;
		}
		const next = metricsOf(w, h);
		if (next.layout === this.metrics.layout && next.width === this.metrics.width &&
			next.height === this.metrics.height && next.railWidth === this.metrics.railWidth) {
			return;
		}
		this.metrics = next;
		this.pushWindowForm();
		this.pushChromeLayout();
	}

	private pushChromeLayout(): void {
		const layout = 'bottom';
		// The shell owns all insets (the Row beside the session column), so the
		// page never self-pads for a rail — it only reads windowForm.rail for
		// its reading column.
		const rail = 0;
		const reserve = this.bottomChromeHeight();
		this.controller
			.runJavaScript(`window.__harmonyChrome && window.__harmonyChrome("${layout}", ${rail}, ${reserve})`)
			.catch((e: BusinessError) => {
				console.warn(`[musepi] chrome push failed: ${JSON.stringify(e)}`);
			});
	}

	/** The page's CSS needs the form (reading column, wide-sheet placement). */
	private pushWindowForm(): void {
		const form: MuseWindowForm = {
			width: this.metrics.width,
			height: this.metrics.height,
			fold: this.foldForm,
			rail: this.railTotalWidth(),
		};
		const json = JSON.stringify(form).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
		this.controller
			.runJavaScript(`window.__harmonyWindow && window.__harmonyWindow("${json}")`)
			.catch(() => {});
	}

	getWindowForm(): string {
		const form: MuseWindowForm = {
			width: this.metrics.width,
			height: this.metrics.height,
			fold: this.foldForm,
			rail: this.railTotalWidth(),
		};
		return JSON.stringify(form);
	}

	/** Rail → page: the page owns the session rows, so the rail only asks its
	 *  header to run the same "open sessions" path the title uses. */
	private openSessionsFromChrome(): void {
		this.controller
			.runJavaScript('window.dispatchEvent(new Event("musepi:open-sessions"))')
			.catch((e: BusinessError) => {
				console.warn(`[musepi] open sessions failed: ${JSON.stringify(e)}`);
			});
	}

	private sideTabs(): MuseSideTab[] {
		return [
			{ index: 0, icon: $r('app.media.tab_connect'), label: $r('app.string.tab_connect') },
			{ index: 1, icon: $r('app.media.tab_chat'), label: $r('app.string.tab_chat') },
			{ index: 2, icon: $r('app.media.tab_settings'), label: $r('app.string.tab_settings') },
		];
	}

	/**
	 * Session list column (wide windows only).
	 *
	 * Owns no state: the rows arrive from the page (`setSessions`) and a tap
	 * reports one intent back, exactly like the native sheet. What it adds over
	 * the sheet is persistence — on an unfolded screen the list stays on screen
	 * next to the transcript instead of covering it.
	 */
	@Builder
	sessionPane() {
		Column() {
			Row({ space: 8 }) {
				Image($r('app.media.app_icon')).width(26).height(26).borderRadius(8)
				Column({ space: 2 }) {
					Text($r('app.string.app_name'))
						.fontSize(15)
						.fontWeight(FontWeight.Bold)
						.fontColor(this.primaryTextColor())
					Text(this.sessionRows.length === 0
						? $r('app.string.sessions_none')
						: `${this.sessionRows.length}`)
						.fontSize(11)
						.fontColor(this.secondaryTextColor())
				}
				.alignItems(HorizontalAlign.Start)
				.layoutWeight(1)
			}
			.width('100%')
			.height(52)
			.padding({ left: 14, right: 10 })
			.alignItems(VerticalAlign.Center)

			// Search sits in the column instead of a sheet: with the list
			// permanently on screen, filtering it in place is what the shape
			// affords — opening a modal to filter a visible list is a detour.
			if (this.sessionRows.length > 6) {
				TextInput({ text: this.paneQuery, placeholder: $r('app.string.sessions_search') })
					.height(34)
					.fontSize(13)
					.placeholderFont({ size: 13 })
					.placeholderColor(this.secondaryTextColor())
					.fontColor(this.primaryTextColor())
					.padding({ left: 10, right: 10 })
					.borderRadius(10)
					.backgroundColor(this.themeDark ? '#1FFFFFFF' : '#0D000000')
					.margin({ left: 8, right: 8, top: 4 })
					.onChange((value: string) => {
						this.paneQuery = value;
					})
			}

			Divider().strokeWidth(0.5).color(this.dividerColor()).margin({ left: 14, right: 14 })

			if (this.sessionRows.length === 0) {
				// An empty column with one button at the bottom reads as broken.
				// Centre the state instead: what is missing, why, and the way out.
				Column({ space: 8 }) {
					Image($r('app.media.tab_chat'))
						.width(34)
						.height(34)
						.fillColor(this.accentTint(this.themeDark ? 0.55 : 0.45))
					Text($r('app.string.sessions_none'))
						.fontSize(14)
						.fontWeight(FontWeight.Medium)
						.fontColor(this.primaryTextColor())
					Text($r('app.string.sessions_connect_hint'))
						.fontSize(12)
						.fontColor(this.secondaryTextColor())
				}
				.width('100%')
				.layoutWeight(1)
				.justifyContent(FlexAlign.Center)
				.alignItems(HorizontalAlign.Center)
			} else {
				List({ space: 2 }) {
					ForEach(this.sessionRows, (row: HarmonySessionRow) => {
					ListItem() {
						Column({ space: 2 }) {
							Text(row.title)
								.fontSize(14)
								.fontWeight(row.current ? FontWeight.Medium : FontWeight.Normal)
								.fontColor(row.current ? this.primaryTextColor() : this.secondaryTextColor())
								.maxLines(1)
								.textOverflow({ overflow: TextOverflow.Ellipsis })
								.width('100%')
							if (row.meta !== '') {
								Text(row.meta)
									.fontSize(11)
									.fontColor(this.secondaryTextColor())
									.maxLines(1)
									.width('100%')
							}
						}
						.width('100%')
						.padding({ left: 12, right: 8, top: 9, bottom: 9 })
						.borderRadius(12)
						.backgroundColor(row.current ? this.accentTint(this.themeDark ? 0.20 : 0.16) : Color.Transparent)
						.alignItems(HorizontalAlign.Start)
					}
					.stateStyles({
						pressed: { .backgroundColor(this.accentTint(this.themeDark ? 0.26 : 0.20)) },
					})
					.onClick(() => this.pushSessionAction('pick', row.id))
					.accessibilityText(`${row.title} ${row.meta}`)
					.accessibilityDescription(row.current ? this.selectedLabel : '')
					}, (row: HarmonySessionRow) => `${row.id}|${row.current}|${row.meta}|${row.title}`)
				}
				.width('100%')
				.layoutWeight(1)
				.padding({ left: 6, right: 6, top: 6 })
				.scrollBar(BarState.Off)
			}

			// Same affordance the empty state offers, kept at the bottom so the
			// list can scroll under the thumb without a floating button.
			Button({ type: ButtonType.Normal }) {
				Row({ space: 6 }) {
					Text('＋').fontSize(15).fontColor(this.inkOnAccent())
					Text($r('app.string.sessions_new'))
						.fontSize(14)
						.fontWeight(FontWeight.Medium)
						.fontColor(this.inkOnAccent())
				}
				.alignItems(VerticalAlign.Center)
			}
			.width('100%')
			.height(44)
			.borderRadius(12)
			.backgroundColor(this.apiLevel < 26 ? this.tabSelectedColor() : Color.Transparent)

			.systemMaterial(this.accentMaterial(true))
			.margin({ top: 6 })
			.stateStyles({
				pressed: { .scale({ x: 0.97, y: 0.97 }).opacity(0.9) },
			})
			.animation({ duration: 200, curve: curves.springMotion(0.35, 0.9) })
			.onClick(() => this.pushSessionAction('new', ''))
		}
		.width(this.listPaneWidth() + this.insets().left)
		.height('100%')
		// A landscape cutout sits in the left inset, and the pane starts at the
		// window edge: the strip is added OUTSIDE the designed column width, so
		// the list keeps its width instead of losing a notch-wide slice. The
		// divider follows the widened edge (see `paneDivider`).
		.padding({
			left: this.insets().left + 6,
			right: 6,
			top: this.insets().top + BAR_GAP,
			bottom: this.insets().bottom + BAR_GAP,
		})
		.backgroundBlurStyle(BlurStyle.COMPONENT_THIN, { colorMode: this.blurMode() })
		.backgroundColor(this.themeDark ? '#400C0E12' : '#33F5F2EC')
		.border({ width: { right: 0.5 }, color: this.dividerColor() })
	}

	/**
	 * Session-column width: the breakpoint default, or whatever the user dragged
	 * it to, clamped to this window.
	 *
	 * Clamping happens on every read rather than once at load because the same
	 * remembered 320vp must not crush the list when the foldable closes (a
	 * preference is a wish, the window is the fact).
	 */
	private listPaneWidth(): number {
		const fallback = listPaneWidthOf(this.metrics.width, this.metrics.height);
		if (fallback === 0) {
			return 0;
		}
		if (this.paneWidthPref <= 0) {
			return fallback;
		}
		const insets = this.insets();
		return clampPaneWidth(this.paneWidthPref, this.metrics.widthVp, this.metrics.railWidth,
			insets.left, insets.right);
	}

	/** Drag the divider. The value is committed once, on release, so a drag
	 *  does not write Preferences sixty times a second. */
	private onDividerDrag(offsetX: number): void {
		const insets = this.insets();
		const next = clampPaneWidth(this.paneDragFrom + offsetX, this.metrics.widthVp,
			this.metrics.railWidth, insets.left, insets.right);
		if (next !== this.paneWidthPref) {
			this.paneWidthPref = next;
		}
	}

	private commitPaneWidth(): void {
		PrefsStore.set('paneWidth', `${this.paneWidthPref}`);
	}

	/** Back to the breakpoint default (double-tap on the handle). */
	private resetPaneWidth(): void {
		this.getUIContext().animateTo({ duration: 220, curve: Curve.FastOutSlowIn }, () => {
			this.paneWidthPref = 0;
		});
		PrefsStore.set('paneWidth', '0');
	}

	/**
	 * The divider: a 12vp hit strip straddling the column edge.
	 *
	 * It owns no colour of its own until touched — a permanent line beside the
	 * list's own hairline would read as two borders. Dragging shows a grip and
	 * tints it, which is the only affordance telling the user the column moves.
	 */
	@Builder
	paneDivider() {
		Column() {
			Row()
				.width(3)
				.height(this.paneDragging ? 44 : 26)
				.borderRadius(2)
				.backgroundColor(this.paneDragging
					? this.tabSelectedColor()
					: this.dividerColor())
				.animation({ duration: 180, curve: Curve.FastOutSlowIn })
		}
		.width(PANE_HANDLE)
		.height('100%')
		.justifyContent(FlexAlign.Center)
		.alignItems(HorizontalAlign.Center)
		.backgroundColor(Color.Transparent)
		// Straddle the edge: half of the strip sits over the list, half over the
		// content, so the grab target is where the user's eye says the border is.
		// The list column carries the left cutout inset as extra width, and the
		// handle has to sit on that wider edge or it drifts off the border.
		.position({
			x: this.listPaneWidth() + this.insets().left - PANE_HANDLE / 2,
			y: 0,
		})
		.zIndex(11)
		.accessibilityText($r('app.string.settings_pane_width'))
		.accessibilityLevel('yes')
		.gesture(
			GestureGroup(GestureMode.Exclusive,
				PanGesture({ direction: PanDirection.Horizontal, distance: 1 })
					.onActionStart(() => {
						this.paneDragging = true;
						this.paneDragFrom = this.listPaneWidth();
					})
					.onActionUpdate((event: GestureEvent) => this.onDividerDrag(event.offsetX))
					.onActionEnd(() => {
						this.paneDragging = false;
						this.commitPaneWidth();
					})
					.onActionCancel(() => {
						this.paneDragging = false;
					}),
				TapGesture({ count: 2 }).onAction(() => this.resetPaneWidth()),
			),
		)
	}

	/** One-time "what's new" card, shown after the first frame of a new version. */
	private maybeShowWhatsNew(): void {
		if (this.appVersion === '' || PrefsStore.get('seenVersion', '') === this.appVersion) {
			return;
		}
		// After the first frame: a card over a half-painted page is worse than
		// no card at all, and the WebView needs its own moment to load.
		setTimeout(() => {
			this.getUIContext().animateTo({ duration: 260, curve: Curve.FastOutSlowIn }, () => {
				this.whatsNewOpen = true;
			});
		}, 1200);
	}

	private dismissWhatsNew(): void {
		this.getUIContext().animateTo({ duration: 200, curve: Curve.FastOutSlowIn }, () => {
			this.whatsNewOpen = false;
		});
		PrefsStore.set('seenVersion', this.appVersion);
	}

	@Builder
	whatsNew() {
		Stack() {
			// Scrim as its own node: tapping the card must not dismiss it, and a
			// click on a parent of the card would fire for both.
			Row()
				.width('100%')
				.height('100%')
				.backgroundColor(this.whatsNewOpen ? '#66000000' : '#00000000')
				.animation({ duration: 220, curve: Curve.FastOutSlowIn })
				// Tap the scrim to dismiss: a card whose only exit is its own
				// button traps the user while they are reading that button.
				.onClick(() => this.dismissWhatsNew())

			Column({ space: 14 }) {
				Row({ space: 8 }) {
					Text(`v${this.appVersion}`)
						.fontSize(12)
						.fontWeight(FontWeight.Medium)
						.fontColor(this.tabSelectedColor())
						.padding({ left: 10, right: 10, top: 4, bottom: 4 })
						.borderRadius(999)
						.backgroundColor(this.accentTint(this.themeDark ? 0.22 : 0.16))
					Text($r('app.string.whats_new'))
						.fontSize(12)
						.fontColor(this.secondaryTextColor())
						.layoutWeight(1)
				}
				.width('100%')

				Text($r('app.string.whats_new_title'))
					.fontSize(24)
					.fontWeight(FontWeight.Bold)
					.fontColor(this.primaryTextColor())
					.width('100%')

				Column({ space: 12 }) {
					ForEach(this.whatsNewItems(), (item: ResourceStr) => {
						Row({ space: 10 }) {
							Row()
								.width(6)
								.height(6)
								.borderRadius(3)
								// Optically centred on the first line of text, not
								// aligned to its box top.
								.margin({ top: 7 })
								.backgroundColor(this.tabSelectedColor())
							Text(item)
								.fontSize(14)
								.lineHeight(20)
								.fontColor(this.secondaryTextColor())
								.layoutWeight(1)
						}
						.width('100%')
						.alignItems(VerticalAlign.Top)
					}, (item: ResourceStr, index: number) => `whats-${index}`)
				}
				.width('100%')

				Button({ type: ButtonType.Normal }) {
					Text($r('app.string.whats_new_ok'))
						.fontSize(15)
						.fontWeight(FontWeight.Medium)
						.fontColor(this.inkOnAccent())
				}
				.width('100%')
				.height(46)
				.borderRadius(14)
				.backgroundColor(this.apiLevel < 26 ? this.tabSelectedColor() : Color.Transparent)

				.systemMaterial(this.accentMaterial(true))
				.margin({ top: 4 })
				.stateStyles({ pressed: { .scale({ x: 0.98, y: 0.98 }).opacity(0.92) } })
				.animation({ duration: 180, curve: Curve.FastOutSlowIn })
				.onClick(() => this.dismissWhatsNew())
			}
			// A number, not `calc(100% - 48vp)`: a percentage-width child of a
			// Stack is centred from its own box, and with `maxWidth` clamping it
			// afterwards the card landed 46vp off-centre on the foldable.
			.width(Math.min(420, Math.max(300, this.metrics.widthVp - 48)))
			.padding(22)
			.borderRadius(26)
			// The card is glass over the page, like the sheets: same material
			// ladder, one step thicker because it carries text.
			.backgroundBlurStyle(BlurStyle.COMPONENT_THICK, { colorMode: this.blurMode() })
			.backgroundColor(this.themeDark ? '#B3101319' : '#C7FBF8F2')
			.border({ width: 0.5, color: this.dividerColor() })
			.shadow({ radius: 40, color: '#59000000', offsetY: 12 })
			.scale({ x: this.whatsNewOpen ? 1 : 0.94, y: this.whatsNewOpen ? 1 : 0.94 })
			.opacity(this.whatsNewOpen ? 1 : 0)
			.animation({ duration: 260, curve: curves.springMotion(0.32, 0.9) })
		}
		.width('100%')
		.height('100%')
		.zIndex(40)
	}

	private whatsNewItems(): ResourceStr[] {
		return [
			$r('app.string.whats_new_item_1'),
			$r('app.string.whats_new_item_2'),
			$r('app.string.whats_new_item_3'),
		];
	}

	private inkOnAccent(): ResourceColor {
		const rgb = this.accentHex.replace('#', '');
		const r = parseInt(rgb.slice(0, 2), 16);
		const g = parseInt(rgb.slice(2, 4), 16);
		const b = parseInt(rgb.slice(4, 6), 16);
		return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.58 ? '#1A171F' : '#FFFFFF';
	}

	/** The material mask follows the PAGE's scheme, not the system's: an app
	 *  forced to light inside a dark system must not draw dark glass. */
	/**
	 * Sync rendering follows the system canvas — required on the retail build of
	 * this device, where the independent surface stops presenting after the
	 * first frame. Emulator images present only the surface variant, so the page
	 * stays blank under sync there; `arch` is the cheapest way to tell them
	 * apart without a device list.
	 */
	private renderMode(): RenderMode {
		return deviceInfo.productModel.toLowerCase().includes('emulator')
			? RenderMode.ASYNC_RENDER
			: RenderMode.SYNC_RENDER;
	}

	/** Accent-tinted immersive glass for the app's primary controls, the same
	 *  material family as the tab bar: a translucent accent layer, the finger
	 *  light, and the press deformation — never a flat brand fill.
	 *  Undefined below API 26 keeps the opaque accent background. */
	private accentMaterial(interactive: boolean): uiMaterial.ImmersiveMaterial | undefined {
		if (this.apiLevel < 26) {
			return undefined;
		}
		return new uiMaterial.ImmersiveMaterial({
			style: uiMaterial.ImmersiveStyle.REGULAR,
			materialColor: this.accentTint(this.themeDark ? 0.26 : 0.22),
			interactive: interactive,
			applyShadow: true,
			colorInvert: false,
			lightEffect: { color: this.tabSelectedColor() },
		});
	}

	/**
	 * Stronger accent glass for the connect page's single primary button: the
	 * default 26% tint reads as a flat shadow on a dark page (verified on
	 * device — the button was nearly invisible next to the background), so the
	 * main way in gets a heavier accent layer, closer to how the platform's
	 * own filled primary buttons read.
	 */
	private accentMaterialStrong(): uiMaterial.ImmersiveMaterial | undefined {
		if (this.apiLevel < 26) {
			return undefined;
		}
		return new uiMaterial.ImmersiveMaterial({
			style: uiMaterial.ImmersiveStyle.REGULAR,
			materialColor: this.accentTint(this.themeDark ? 0.55 : 0.45),
			interactive: true,
			applyShadow: true,
			colorInvert: false,
			lightEffect: { color: this.tabSelectedColor() },
		});
	}

	/** The material mask follows the PAGE's scheme, not the system's: an app
	 *  forced to light inside a dark system must not draw dark glass. */
	private blurMode(): ThemeColorMode {
		return this.themeDark ? ThemeColorMode.DARK : ThemeColorMode.LIGHT;
	}

	/**
	 * The page's resolved accent, pushed as `#RRGGBB` (see
	 * mobile.tsx → harmonyNative.setAccentColor).
	 *
	 * The native bar and rail paint themselves, so they cannot read the page's
	 * CSS variables: a hard-coded brand gold stayed gold while the user picked
	 * jade in settings, and one screen then showed two accents (the page's
	 * green CTA above a gold tab bar). This mirrors whatever the page resolved.
	 */
	@State accentHex: string = '#D9A441';

	/** Page → native: mirror the accent. Shape-checked, not trusted. */
	setAccentColor(hex: string): void {
		if (!/^#[0-9a-fA-F]{6}$/.test(hex) || hex.toLowerCase() === this.accentHex.toLowerCase()) {
			return;
		}
		this.accentHex = hex;
	}

	/** Selected tab / action colour: the page's accent. */
	private tabSelectedColor(): ResourceColor {
		return this.accentHex;
	}

	/** Accent at low alpha — the selected rail row's tint. ArkUI takes
	 *  `#AARRGGBB`, so the alpha is prepended to the page's rgb. */
	private accentTint(alpha: number): string {
		const rgb = this.accentHex.replace('#', '');
		const value = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
		const aa = value.toString(16).padStart(2, '0');
		return `#${aa}${rgb}`;
	}

	private tabIdleColor(): ResourceColor {
		return this.themeDark ? '#8E8A93' : '#7A7480';
	}

	private dividerColor(): ResourceColor {
		return this.themeDark ? '#2A3140' : '#E2D9CB';
	}

	/** Ink on the accent-coloured action button. Picked by luminance so a light
	 *  preset (jade, gold) keeps dark text and a dark one keeps white —
	 *  hard-coding it by scheme inverted the label whenever the user changed
	 *  accent without changing the theme. */
	private sheetActionFg(): ResourceColor {
		const rgb = this.accentHex.replace('#', '');
		const r = parseInt(rgb.slice(0, 2), 16);
		const g = parseInt(rgb.slice(2, 4), 16);
		const b = parseInt(rgb.slice(4, 6), 16);
		const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
		return luminance > 0.58 ? '#1A171F' : '#FFFFFF';
	}

	/* ---- connect-page palette (same tokens as the settings page) ------- */

	private pageBg(): ResourceColor {
		return this.themeDark ? '#0E0F12' : '#F6F4F1';
	}

	/**
	 * Vertical gradient stops for page backgrounds (connect page, and the same
	 * language the settings page uses): a slight fall towards the bottom edge.
	 * The floating pill's material blurs what is behind it — a flat colour
	 * reads as an opaque slab, a gradient gives the glass something to sample.
	 */
	private pageBgGradient(): Array<[ResourceColor, number]> {
		const stops: Array<[ResourceColor, number]> = [];
		if (this.themeDark) {
			stops.push(['#0E0F12', 0]);
			stops.push(['#17121A', 1]);
		} else {
			stops.push(['#F6F4F1', 0]);
			stops.push(['#EDE8E1', 1]);
		}
		return stops;
	}

	private cardBg(): ResourceColor {
		return this.themeDark ? '#17181C' : '#FFFFFF';
	}

	private hairline(): ResourceColor {
		return this.themeDark ? '#26FFFFFF' : '#14000000';
	}

	private errorColor(): ResourceColor {
		return this.themeDark ? '#F38BA0' : '#C53A4A';
	}

	/** Neutral immersive glass for cards and chrome (no accent, no press
	 *  deformation — those belong to interactive controls). Undefined below
	 *  API 26 keeps the opaque card backgrounds. */
	private surfaceMaterial(): uiMaterial.ImmersiveMaterial | undefined {
		if (this.apiLevel < 26) {
			return undefined;
		}
		return new uiMaterial.ImmersiveMaterial({
			style: uiMaterial.ImmersiveStyle.THIN,
			materialColor: this.themeDark ? '#20FFFFFF' : '#16FFFFFF',
			interactive: false,
			applyShadow: false,
		});
	}

	/**
	 * Native bottom tab. This must stay `BottomTabBarStyle`: the immersive
	 * material's press deformation (`interactive`) and the light that follows
	 * the finger (`lightEffect`) are applied by the system TabBar itself — a
	 * custom @Builder only paints pixels and loses both.
	 */
	private tabBarStyle(icon: Resource, text: Resource): BottomTabBarStyle {
		const selected = this.tabSelectedColor();
		const idle = this.tabIdleColor();
		return new BottomTabBarStyle(icon, text)
			.labelStyle({
				selectedColor: selected,
				unselectedColor: idle,
				font: { size: 11, weight: FontWeight.Medium },
			})
			.iconStyle({ selectedColor: selected, unselectedColor: idle });
	}

	/** Page → native: hide the chrome under full-screen overlays. */
	setTabBarVisible(visible: boolean): void {
		this.tabBarVisible = visible;
	}

	/** Page → native: pick the bar's material thickness.
	 *  0 balanced / 1 rich / 2 light / 3 ultra-light */
	setTabBarMaterial(style: number): void {
		if (style < 0 || style > 3 || style === this.materialStyle) {
			return;
		}
		this.materialStyle = style;
	}

	/**
	 * Immersive material for the floating bar. `interactive` gives the press
	 * deformation, `lightEffect` is the light that follows the finger; both are
	 * the reason this bar must stay a native TabBar.
	 */
	private currentMaterial(): uiMaterial.ImmersiveMaterial | undefined {
		// ImmersiveMaterial shipped in API 26 while the install floor stays at
		// API 12: touching the symbol on an older device would abort the bar.
		// Undefined keeps `barFloatingStyle` on its plain material.
		if (this.apiLevel < 26) {
			return undefined;
		}
		const styles: uiMaterial.ImmersiveStyle[] = [
			uiMaterial.ImmersiveStyle.REGULAR,
			uiMaterial.ImmersiveStyle.THICK,
			uiMaterial.ImmersiveStyle.THIN,
			uiMaterial.ImmersiveStyle.ULTRA_THIN,
		];
		const index = this.materialStyle >= 0 && this.materialStyle < styles.length ? this.materialStyle : 0;
		return new uiMaterial.ImmersiveMaterial({
			style: styles[index],
			// A translucent tint keeps the pill reading as glass over flat
			// page backgrounds: without it the deep REGULAR material against a
			// solid page colour looks like an opaque slab instead of a capsule
			// floating over the surface. White is stronger on dark (the pill
			// lifts off the page), near-neutral on light (the glass is already
			// bright there).
			materialColor: this.themeDark ? '#26FFFFFF' : '#0DFFFFFF',
			interactive: true,
			// Warm gold to match the brand accent; pure white reads as a flash.
			lightEffect: { color: this.themeDark ? '#F0C860' : '#B8860B' },
			// Thin materials need the system's auto-inverted labels to stay
			// readable over bright content.
			colorInvert: index >= 2,
			applyShadow: true,
		});
	}

	/**
	 * Immersive material for a sheet. Dialogs sit above content and take the
	 * thick end of the ladder (the guide's recommendation for popups), so the
	 * form stays legible while the page shows through. No `interactive` press
	 * deformation: a sheet is dragged and tapped, not pressed as a surface, and
	 * the light effect would read on the backdrop rather than on a control.
	 * Undefined below API 26 keeps the opaque sheet background.
	 */
	private sheetMaterial(): uiMaterial.ImmersiveMaterial | undefined {
		if (this.apiLevel < 26) {
			return undefined;
		}
		return new uiMaterial.ImmersiveMaterial({
			style: uiMaterial.ImmersiveStyle.THICK,
			interactive: false,
			applyShadow: true,
		});
	}

	/** Page → native: open the pair-code sheet. */
	openPairSheet(): void {
		this.pairCode = '';
		this.pairHost = AppStorage.get<string>('lastPairHost') ?? '';
		this.sheetKind = 'pair';
		this.sheetVisible = true;
	}

	/** Page → native: open the remote-link sheet, empty.
	 *  The form is a one-shot hand-off: reusing the previous link would look
	 *  like a pre-filled suggestion and made a mistyped link reappear. */
	openLinkSheet(): void {
		this.linkUrl = '';
		this.linkName = '';
		this.sheetKind = 'link';
		this.sheetVisible = true;
	}

	/** Page → native: the pair/link submission was accepted — close the sheet.
	 *  The native side never closes it on submit: a rejected pair code or an
	 *  unreachable host is reported back by the page, and the values have to
	 *  stay visible to be corrected. */
	closeConnectSheet(): void {
		this.sheetVisible = false;
	}

	/** Page → native: open the session switcher with its rows. */
	openSessionsSheet(payload: string): void {
		const parsed = this.parseSessions(payload);
		if (parsed === undefined) {
			return;
		}
		this.sessionRows = parsed.sessions;
		this.sessionQuery = '';
		this.sessionSheetOpen = true;
	}

	/** Page → native: refresh the rows of an open switcher. */
	setSessions(payload: string): void {
		if (!this.sessionSheetOpen) {
			return;
		}
		const parsed = this.parseSessions(payload);
		if (parsed === undefined) {
			return;
		}
		this.sessionRows = parsed.sessions;
	}

	/** Page → native: mirror the connect guide (skipped / offline / error). */
	setConnectInfo(payload: string): void {
		try {
			const parsed: ConnectInfoPayload = JSON.parse(payload) as ConnectInfoPayload;
			if (parsed === null || parsed === undefined) {
				return;
			}
			this.connectSkipped = parsed.skipped === true;
			this.connectOffline = parsed.offline === true;
			this.connectError = typeof parsed.error === 'string' ? parsed.error : '';
		} catch (e) {
			console.warn(`[musepi] connect info parse failed: ${JSON.stringify(e)}`);
		}
	}

	/** Page → native: saved computers for the native connect page. */
	setHosts(payload: string): void {
		try {
			const parsed: ConnectHostRow[] = JSON.parse(payload) as ConnectHostRow[];
			if (!Array.isArray(parsed)) {
				return;
			}
			this.connectHosts = parsed.filter((row: ConnectHostRow): boolean =>
				typeof row === 'object' && row !== null && typeof row.id === 'string' && typeof row.label === 'string');
		} catch (e) {
			console.warn(`[musepi] hosts parse failed: ${JSON.stringify(e)}`);
		}
	}

	/**
	 * A refused camera grant is otherwise invisible: the scanner simply never
	 * opens. Say why, then offer the permission page — once HarmonyOS stops
	 * showing the dialog, that page is the only way back in.
	 */
	private promptCameraDenied(): void {
		try {
			this.getUIContext().getPromptAction().showToast({
				message: $r('app.string.camera_permission_needed'),
				duration: 2500,
			});
		} catch (e) {
			console.warn(`[musepi] camera toast failed: ${JSON.stringify(e)}`);
		}
		this.openCameraSettings();
	}

	/** Native connect page → scan with the system Scan Kit — the platform's
	 *  own barcode UI, not the WebView's getUserMedia overlay (which stays the
	 *  Android path). The raw result is pushed to the page, which resolves the
	 *  credential and connects; the E2E link never lands in ArkTS beyond the
	 *  moment of handoff. */
	private async openScanner(): Promise<void> {
		const context = this.getUIContext().getHostContext();
		if (context === undefined) {
			return;
		}
		// Camera is a runtime permission. Scan Kit's page would ask anyway, but
		// resolving it up front makes a denial visible before the scanner opens.
		const granted = await this.ensureCameraPermission();
		if (!granted) {
			this.promptCameraDenied();
			return;
		}
		try {
			const result = await scanBarcode.startScan({
				scanTypes: [scanCore.ScanType.ALL],
				enableMultiMode: false,
				enableAlbum: false,
			});
			if (result && result.originalValue !== '') {
				this.pushToPage(`window.__musepiScanResult && window.__musepiScanResult(${JSON.stringify(result.originalValue)})`);
			}
		} catch (e) {
			console.warn(`[musepi] scan failed or cancelled: ${JSON.stringify(e)}`);
		}
	}

	/** Native connect page → page: connect to a saved computer by id — the
	 *  page resolves the credential (never mirrored to native) and connects. */
	connectHost(id: string): void {
		this.pushToPage(`window.__musepiConnectHost && window.__musepiConnectHost(${JSON.stringify(id)})`);
	}

	/** Native connect page → page: dismiss the guide ("skip for now"). */
	skipConnect(): void {
		this.pushToPage('window.__musepiSkipConnect && window.__musepiSkipConnect()');
	}

	/** Native connect page → page: return from the skipped guide to the full
	 *  connect screen. */
	returnToConnect(): void {
		this.pushToPage('window.__musepiReturnToConnect && window.__musepiReturnToConnect()');
	}

	private pushToPage(js: string): void {
		this.controller.runJavaScript(js).catch((e: BusinessError) => {
			console.warn(`[musepi] push failed: ${JSON.stringify(e)}`);
		});
	}

	private parseSessions(payload: string): HarmonySessionPayload | undefined {
		try {
			const parsed: HarmonySessionPayload = JSON.parse(payload) as HarmonySessionPayload;
			if (parsed === null || parsed.sessions === undefined) {
				return undefined;
			}
			return parsed;
		} catch (e) {
			console.warn(`[musepi] session payload rejected (${payload.length} bytes)`);
			return undefined;
		}
	}

	private filteredSessions(): HarmonySessionRow[] {
		const query = this.sessionQuery.trim().toLowerCase();
		if (query === '') {
			return this.sessionRows;
		}
		return this.sessionRows.filter((row: HarmonySessionRow): boolean =>
			row.title.toLowerCase().includes(query) || row.cwd.toLowerCase().includes(query));
	}

	private sessionAction(type: string, id: string): void {
		this.sessionSheetOpen = false;
		this.pushSessionAction(type, id);
	}

	/** Native → page: one intent, never a row snapshot. */
	private pushSessionAction(type: string, id: string): void {
		const safeType = type.replace(/[^a-z]/g, '');
		const safeId = id.replace(/["\\]/g, '');
		this.controller
			.runJavaScript(`window.__musepiSessionAction && window.__musepiSessionAction("${safeType}", "${safeId}")`)
			.catch((e: BusinessError) => {
				console.warn(`[musepi] session action failed: ${JSON.stringify(e)}`);
			});
	}

	@Builder
	sessionsSheetBody() {
		Column({ space: 10 }) {
			Search({ value: this.sessionQuery, placeholder: $r('app.string.sessions_search') })
				.width('100%')
				.height(44)
				.backgroundColor('#0D000000')
				.onChange((value: string) => {
					this.sessionQuery = value;
				})
			if (this.filteredSessions().length === 0) {
				Text($r('app.string.sessions_empty'))
					.fontSize(14)
					.fontColor(this.secondaryTextColor())
					.width('100%')
					.textAlign(TextAlign.Center)
					.padding({ top: 32, bottom: 32 })
				Blank()
			} else {
				List({ space: 0 }) {
					ForEach(this.filteredSessions(), (row: HarmonySessionRow) => {
						ListItem() {
							Row({ space: 12 }) {
								// A 8vp dot, drawn as a filled box: `Circle().fill()` is
								// API 26 and would abort the list on an older device.
								Row()
									.width(8)
									.height(8)
									.borderRadius(4)
									.backgroundColor(row.current ? this.tabSelectedColor() : this.secondaryTextColor())
								Column({ space: 2 }) {
									Text(row.title)
										.fontSize(16)
										.fontWeight(FontWeight.Medium)
										.maxLines(1)
										.textOverflow({ overflow: TextOverflow.Ellipsis })
									if (row.cwd !== '') {
										Text(row.cwd)
											.fontSize(12)
											.fontColor(this.secondaryTextColor())
											.maxLines(1)
											.textOverflow({ overflow: TextOverflow.Ellipsis })
									}
								}
								.alignItems(HorizontalAlign.Start)
								.layoutWeight(1)
								Column({ space: 2 }) {
									Text(row.meta)
										.fontSize(12)
										.fontColor(this.secondaryTextColor())
										.maxLines(1)
									if (row.when !== '') {
										Text(row.when)
											.fontSize(12)
											.fontColor(this.secondaryTextColor())
											.maxLines(1)
									}
								}
								.alignItems(HorizontalAlign.End)
								if (row.current) {
									Text('✓')
										.fontSize(14)
										.fontColor(this.tabSelectedColor())
								}
							}
							.width('100%')
							.constraintSize({ minHeight: 64 })
							.padding({ left: 4, right: 4 })
							.alignItems(VerticalAlign.Center)
							.accessibilityText(`${row.title} ${row.meta}`)
							.accessibilityDescription(row.current ? this.selectedLabel : '')
						}
						.onClick(() => {
							this.sessionAction('pick', row.id);
						})
					}, (row: HarmonySessionRow) => `${row.id}|${row.current}|${row.meta}|${row.when}|${row.title}`)
				}
				.width('100%')
				.layoutWeight(1)
				.divider({ strokeWidth: 0.5, color: '#14000000' })
				.scrollBar(BarState.Off)
			}
			Row({ space: 8 }) {
				Button($r('app.string.sessions_new'))
					.layoutWeight(1)
					.height(48)
					.type(ButtonType.Normal)
					.borderRadius(12)
					.fontSize(14)
					.backgroundColor('#0D000000')
					.fontColor(this.primaryTextColor())
					.onClick(() => {
						this.sessionAction('new', '');
					})
				Button($r('app.string.sessions_hosts'))
					.layoutWeight(1)
					.height(48)
					.type(ButtonType.Normal)
					.borderRadius(12)
					.fontSize(14)
					.backgroundColor('#0D000000')
					.fontColor(this.primaryTextColor())
					.onClick(() => {
						this.sessionAction('hosts', '');
					})
				Button($r('app.string.sessions_settings'))
					.layoutWeight(1)
					.height(48)
					.type(ButtonType.Normal)
					.borderRadius(12)
					.fontSize(14)
					.backgroundColor('#0D000000')
					.fontColor(this.primaryTextColor())
					.onClick(() => {
						this.sessionAction('settings', '');
					})
			}
			.width('100%')
		}
		.width('100%')
		.height('100%')
		.padding({ left: 16, right: 16, top: 4, bottom: 20 })
	}

	private primaryTextColor(): ResourceColor {
		return this.themeDark ? '#F5F5F5' : '#1F1F1F';
	}

	private secondaryTextColor(): ResourceColor {
		return this.themeDark ? '#9A9AA2' : '#767676';
	}

	private submitPairSheet(): void {
		const code = this.pairCode.trim();
		const host = this.pairHost.trim();
		if (code === '' || host === '') {
			return;
		}
		AppStorage.setOrCreate('lastPairHost', host);
		const js = `window.__musepiPair && window.__musepiPair(${JSON.stringify(code)}, ${JSON.stringify(host)})`;
		this.controller.runJavaScript(js).catch((e: BusinessError) => {
			console.warn(`[musepi] pair push failed: ${JSON.stringify(e)}`);
		});
		// Stays open: the page answers a bad code by reporting it through
		// `setConnectInfo`, and only calls `harmonyNative.closeConnectSheet()`
		// once the submission was accepted.
	}

	private submitLinkSheet(): void {
		const url = this.linkUrl.trim();
		if (url === '') {
			return;
		}
		const name = this.linkName.trim();
		const js = `window.__musepiConnectLink && window.__musepiConnectLink(${JSON.stringify(url)}, ${JSON.stringify(name)})`;
		this.controller.runJavaScript(js).catch((e: BusinessError) => {
			console.warn(`[musepi] link push failed: ${JSON.stringify(e)}`);
		});
		// Same one-shot contract as the pair form: closed by the page on success.
	}

	/**
	 * Connect form sheet.
	 *
	 * Placement follows the window, not the device: a phone gets a bottom sheet
	 * that continues the guide, while a tablet or an unfolded foldable gets a
	 * centred, width-capped panel — a 1280vp-wide bottom sheet reads as a
	 * stretched phone form, and the form itself never needs more than ~560vp.
	 */
	@Builder
	sheetBody() {
		Column({ space: 14 }) {
			if (this.sheetKind === 'pair') {
				TextInput({ placeholder: $r('app.string.sheet_pair_hint'), text: this.pairCode })
					.type(InputType.Number)
					.maxLength(6)
					.height(52)
					.enterKeyType(EnterKeyType.Next)
					.onChange((v: string) => {
						this.pairCode = v;
					})
				TextInput({ placeholder: $r('app.string.sheet_host_hint'), text: this.pairHost })
					.height(52)
					.enterKeyType(EnterKeyType.Done)
					.onSubmit(() => {
						this.submitPairSheet();
					})
					.onChange((v: string) => {
						this.pairHost = v;
					})
				Button($r('app.string.action_pair'))
					.width('100%')
					.height(50)
					.backgroundColor(this.apiLevel < 26 ? this.tabSelectedColor() : Color.Transparent)

					.systemMaterial(this.accentMaterial(true))
					.fontColor(this.sheetActionFg())
					.stateStyles({
						pressed: {
							.scale({ x: 0.97, y: 0.97 })
							.opacity(0.9)
						},
					})
					.animation({ duration: 200, curve: curves.springMotion(0.35, 0.9) })
					.enabled(this.pairCode.trim().length === 6 && this.pairHost.trim() !== '')
					.onClick(() => {
						this.submitPairSheet();
					})
			} else {
				TextInput({ placeholder: $r('app.string.sheet_link_hint'), text: this.linkUrl })
					.height(52)
					.enterKeyType(EnterKeyType.Next)
					.onChange((v: string) => {
						this.linkUrl = v;
					})
				TextInput({ placeholder: $r('app.string.sheet_name_hint'), text: this.linkName })
					.height(52)
					.maxLength(32)
					.enterKeyType(EnterKeyType.Done)
					.onSubmit(() => {
						this.submitLinkSheet();
					})
					.onChange((v: string) => {
						this.linkName = v;
					})
				Button($r('app.string.action_connect'))
					.width('100%')
					.height(50)
					.backgroundColor(this.apiLevel < 26 ? this.tabSelectedColor() : Color.Transparent)

					.systemMaterial(this.accentMaterial(true))
					.fontColor(this.sheetActionFg())
					.stateStyles({
						pressed: {
							.scale({ x: 0.97, y: 0.97 })
							.opacity(0.9)
						},
					})
					.animation({ duration: 200, curve: curves.springMotion(0.35, 0.9) })
					.enabled(this.linkUrl.trim() !== '')
					.onClick(() => {
						this.submitLinkSheet();
					})
			}
			// Rejections stay on the form and are reported back by the page
			// (`setConnectInfo.error`): closing the sheet on submit would hide
			// both the reason and the values that need correcting.
			if (this.connectError !== '') {
				Text(this.connectError)
					.fontSize(12.5)
					.fontColor(this.themeDark ? '#FF7B72' : '#C62828')
					.padding({ left: 2, top: -4 })
					.maxLines(2)
					.textOverflow({ overflow: TextOverflow.Ellipsis })
			}
		}
		.width('100%')
		.padding({ left: 20, right: 20, top: 8, bottom: 24 })
	}

	/** True when the window is wide enough for a centred panel instead of a
	 *  full-width bottom sheet (`md` and up). */
	private sheetCentred(): boolean {
		return this.metrics.width === 'md' || this.metrics.width === 'lg' || this.metrics.width === 'xl';
	}

	/**
	 * Native connect guide — tab 0 becomes an ArkTS page instead of the Web
	 * connect screen (the WebView is a single surface, so the page keeps
	 * rendering behind; this overlay simply paints over it). The guide owns no
	 * business state: strings are static i18n or pushed by the page
	 * (`setConnectInfo` / `setHosts`), and every action pushes back (scan /
	 * pair / link / host / skip) so credentials never land in ArkTS.
	 */
	@Builder
	connectRow() {
		Column() {
			Row({ space: 12 }) {
				Image($r('app.media.app_icon'))
					.width(42)
					.height(42)
					.borderRadius(12)
				Text($r('app.string.app_name'))
					.fontSize(20)
					.fontWeight(FontWeight.Bold)
					.fontColor(this.primaryTextColor())
				Blank()
				Button() {
					Image($r('app.media.tab_settings'))
						.width(20)
						.height(20)
						.fillColor(this.primaryTextColor())
				}
				.width(40)
				.height(40)
				.type(ButtonType.Circle)
				.backgroundColor(this.apiLevel < 26 ? (this.themeDark ? '#1FFFFFFF' : '#0F000000') : Color.Transparent)
				.systemMaterial(this.surfaceMaterial())
				.accessibilityText($r('app.string.connect_settings_a11y'))
				.onClick(() => {
					this.activateTab(2);
				})
			}
			.width('100%')

			Scroll() {
				Column({ space: 14 }) {
					// Hero first, like the reference guide: brand orb, title,
					// one-line promise — who you are, what this screen does,
					// then the actions below it.
					Column({ space: 10 }) {
						Image($r('app.media.app_icon'))
							.width(72)
							.height(72)
							.borderRadius(20)
						Text($r('app.string.connect_title'))
							.fontSize(26)
							.fontWeight(FontWeight.Bold)
							.fontColor(this.primaryTextColor())
							.textAlign(TextAlign.Center)
						Text($r('app.string.connect_sub'))
							.fontSize(13)
							.fontColor(this.secondaryTextColor())
							.textAlign(TextAlign.Center)
					}
					.width('100%')
					.padding({ top: 8, bottom: 4 })

					if (this.connectSkipped) {
						this.connectComputers()
						Button($r('app.string.connect_connect'))
							.width('100%')
							.height(50)
							.type(ButtonType.Normal)
							.borderRadius(14)
							.backgroundColor(this.apiLevel < 26 ? this.tabSelectedColor() : Color.Transparent)
							.systemMaterial(this.accentMaterialStrong())
							.fontColor(this.sheetActionFg())
							.stateStyles({
								pressed: {
									.scale({ x: 0.97, y: 0.97 })
									.opacity(0.9)
								},
							})
							.animation({ duration: 200, curve: curves.springMotion(0.35, 0.9) })
							.onClick(() => {
								this.returnToConnect();
							})
					} else {
						if (this.connectOffline) {
							Row() {
								Text($r('app.string.connect_offline'))
									.fontSize(13)
									.fontColor(this.secondaryTextColor())
									.layoutWeight(1)
							}
							.width('100%')
							.padding(12)
							.borderRadius(10)
							.backgroundColor(this.apiLevel < 26 ? (this.themeDark ? '#1FFFFFFF' : '#0F000000') : Color.Transparent)
							.systemMaterial(this.surfaceMaterial())
						}
						// Primary action: scanning is the main way in — one
						// full-width accent button, the same press language as
						// every other primary control in the app.
						Button() {
							Row({ space: 8 }) {
								Image($r('app.media.connect_scan'))
									.width(20)
									.height(20)
									.fillColor(this.sheetActionFg())
								Text($r('app.string.connect_scan'))
									.fontSize(16)
									.fontWeight(FontWeight.Medium)
									.fontColor(this.sheetActionFg())
							}
						}
						.width('100%')
						.height(52)
						.type(ButtonType.Normal)
						.borderRadius(14)
						.backgroundColor(this.apiLevel < 26 ? this.tabSelectedColor() : Color.Transparent)
						.systemMaterial(this.accentMaterialStrong())
						.stateStyles({
							pressed: {
								.scale({ x: 0.97, y: 0.97 })
								.opacity(0.9)
							},
						})
						.animation({ duration: 200, curve: curves.springMotion(0.35, 0.9) })
						.onClick(() => {
							this.openScanner();
						})

						// Secondary: pair code and remote link as icon rows in
						// one glass card — the reference guide's list language.
						this.connectMethodGroup()

						if (this.connectHosts.length > 0) {
							this.connectComputers()
						}
						if (this.connectError !== '') {
							Text(this.connectError)
								.fontSize(13)
								.fontColor(this.errorColor())
								.width('100%')
								.textAlign(TextAlign.Start)
						}
					}
				}
				.width('100%')
				.padding({ left: 20, right: 20, top: 4, bottom: 16 })
			}
			.width('100%')
			.layoutWeight(1)
			.scrollBar(BarState.Off)
			.align(Alignment.TopStart)

			// Skip stays pinned below the scroll so the guide's actions never
			// squeeze it away — last resort, visually the quietest element.
			if (!this.connectSkipped) {
				Text($r('app.string.connect_skip'))
					.fontSize(14)
					.fontColor(this.secondaryTextColor())
					.width('100%')
					.textAlign(TextAlign.Center)
					.padding({ top: 10, bottom: 6 })
					.onClick(() => {
						this.skipConnect();
					})
			}
		}
		.width('100%')
		.height('100%')
		.padding({ top: this.insets().top, bottom: this.bottomChromeHeight() })
		.linearGradient({ angle: 180, colors: this.pageBgGradient() })
		.zIndex(5)
	}

	/** Saved-computer section of the connect page: a glass card of rows. */
	@Builder
	connectComputers() {
		Column({ space: 0 }) {
			Row() {
				Text($r('app.string.connect_computers'))
					.fontSize(13)
					.fontColor(this.secondaryTextColor())
					.layoutWeight(1)
				Text(`${this.connectHosts.length}`)
					.fontSize(13)
					.fontColor(this.secondaryTextColor())
			}
			.width('100%')
			.padding({ left: 4, right: 4, bottom: 8 })

			Column({ space: 0 }) {
				ForEach(this.connectHosts, (row: ConnectHostRow) => {
					Row({ space: 12 }) {
						Image($r('app.media.app_icon'))
							.width(28)
							.height(28)
							.borderRadius(8)
						Column({ space: 2 }) {
							Text(row.label)
								.fontSize(16)
								.fontWeight(FontWeight.Medium)
								.fontColor(this.primaryTextColor())
								.maxLines(1)
								.textOverflow({ overflow: TextOverflow.Ellipsis })
							if (row.subtitle !== '') {
								Text(row.subtitle)
									.fontSize(12)
									.fontColor(this.secondaryTextColor())
									.maxLines(1)
									.textOverflow({ overflow: TextOverflow.Ellipsis })
							}
						}
						.alignItems(HorizontalAlign.Start)
						.layoutWeight(1)
						Text('›')
							.fontSize(18)
							.fontColor(this.secondaryTextColor())
					}
					.width('100%')
					.constraintSize({ minHeight: 60 })
					.padding({ left: 14, right: 14 })
					.alignItems(VerticalAlign.Center)
					.stateStyles({
						pressed: { .backgroundColor(this.accentTint(this.themeDark ? 0.20 : 0.16)) },
					})
					.onClick(() => {
						this.connectHost(row.id);
					})
					.accessibilityText(`${row.label} ${row.subtitle}`)
				}, (row: ConnectHostRow): string => row.id)
			}
			.width('100%')
			.borderRadius(14)
			.backgroundColor(this.apiLevel < 26 ? this.cardBg() : Color.Transparent)
			.systemMaterial(this.surfaceMaterial())
			.padding({ top: 2, bottom: 2 })
		}
		.width('100%')
	}

	/** Secondary connect methods (pair code / remote link) in one glass card,
	 *  divided by hairlines — scanning is the primary button above them. */
	@Builder
	connectMethodGroup() {
		Column({ space: 0 }) {
			this.connectMethodRow($r('app.media.connect_pair'), $r('app.string.connect_pair'),
				$r('app.string.sheet_pair_hint'), 1)
			Divider().color(this.hairline())
			this.connectMethodRow($r('app.media.connect_link'), $r('app.string.connect_link'),
				$r('app.string.sheet_link_hint'), 2)
		}
		.width('100%')
		.borderRadius(14)
		.backgroundColor(this.apiLevel < 26 ? this.cardBg() : Color.Transparent)
		.systemMaterial(this.surfaceMaterial())
		.padding({ top: 2, bottom: 2 })
	}

	/** One connect method row: icon + title/subtitle + chevron, the reference
	 *  guide's list language. `kind` selects the action (1 pair / 2 link)
	 *  because a @Builder parameter cannot be a closure. */
	@Builder
	connectMethodRow(icon: Resource, title: Resource, subtitle: Resource, kind: number) {
		Row({ space: 12 }) {
			Image(icon)
				.width(22)
				.height(22)
				.fillColor(this.secondaryTextColor())
			Column({ space: 2 }) {
				Text(title)
					.fontSize(16)
					.fontWeight(FontWeight.Medium)
					.fontColor(this.primaryTextColor())
				Text(subtitle)
					.fontSize(12)
					.fontColor(this.secondaryTextColor())
			}
			.alignItems(HorizontalAlign.Start)
			.layoutWeight(1)
			Text('›')
				.fontSize(18)
				.fontColor(this.secondaryTextColor())
		}
		.width('100%')
		.constraintSize({ minHeight: 60 })
		.padding({ left: 14, right: 14 })
		.alignItems(VerticalAlign.Center)
		.stateStyles({
			pressed: { .backgroundColor(this.accentTint(this.themeDark ? 0.20 : 0.16)) },
		})
		.onClick(() => {
			if (kind === 1) {
				this.openPairSheet();
			} else {
				this.openLinkSheet();
			}
		})
		.accessibilityText(title)
	}

	/**
	 * Sheet options for the connect form.
	 *
	 * `enableHoverMode` / `hoverModeArea` are API 14 and place the sheet in the
	 * lower half of a half-folded screen, so it stops straddling the crease.
	 * Below that the fields are not set at all: assigning them would be an
	 * unknown property on an older runtime.
	 */
	private connectSheetOptions(): SheetOptions {
		const centred = this.sheetCentred();
		const options: SheetOptions = {
			preferType: centred ? SheetType.CENTER : SheetType.BOTTOM,
			// Bottom sheets hug their content; a centred panel needs a height to
			// centre against, and the form is two fields plus an action.
			height: SheetSize.FIT_CONTENT,
			width: centred ? 560 : undefined,
			title: {
				title: this.sheetKind === 'pair' ? $r('app.string.sheet_pair_title') : $r('app.string.sheet_link_title'),
			},
			dragBar: !centred,
			showClose: true,
			maskColor: '#66000000',
			// The sheet background must be left to the material: setting an
			// opaque colour overrides it, and some materials paint nothing of
			// their own without a transparent backing (docs, example 10).
			backgroundColor: this.apiLevel >= 26 ? Color.Transparent : (this.themeDark ? '#1C1A20' : '#FFFFFF'),
			systemMaterial: this.sheetMaterial(),
			onDisappear: () => {
				this.sheetVisible = false;
			},
		};
		if (this.apiLevel >= 14) {
			options.enableHoverMode = true;
			options.hoverModeArea = HoverModeAreaType.BOTTOM_SCREEN;
		}
		return options;
	}

	/** Sheet options for the session switcher — same placement rules, but the
	 *  list needs a height of its own instead of hugging its content. */
	private sessionsSheetOptions(): SheetOptions {
		const centred = this.sheetCentred();
		const options: SheetOptions = {
			preferType: centred ? SheetType.CENTER : SheetType.BOTTOM,
			height: centred ? 560 : SheetSize.MEDIUM,
			width: centred ? 640 : undefined,
			title: { title: $r('app.string.sessions_title') },
			dragBar: !centred,
			showClose: true,
			maskColor: '#66000000',
			backgroundColor: this.apiLevel >= 26 ? Color.Transparent : (this.themeDark ? '#1C1A20' : '#FFFFFF'),
			systemMaterial: this.sheetMaterial(),
			onDisappear: () => {
				this.sessionSheetOpen = false;
				this.pushSessionAction('closed', '');
			},
		};
		if (this.apiLevel >= 14) {
			options.enableHoverMode = true;
			options.hoverModeArea = HoverModeAreaType.BOTTOM_SCREEN;
		}
		return options;
	}

	/**
	 * Bottom chrome, one geometry for both runtimes.
	 *
	 * Height is `BAR_BLOCK` plus the gesture inset, so the strip the bar paints
	 * and the strip `pushChromeLayout()` tells the page to reserve are the same
	 * number. `barFloatingStyle` is API 26: below it the bar is a plain TabBar
	 * lifted by padding, and the API-26 attribute is never evaluated on a
	 * device that cannot resolve it.
	 */
	@Builder
	bottomChrome() {
		if (this.apiLevel >= 26) {
			Tabs({
				barPosition: BarPosition.End,
				index: this.activeTab,
				controller: this.tabsController,
			}) {
				this.tabItems()
			}
			.width('100%')
			.height(this.bottomChromeHeight())
			.barMode(BarMode.Fixed)
			.barHeight(BAR_HEIGHT)
			.barOverlap(true)
			// The Tabs box must stay fully transparent: every pixel outside the
			// floating pill has to show the page behind it, or the shell reads as
			// a docked bar sitting on a band of its own background — an opaque
			// box here hid the WebView's bottom strip and left the pill's blur
			// nothing but that band to sample.
			.backgroundColor(Color.Transparent)
			// Deliberately no barBackgroundColor: a transparent bar background
			// suppresses the material's own tint and refraction. The system
			// paints the bar from systemMaterial.
			.barFloatingStyle({
				// 智感握姿: the pill hugs the holding hand and keeps a
				// consistent capsule width per breakpoint — narrow on a phone,
				// wider on tablets — instead of stretching across the window.
				adaptToHandedness: true,
				barSideMargin: 12,
				barWidth: {
					smallBarWidth: 228,
					mediumBarWidth: 280,
					largeBarWidth: 320,
				},
				maskHeight: 0,
				// Clear the gesture indicator by the system inset, not a guess:
				// a fixed 26vp left the pill over the indicator on devices with
				// a taller navigation bar.
				barBottomMargin: this.insets().bottom + BAR_GAP,
				systemMaterial: this.currentMaterial(),
			})
			// The bar stays above the settings page (which is a destination, not
			// a modal): settings never hides the navigation on any form factor.
			.zIndex(this.settingsOpen ? 30 : 5)
			.visibility(this.bottomChromeVisible())
			.onChange((index: number) => this.onTabChanged(index))
		} else {
			Tabs({
				barPosition: BarPosition.End,
				index: this.activeTab,
				controller: this.tabsController,
			}) {
				this.tabItems()
			}
			.width('100%')
			.height(this.bottomChromeHeight())
			.barMode(BarMode.Fixed)
			.barHeight(BAR_HEIGHT)
			.barOverlap(true)
			// Same full transparency as the API 26 branch: below the floating
			// pill the bar box is invisible chrome, never a painted band.
			.backgroundColor(Color.Transparent)
			// No floating material before API 26: lift the plain bar off the
			// gesture area with padding instead.
			.padding({ bottom: this.insets().bottom + BAR_GAP })
			.zIndex(this.settingsOpen ? 30 : 5)
			.visibility(this.bottomChromeVisible())
			.onChange((index: number) => this.onTabChanged(index))
		}
	}

	@Builder
	tabItems() {
		TabContent().tabBar(this.tabBarStyle($r('app.media.tab_connect'), $r('app.string.tab_connect')))
		TabContent().tabBar(this.tabBarStyle($r('app.media.tab_chat'), $r('app.string.tab_chat')))
		TabContent().tabBar(this.tabBarStyle($r('app.media.tab_settings'), $r('app.string.tab_settings')))
	}

	/** The bar is hidden under full-screen overlays and on rail layouts; the
	 *  Tabs stays mounted so returning to phone width keeps its index. */
	private bottomChromeVisible(): Visibility {
		return this.tabBarVisible ? Visibility.Visible : Visibility.None;
	}

	private onTabChanged(index: number): void {
		if (this.tabFromPage) {
			this.tabFromPage = false;
			this.activeTab = index;
			return;
		}
		// A tap on the bar goes through the same interception as the rail, so
		// 设置 opens the native overlay from either chrome.
		this.activateTab(index);
	}

	/**
	 * One-shot layout/theme readout after the first page finishes loading.
	 * Emitted as an ARKWEB-CONSOLE line (`hilog | grep musepi-viewport`) so
	 * immersive/fold regressions stay observable without adding runtime UI.
	 */
	private logViewport(): void {
		const script = `(function(){` +
			`var d=document.documentElement,c=d.querySelector('.sh-connect'),k=d.querySelector('.sh-connect-card');` +
			`var p=document.createElement('div');` +
			`p.style.cssText='position:absolute;visibility:hidden;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)';` +
			`document.body.appendChild(p);var s=getComputedStyle(p);` +
			`var et=parseFloat(s.paddingTop)||0,eb=parseFloat(s.paddingBottom)||0;p.remove();` +
			`var g=getComputedStyle(d);` +
			`console.warn('[musepi-viewport] '+JSON.stringify({theme:d.dataset.theme||'',` +
			`nativeMode:window.harmonyNative?window.harmonyNative.getColorMode():'',` +
			`storedTheme:(function(){try{return localStorage.getItem('omp-collab-theme')||''}catch(e){return ''}})(),` +
			`mqDark:matchMedia('(prefers-color-scheme: dark)').matches,` +
			`innerW:innerWidth,innerH:innerHeight,vvH:visualViewport?visualViewport.height:0,` +
			`clientH:d.clientHeight,vh:g.getPropertyValue('--viewport-height').trim(),` +
			`safeTop:g.getPropertyValue('--safe-top').trim(),safeBottom:g.getPropertyValue('--safe-bottom').trim(),` +
			`safeLeft:g.getPropertyValue('--safe-left').trim(),safeRight:g.getPropertyValue('--safe-right').trim(),` +
			`chrome:d.dataset.harmonyChrome||'',form:d.dataset.harmonyWindow||'',` +
			`formHeight:d.dataset.harmonyHeight||'',fold:d.dataset.harmonyFold||'',` +
			`envTop:et,envBottom:eb,` +
			`connectClient:c?c.clientHeight:0,connectScroll:c?c.scrollHeight:0,` +
			`cardClient:k?k.clientHeight:0,cardScroll:k?k.scrollHeight:0,` +
			`docScroll:d.scrollHeight,bodyScroll:document.body.scrollHeight}));return 'ok';})()`;
		// The page's console goes to ARKWEB-CONSOLE; ArkTS-side hilog with
		// domain 0x0000 is filtered out by the device's default log rules.
		this.controller.runJavaScript(script).catch((e: BusinessError) => {
			console.warn(`[musepi-viewport] probe failed: ${JSON.stringify(e)}`);
		});
	}

	/** The page-facing bridge. Built by a plain method, not inline in the
	 *  builder: ArkTS rejects `this` inside arrow functions that live in a
	 *  @Builder body (arkts-no-standalone-this). */
	private bridgeObject(): MuseBridgeObject {
		return {
			getSystemBars: (): string => this.systemBars(),
			getColorMode: (): string => this.getColorMode(),
			setThemeColor: (dark: boolean): void => this.setThemeColor(dark),
			setAccentColor: (hex: string): void => this.setAccentColor(hex),
			getPrefs: (): string => this.getPrefs(),
			setPref: (key: string, value: string): void => this.setPref(key, value),
			setAccentPalette: (json: string): void => this.setAccentPalette(json),
			getBadge: (): string => this.getBadge(),
			setBadgeCount: (count: number): void => this.setBadgeCount(count),
			clearBadge: (): void => this.clearBadge(),
			consumeDeepLink: (): string => this.consumeDeepLink(),
			setBackDepth: (depth: number): void => this.setBackDepth(depth),
			setActiveTab: (index: number): void => this.setActiveTab(index),
			getChromeLayout: (): string => this.chromeLayout(),
			getWindowForm: (): string => this.getWindowForm(),
			setTabBarVisible: (visible: boolean): void => this.setTabBarVisible(visible),
			openCameraSettings: (): void => this.openCameraSettings(),
			getCameraDiagnostics: (): string => this.getCameraDiagnostics(),
			setTabBarMaterial: (style: number): void => this.setTabBarMaterial(style),
			openPairSheet: (): void => this.openPairSheet(),
			openLinkSheet: (): void => this.openLinkSheet(),
			closeConnectSheet: (): void => this.closeConnectSheet(),
			openSessionsSheet: (payload: string): void => this.openSessionsSheet(payload),
			setSessions: (payload: string): void => this.setSessions(payload),
			setConnectInfo: (payload: string): void => this.setConnectInfo(payload),
			setHosts: (payload: string): void => this.setHosts(payload),
			setLiveView: (active: boolean, title: string, detail: string): void => this.syncLiveView(active, title, detail),
		};
	}

	@Builder
	webViewNode() {
			Column() {
				Web({
					src: `${this.origin}/index.html`,
					controller: this.controller,
					// Async (surface) rendering draws nothing on this ArkWeb build —
					// the DOM is live and CDP screenshots it, but the surface stops
					// reaching the window (first paint, and again after the native
					// tab switch). Sync rendering follows the system canvas and
					// presents every frame. The page is one full-screen WebView, so
					// the DSS-merge cost of sync is the acceptable side of that trade.
					renderMode: this.renderMode(),
				})
					// The shell owns the columns: the page gets the content box, so
					// its own centring and max-widths work against the real width
					// instead of against the window minus a CSS variable. Padding
					// the page from outside was one rounding error away from
					// content sliding under the sidebar.
					.height('100%')
					.javaScriptAccess(true)
					.domStorageAccess(true)
					.fileAccess(true)
					// ArkWeb dark mode defaults to Off, which freezes
					// prefers-color-scheme at "light" regardless of the OS. Auto
					// makes the web engine follow the system; force-dark stays off
					// because client-core ships its own full light/dark palettes.
					.darkMode(WebDarkMode.Auto)
					.forceDarkAccess(false)
					// Sync render follows the system canvas, so the page can own the
					// system strips: expanding into them keeps one continuous surface
					// and stops the window colour from showing as a band when the app
					// theme (not the OS) decides what "dark" looks like. All four
					// edges, because in landscape the cutout is on the side and the
					// page pads with --safe-left/--safe-right.
					.expandSafeArea([SafeAreaType.SYSTEM],
						[SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM, SafeAreaEdge.START, SafeAreaEdge.END])
					.backgroundColor(this.themeDark ? '#0B0E14' : '#FAF7FC')
					.overScrollMode(OverScrollMode.NEVER)
					.verticalScrollBarAccess(false)
					// This is an app surface, not a web page: pinch / double-tap
					// zoom scales the whole shell and makes the viewport pannable.
					// The viewport meta alone is not enough on ArkWeb — the engine
					// gesture must be disabled here too (管理网页缩放 / zoomAccess).
					.zoomAccess(false)
					// The page is served from the private https origin (see the CORS
					// note above), so every LAN collab link — always ws:// — is a
					// mixed-content request and ArkWeb blocks it outright:
					// "An insecure WebSocket connection may not be initiated from a
					// page loaded over HTTPS". The content is our own rawfile bundle
					// and the socket target is the user's own computer on the LAN,
					// so loose mode is the intended trade (Android's equivalent is
					// MIXED_CONTENT_ALWAYS_ALLOW).
					.mixedMode(MixedMode.All)
					.javaScriptProxy({
						object: this.bridgeObject(),
						name: 'harmonyNative',
						methodList: ['getSystemBars', 'getColorMode', 'setThemeColor', 'setAccentColor', 'getPrefs',
							'setPref', 'setAccentPalette', 'getBadge', 'setBadgeCount', 'clearBadge', 'consumeDeepLink',
							'setBackDepth', 'setActiveTab', 'getChromeLayout', 'getWindowForm', 'setTabBarVisible',
							'openCameraSettings', 'getCameraDiagnostics', 'setTabBarMaterial', 'openPairSheet',
							'openLinkSheet', 'closeConnectSheet', 'openSessionsSheet', 'setSessions', 'setConnectInfo', 'setHosts',
							'setLiveView'],
						controller: this.controller,
					})
					.onPermissionRequest((event) => {
						if (!event || !event.request) {
							return;
						}
						const request = event.request;
						const reqOrigin = request.getOrigin();
						AppStorage.setOrCreate('cameraOrigin', reqOrigin);
						// ArkWeb may report the origin with a trailing slash: a strict
						// equality check denied the bundled page itself, and
						// getUserMedia failed with a silent NotAllowedError.
						if (!reqOrigin.startsWith(this.origin)) {
							request.deny();
							return;
						}
						// One list, several permissions: each capture device has its
						// own HarmonyOS grant and its own dialog copy, so the request
						// is answered per resource instead of asking for the camera on
						// behalf of a microphone. Devices this shell does not expose
						// (MIDI, sensors) are refused outright.
						const resources: string[] = request.getAccessibleResource();
						const needsCamera = resources.indexOf(ProtectedResourceType.VIDEO_CAPTURE) >= 0;
						const needsMic = resources.indexOf(ProtectedResourceType.AUDIO_CAPTURE) >= 0;
						if (!needsCamera && !needsMic) {
							request.deny();
							return;
						}
						this.grantWebCapture(request, resources, needsCamera, needsMic);
					})
					.onPageEnd(() => {
						// Cold-start link stashed before the page mounted its handler.
						// Drained through `consumeDeepLink()` rather than re-read: the
						// page has normally taken it while mounting, so only a link
						// that has not been delivered yet is pushed — a reload must not
						// replay one the user already acted on.
						const stashed = this.consumeDeepLink();
						if (stashed !== '') {
							this.pushDeepLink(stashed);
						}
						// The page seeds its own layout from these two on mount, so
						// both must be pushed after every (re)load, not only on change.
						this.pushWindowForm();
						this.pushChromeLayout();
						this.logViewport();
					})
					.onInterceptRequest((event) => {
						if (!event) {
							return null;
						}
						const url = event.request.getRequestUrl();
						const prefix = `${this.origin}/`;
						if (!url.startsWith(prefix)) {
							return null; // real network traffic is not ours to rewrite
						}
						const path = decodeURIComponent(url.slice(prefix.length).split('?')[0].split('#')[0]);
						if (path === '') {
							return null;
						}
						const response = new WebResourceResponse();
						response.setResponseData($rawfile(path));
						response.setResponseMimeType(this.mimeFor(path));
						response.setResponseCode(200);
						response.setReasonMessage('OK');
						response.setResponseIsReady(true);
						return response;
					})
			}
			.width('100%')
			.height('100%')
			// The wrapper must expand with the Stack: a child of an expanded
			// container is still laid out inside the safe area, so the WebView
			// started below the status bar (y=107 on a Pura X Max) and lost that
			// strip from its own viewport — the page then reported no top inset
			// and the rail's content offset disagreed with the real window.
			.expandSafeArea([SafeAreaType.SYSTEM],
				[SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM, SafeAreaEdge.START, SafeAreaEdge.END])
			// Session switcher: a native system sheet over the content, with its
			// own scroll, search and typography. Attached here rather than to the
			// Stack because that node already carries the connect sheet — ArkUI
			// allows one bindSheet per component.
			.bindSheet($$this.sessionSheetOpen, this.sessionsSheetBody(), this.sessionsSheetOptions())

	}

	build() {
		// One shell for every form factor: the floating bottom bar is the
		// navigation everywhere (official `barFloatingStyle` with per-breakpoint
		// width + 智感握姿), and a wide window just gains the draggable session
		// column beside the content. No hand-drawn left rail.
		Stack({ alignContent: Alignment.Bottom }) {
			Row() {
				if (!this.settingsOpen && this.activeTab !== 0 && this.listPaneWidth() > 0) {
					this.sessionPane()
				}
				Column() {
					this.webViewNode()
				}
				.layoutWeight(1)
				.height('100%')
			}
			.width('100%')
			.height('100%')

			if (!this.settingsOpen && this.activeTab !== 0 && this.listPaneWidth() > 0) {
				this.paneDivider()
			}

			// The connect page is native on tab 0 (its own ArkTS page, painted
			// over the Web connect screen), so the wide window's session column
			// and divider stay hidden while it is up. `tabBarVisible` (boolean)
			// gates full-screen overlays — `bottomChromeVisible()` returns the
			// Visibility enum whose Visible member is 0, which would read as
			// false in a condition.
			if (this.activeTab === 0 && !this.settingsOpen && this.tabBarVisible) {
				this.connectRow()
			}

			this.bottomChrome()

			if (this.settingsOpen) {
				this.settingsRow()
			}

			if (this.whatsNewOpen) {
				this.whatsNew()
			}
		}
		.width('100%')
		.height('100%')
		.expandSafeArea([SafeAreaType.SYSTEM],
			[SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM, SafeAreaEdge.START, SafeAreaEdge.END])
		.backgroundColor(this.themeDark ? '#0B0E14' : '#FAF7FC')
		.onAreaChange((_old: Area, area: Area) => {
			this.applyWindowArea(area.width, area.height);
		})
		.bindSheet(this.sheetVisible, this.sheetBody(), this.connectSheetOptions())
	}


	/** True when the settings overlay docks its section beside the level-one
	 *  list (`md` and up); a phone drills in and owns a hub to return to. */
	private settingsWide(): boolean {
		return this.metrics.width === 'md' || this.metrics.width === 'lg' || this.metrics.width === 'xl';
	}

	@Builder
	settingsRow() {
		Row() {
			MuseSettings({
				open: $settingsOpen,
				themeDark: this.themeDark,
				insetTop: this.insets().top,
				bottomReserve: this.bottomChromeHeight(),
				palette: this.accentPalette,
				wide: this.settingsWide(),
				page: $settingsPage,
				onPref: (key: string, value: string): void => this.applyPref(key, value),
				onOpenSessions: (): void => this.openSessionsFromChrome(),
				onGoConnect: (): void => {
					this.settingsOpen = false;
					this.activateTab(0);
				},
				sessionCount: this.sessionRows.length,
			})
				.layoutWeight(1)
				.height('100%')
		}
		.width('100%')
		.height('100%')
		.alignItems(VerticalAlign.Top)
		// Settings is a destination like any tab: the page background runs all
		// the way to the bottom edge and the floating pill hovers over it (no
		// padding here — a bottom padding would expose the shell's own colour as
		// a second band under the pill). Content clears the pill through the
		// page's own `bottomReserve` instead.
		.zIndex(20)
	}

}
