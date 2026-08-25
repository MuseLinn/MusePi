import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';

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
 */
export default class EntryAbility extends UIAbility {
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
		windowStage.getMainWindow((err, win) => {
			if (!err) {
				// Immersive: draw under the system bars from the first frame.
				win.setWindowLayoutFullScreen(true).catch((e: BusinessError) => {
					hilog.warn(DOMAIN, TAG, 'layoutFullScreen failed: %{public}s', JSON.stringify(e));
				});
			}
		});
		windowStage.loadContent('pages/Index', (err) => {
			if (err.code) {
				hilog.error(DOMAIN, TAG, 'loadContent failed: %{public}s', JSON.stringify(err));
			}
		});
	}
}
