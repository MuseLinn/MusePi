import { webview } from '@kit.ArkWeb';
import { display } from '@kit.ArkUI';
import { notificationManager } from '@kit.NotificationKit';
import { BusinessError } from '@kit.BasicServicesKit';

/**
 * MusePi WebView shell — loads the client-core mobile bundle from rawfile and
 * exposes the `harmonyNative` javaScriptProxy bridge (same surface the page
 * expects; see packages/client-core/src/lib/capacitor.ts).
 *
 * Bridge contract (all methods synchronous, JSON-string returns):
 * - getSystemBars(): '{"top":<vp>,"bottom":<vp>}' — system bar insets
 * - getBadge(): '{"count":<n>}' — launcher badge number
 * - setBadgeCount(n) / clearBadge() — badge updates
 * - consumeDeepLink(): pending `musepi://` URI or '' (drained once)
 * - setBackDepth(n) — page's back-layer depth, mirrored for `onBackPress`
 *
 * Native → page pushes (via runJavaScript):
 * - window.__harmonyDeepLink("<uri>")  — warm-start deep links
 * - window.__harmonyKeyboard(<vp>)     — IME height changes
 *
 * Window state (insets, IME height) is published by EntryAbility into
 * AppStorage: both are window events, and this bridge must answer
 * synchronously, so the page mirrors the last value instead of querying.
 *
 * Back key: `onBackPress()` below runs IME-first, then the page's layer
 * stack (`window.__harmonyBack()`), then falls through to the system.
 */

@Entry
@Component
struct Index {
	controller: webview.WebviewController = new webview.WebviewController();
	@StorageLink('pendingDeepLink') @Watch('onDeepLinkChanged') pendingDeepLink: string = '';
	/** Inset JSON published by EntryAbility from the window avoid areas. */
	@StorageLink('systemInsets') systemInsets: string = '{"top":0,"bottom":0}';
	/** Soft-keyboard height in px (0 = no IME), published by EntryAbility. */
	@StorageLink('imeHeightPx') @Watch('onImeChanged') imeHeightPx: number = 0;
	private badgeCount: number = 0;
	/** Layer depth mirrored from the page (`harmonyNative.setBackDepth`). */
	private backDepth: number = 0;

	aboutToAppear(): void {
		webview.WebviewController.initializeWebEngine();
	}

	/** Warm-start deep link landed while the page is live — push it in. */
	onDeepLinkChanged(): void {
		const uri = this.pendingDeepLink;
		if (uri === '' || uri === undefined) {
			return;
		}
		this.pushDeepLink(uri);
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

	private consumeDeepLink(): string {
		const uri = AppStorage.get<string>('pendingDeepLink') ?? '';
		if (uri !== '') {
			AppStorage.setOrCreate('pendingDeepLink', '');
		}
		return uri;
	}

	build() {
		Column() {
			Web({
				src: $rawfile('index.html'),
				controller: this.controller,
			})
				.width('100%')
				.height('100%')
				.javaScriptAccess(true)
				.domStorageAccess(true)
				.fileAccess(true)
				.backgroundColor('#00000000')
				.overScrollMode(OverScrollMode.NEVER)
				.verticalScrollBarAccess(false)
				.javaScriptProxy({
					object: {
						getSystemBars: (): string => this.systemBars(),
						getBadge: (): string => this.getBadge(),
						setBadgeCount: (count: number): void => this.setBadgeCount(count),
						clearBadge: (): void => this.clearBadge(),
						consumeDeepLink: (): string => this.consumeDeepLink(),
						setBackDepth: (depth: number): void => this.setBackDepth(depth),
					},
					name: 'harmonyNative',
					methodList: ['getSystemBars', 'getBadge', 'setBadgeCount', 'clearBadge', 'consumeDeepLink', 'setBackDepth'],
					controller: this.controller,
				})
				.onPageEnd(() => {
					// Cold-start link stashed before the page mounted its handler:
					// push once the first page finished loading.
					const stashed = AppStorage.get<string>('pendingDeepLink') ?? '';
					if (stashed !== '') {
						this.pushDeepLink(stashed);
					}
				})
		}
		.width('100%')
		.height('100%')
		.backgroundColor('#0B0E14')
	}
}
