import { web_webview } from '@kit.ArkWeb';
import { window, display } from '@kit.ArkUI';
import { notificationManager } from '@kit.NotificationKit';

/**
 * MusePi WebView shell — loads the desktop-web mobile bundle from rawfile and
 * exposes the `harmonyNative` javaScriptProxy bridge (same surface the page
 * expects; see packages/desktop-web/src/lib/capacitor.ts).
 *
 * Bridge contract (all methods synchronous, JSON-string returns):
 * - getSystemBars(): '{"top":<vp>,"bottom":<vp>}' — system bar insets
 * - getBadge(): '{"count":<n>}' — launcher badge number
 * - setBadgeCount(n) / clearBadge() — badge updates
 * - consumeDeepLink(): pending `musepi://` URI or '' (drained once)
 *
 * Native → page pushes (via runJavaScript):
 * - window.__harmonyDeepLink("<uri>")  — warm-start deep links
 * - window.__harmonyKeyboard(<vp>)     — IME height changes
 */

@Entry
@Component
struct Index {
	controller: web_webview.WebviewController = new web_webview.WebviewController();
	@StorageLink('pendingDeepLink') @Watch('onDeepLinkChanged') pendingDeepLink: string = '';
	private badgeCount: number = 0;

	aboutToAppear(): void {
		web_webview.WebviewController.initializeWebEngine();
	}

	/** Warm-start deep link landed while the page is live — push it in. */
	onDeepLinkChanged(): void {
		const uri = this.pendingDeepLink;
		if (uri === '' || uri === undefined) {
			return;
		}
		this.pushDeepLink(uri);
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
		const d = display.getDefaultDisplaySync();
		const density = d.densityPixels > 0 ? d.densityPixels : 1;
		return Math.round(px / density);
	}

	private systemBars(): string {
		try {
			const ctx = this.getUIContext().getHostContext();
			const sys = window.getWindowAvoidArea(ctx, window.AvoidAreaType.TYPE_SYSTEM);
			const navi = window.getWindowAvoidArea(ctx, window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR);
			return JSON.stringify({
				top: this.pxToVp(sys.topRect.height),
				bottom: this.pxToVp(navi.bottomRect.height),
			});
		} catch (err) {
			// avoid areas unreachable — fixed allowance (Android fallback parity)
			return JSON.stringify({ top: 48, bottom: 24 });
		}
	}

	private getBadge(): string {
		return JSON.stringify({ count: this.badgeCount });
	}

	private setBadgeCount(count: number): void {
		this.badgeCount = count;
		try {
			notificationManager.setNotificationBadgeNumber(count);
		} catch (err) {
			// launcher without badge support — silent
		}
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
					},
					name: 'harmonyNative',
					methodList: ['getSystemBars', 'getBadge', 'setBadgeCount', 'clearBadge', 'consumeDeepLink'],
					controller: this.controller,
				})
				.onKeyboardHeightChange((height: number) => {
					const vp = this.pxToVp(height);
					this.controller.runJavaScript(`window.__harmonyKeyboard && window.__harmonyKeyboard(${vp})`)
						.catch(() => {});
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
