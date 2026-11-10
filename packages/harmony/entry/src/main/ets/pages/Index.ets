import { webview } from '@kit.ArkWeb';
import { display, uiMaterial, window } from '@kit.ArkUI';
import { notificationManager } from '@kit.NotificationKit';
import { abilityAccessCtrl, ConfigurationConstant, Permissions } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { deviceInfo } from '@kit.BasicServicesKit';
import { liveViewManager } from '@kit.LiveViewKit';

/**
 * MusePi WebView shell — loads the client-core mobile bundle from rawfile and
 * exposes the `harmonyNative` javaScriptProxy bridge (same surface the page
 * expects; see packages/client-core/src/lib/capacitor.ts).
 *
 * Bridge contract (all methods synchronous, JSON-string returns):
 * - getSystemBars(): '{"top":<vp>,"bottom":<vp>}' — system bar insets
 * - getColorMode(): '"dark"' | '"light"' — authoritative OS colour mode
 * - setThemeColor(dark) — page scheme → window background + system bar icons
 * - getBadge(): '{"count":<n>}' — launcher badge number
 * - setBadgeCount(n) / clearBadge() — badge updates
 * - consumeDeepLink(): pending `musepi://` URI or '' (drained once)
 * - setBackDepth(n) — page's back-layer depth, mirrored for `onBackPress`
 *
 * Native → page pushes (via runJavaScript):
 * - window.__harmonyDeepLink("<uri>")  — warm-start deep links
 * - window.__harmonyKeyboard(<vp>)     — IME height changes
 * - window.__harmonyColorMode("<mode>")— system light/dark flips
 *
 * Window state (insets, IME height, colour mode) is published by EntryAbility
 * into AppStorage: all three are window/config events, and this bridge must
 * answer synchronously, so the page mirrors the last value instead of
 * querying.
 *
 * Back key: `onBackPress()` below runs IME-first, then the page's layer
 * stack (`window.__harmonyBack()`), then falls through to the system.
 */
/**
 * Live View scenario id. HarmonyOS only renders a Live View whose `event`
 * matches a scenario approved in AppGallery Connect, so this is a placeholder
 * MusePi would register; an unapproved value just resolves to "disabled".
 */
const MUSEPI_LIVE_VIEW_EVENT: string = 'MUSEPI_AGENT_SESSION';

@Entry
@Component
struct Index {
	controller: webview.WebviewController = new webview.WebviewController();
	@StorageLink('pendingDeepLink') @Watch('onDeepLinkChanged') pendingDeepLink: string = '';
	/** Inset JSON published by EntryAbility from the window avoid areas. */
	@StorageLink('systemInsets') systemInsets: string = '{"top":0,"bottom":0}';
	/** OS colour mode, published by EntryAbility on boot / config change. */
	@StorageLink('systemColorMode') @Watch('onSystemColorModeChanged') systemColorMode: string = 'dark';
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
	/** Full-screen overlays (QR scanner) hide the bar; page pushes this. */
	@State tabBarVisible: boolean = true;
	/** Bar material thickness (0 REGULAR / 1 THICK / 2 THIN / 3 ULTRA_THIN). */
	@State materialStyle: number = 0;
	/** Connect-form sheet: '' closed, 'pair' pair code, 'link' remote link.
	 * A modal sheet replaces the web accordion — expanding a card in place made
	 * the whole guide jump between one and two rows. */
	@State sheetKind: string = '';
	@State sheetVisible: boolean = false;
	@State pairCode: string = '';
	@State pairHost: string = '';
	@State linkUrl: string = '';
	@State linkName: string = '';
	private tabsController: TabsController = new TabsController();
	/** True while the page itself is moving the bar, so onChange is not echoed back. */
	private tabFromPage: boolean = false;

	aboutToAppear(): void {
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
	 * Mirrors the Android shell's order (`setupAndroidBackHandler`): the IME
	 * first, then the app's own layer stack, then the system. HarmonyOS gives
	 * this callback only a synchronous answer, while `runJavaScript` is async —
	 * so both facts it needs are already mirrored natively: the IME height from
	 * the window event, and the layer depth from `harmonyNative.setBackDepth`
	 * (pushed on every register/unregister).
	 *
	 * Returning `false` hands the press back to the system (background the
	 * ability), which is what "back on the root screen" should do.
	 */
	onBackPress(): boolean {
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
		const ctx = this.getUIContext().getHostContext();
		if (ctx) {
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
	 * ArkWeb needs BOTH the app-level CAMERA user grant and the web
	 * PermissionRequest grant before getUserMedia can feed the QR scanner.
	 * Only our private bundled origin is ever granted; a remote page cannot
	 * reach device resources through this shell.
	 */
	private async ensureCameraPermission(): Promise<boolean> {
		try {
			const ctx = this.getUIContext().getHostContext();
			if (!ctx) return false;
			const atManager = abilityAccessCtrl.createAtManager();
			const permission: Permissions = 'ohos.permission.CAMERA';
			// Already granted (second scan, or granted from system settings)?
			// requestPermissionsFromUser() would return -1 without a dialog once
			// the user has denied it, which surfaced as a silent
			// NotAllowedError on the page.
			try {
				const status = atManager.checkAccessTokenSync(ctx.applicationInfo.accessTokenId, permission);
				if (status === abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED) {
					return true;
				}
			} catch {
				// checkAccessTokenSync unavailable — fall through to the request
			}
			const result = await atManager.requestPermissionsFromUser(ctx, [permission]);
			AppStorage.setOrCreate('cameraAuthResult', JSON.stringify(result.authResults));
			return result.authResults.length > 0 && result.authResults[0] === 0;
		} catch (e) {
			console.warn(`[musepi] camera permission failed: ${JSON.stringify(e)}`);
			return false;
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

	/** Diagnostic readout: what origin asked for the camera, and the last
	 * authResults. Empty strings when nothing has asked yet. */
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
		if (index < 0 || index > 2 || index === this.activeTab) {
			return;
		}
		this.tabFromPage = true;
		this.activeTab = index;
		this.tabsController.changeIndex(index);
	}

	/** Brand accent for the selected tab. The native bar cannot read the page's
	 * CSS variables, so this mirrors the web accent in both schemes. */
	private tabSelectedColor(): ResourceColor {
		return this.themeDark ? '#D9A441' : '#8A6A1F';
	}

	private tabIdleColor(): ResourceColor {
		return this.themeDark ? '#8E8A93' : '#7A7480';
	}

	/** Label colour on the sheet's brand-coloured action button. */
	private sheetActionFg(): ResourceColor {
		return this.themeDark ? '#1A171F' : '#FFFFFF';
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

	/** Page → native: hide the bar under full-screen overlays. */
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
			interactive: true,
			// Warm gold to match the brand accent; pure white reads as a flash.
			lightEffect: { color: this.themeDark ? '#F0C860' : '#B8860B' },
			// Thin materials need the system's auto-inverted labels to stay
			// readable over bright content.
			colorInvert: index >= 2,
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

	/** Page → native: open the remote-link sheet. */
	openLinkSheet(): void {
		this.sheetKind = 'link';
		this.sheetVisible = true;
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
		this.sheetVisible = false;
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
		this.sheetVisible = false;
	}

	/**
	 * Connect form as a system半模态 sheet. The web guide used to expand the
	 * form inside the tapped card, which pushed the whole screen from one row
	 * to two and read as a jump rather than a transition.
	 */
	@Builder
	sheetBody() {
		Column({ space: 14 }) {
			if (this.sheetKind === 'pair') {
				TextInput({ placeholder: $r('app.string.sheet_pair_hint'), text: this.pairCode })
					.type(InputType.Number)
					.maxLength(6)
					.height(52)
					.onChange((v: string) => {
						this.pairCode = v;
					})
				TextInput({ placeholder: $r('app.string.sheet_host_hint'), text: this.pairHost })
					.height(52)
					.onChange((v: string) => {
						this.pairHost = v;
					})
				Button($r('app.string.action_pair'))
					.width('100%')
					.height(50)
					.backgroundColor(this.tabSelectedColor())
					.fontColor(this.sheetActionFg())
					.stateStyles({
						pressed: {
							.scale({ x: 0.97, y: 0.97 })
							.opacity(0.9)
						},
					})
					.animation({ duration: 140, curve: Curve.FastOutSlowIn })
					.enabled(this.pairCode.trim().length === 6 && this.pairHost.trim() !== '')
					.onClick(() => {
						this.submitPairSheet();
					})
			} else {
				TextInput({ placeholder: $r('app.string.sheet_link_hint'), text: this.linkUrl })
					.height(52)
					.onChange((v: string) => {
						this.linkUrl = v;
					})
				TextInput({ placeholder: $r('app.string.sheet_name_hint'), text: this.linkName })
					.height(52)
					.maxLength(32)
					.onChange((v: string) => {
						this.linkName = v;
					})
				Button($r('app.string.action_connect'))
					.width('100%')
					.height(50)
					.backgroundColor(this.tabSelectedColor())
					.fontColor(this.sheetActionFg())
					.stateStyles({
						pressed: {
							.scale({ x: 0.97, y: 0.97 })
							.opacity(0.9)
						},
					})
					.animation({ duration: 140, curve: Curve.FastOutSlowIn })
					.enabled(this.linkUrl.trim() !== '')
					.onClick(() => {
						this.submitLinkSheet();
					})
			}
		}
		.width('100%')
		.padding({ left: 20, right: 20, top: 8, bottom: 24 })
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

	build() {
		// The web view is the whole app; the native bottom bar floats above it.
		Stack({ alignContent: Alignment.Bottom }) {
			Column() {
				Web({
				src: `${this.origin}/index.html`,
				controller: this.controller,
			})
				.width('100%')
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
				// Extend the drawing area into the status-bar / gesture-bar
				// avoid regions so the window background never shows through
				// as a contrasting strip (窗口沉浸式 / expandSafeArea).
				.expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
				.backgroundColor('#00000000')
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
					object: {
						getSystemBars: (): string => this.systemBars(),
						getColorMode: (): string => this.getColorMode(),
						setThemeColor: (dark: boolean): void => this.setThemeColor(dark),
						getBadge: (): string => this.getBadge(),
						setBadgeCount: (count: number): void => this.setBadgeCount(count),
						clearBadge: (): void => this.clearBadge(),
						consumeDeepLink: (): string => this.consumeDeepLink(),
						setBackDepth: (depth: number): void => this.setBackDepth(depth),
						setActiveTab: (index: number): void => this.setActiveTab(index),
						setTabBarVisible: (visible: boolean): void => this.setTabBarVisible(visible),
						openCameraSettings: (): void => this.openCameraSettings(),
						getCameraDiagnostics: (): string => this.getCameraDiagnostics(),
						setTabBarMaterial: (style: number): void => this.setTabBarMaterial(style),
						openPairSheet: (): void => this.openPairSheet(),
						openLinkSheet: (): void => this.openLinkSheet(),
						setLiveView: (active: boolean, title: string, detail: string): void => this.syncLiveView(active, title, detail),
					},
					name: 'harmonyNative',
					methodList: ['getSystemBars', 'getColorMode', 'setThemeColor', 'getBadge', 'setBadgeCount',
						'clearBadge', 'consumeDeepLink', 'setBackDepth', 'setActiveTab',
						'setTabBarVisible', 'openCameraSettings', 'getCameraDiagnostics', 'setTabBarMaterial',
						'openPairSheet', 'openLinkSheet', 'setLiveView'],
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
					const resources = request.getAccessibleResource();
					this.ensureCameraPermission()
						.then((granted: boolean) => {
							if (granted) request.grant(resources);
							else request.deny();
						})
						.catch(() => { request.deny(); });
				})
				.onPageEnd(() => {
					// Cold-start link stashed before the page mounted its handler:
					// push once the first page finished loading.
					const stashed = AppStorage.get<string>('pendingDeepLink') ?? '';
					if (stashed !== '') {
						this.pushDeepLink(stashed);
					}
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

			// Bottom bar: a real Tabs (barPosition End) so HarmonyOS 7 applies
			// its immersive light-sense material. A plain Row would only read as
			// a CSS blur — the system material is what gives the bar its
			// refraction, press light feedback and shadow.
			Tabs({
				barPosition: BarPosition.End,
				index: this.activeTab,
				controller: this.tabsController,
			}) {
				TabContent().tabBar(this.tabBarStyle($r('app.media.tab_connect'), $r('app.string.tab_connect')))
				TabContent().tabBar(this.tabBarStyle($r('app.media.tab_chat'), $r('app.string.tab_chat')))
				TabContent().tabBar(this.tabBarStyle($r('app.media.tab_settings'), $r('app.string.tab_settings')))
			}
			.visibility(this.tabBarVisible ? Visibility.Visible : Visibility.None)
			.width('100%')
			.height(96)
			.barMode(BarMode.Fixed)
			.barHeight(56)
			.barOverlap(true)
			// Deliberately no barBackgroundColor: a transparent bar background
			// suppresses the material's own tint and refraction. The system
			// paints the bar from systemMaterial.
			.barFloatingStyle({
				// Bias the floating pill toward the holding hand.
				adaptToHandedness: true,
				maskHeight: 0,
				barBottomMargin: 26,
				systemMaterial: this.currentMaterial(),
			})
			.onChange((index: number) => {
				this.activeTab = index;
				if (this.tabFromPage) {
					this.tabFromPage = false;
					return;
				}
				const name = index === 0 ? 'connect' : index === 1 ? 'chat' : 'settings';
				this.controller
					.runJavaScript(`window.__musepiTab && window.__musepiTab("${name}")`)
					.catch((e: BusinessError) => {
						console.warn(`[musepi] tab push failed: ${JSON.stringify(e)}`);
					});
			})
		}
		.width('100%')
		.height('100%')
		.expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
		.backgroundColor(this.themeDark ? '#0B0E14' : '#FAF7FC')
		.bindSheet(this.sheetVisible, this.sheetBody(), {
			// Bottom sheet, not a centred dialog: the form is a continuation of
			// the guide, and rising from the edge keeps the page in context.
			preferType: SheetType.BOTTOM,
			height: SheetSize.FIT_CONTENT,
			title: {
				title: this.sheetKind === 'pair' ? $r('app.string.sheet_pair_title') : $r('app.string.sheet_link_title'),
			},
			dragBar: true,
			showClose: true,
			maskColor: '#66000000',
			backgroundColor: this.themeDark ? '#1C1A20' : '#FFFFFF',
			onDisappear: () => {
				this.sheetVisible = false;
			},
		})
	}
}
