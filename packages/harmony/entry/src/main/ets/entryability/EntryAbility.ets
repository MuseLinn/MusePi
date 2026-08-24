import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';

const TAG: string = 'MusePiEntry';
const DOMAIN: number = 0x0000;

/**
 * Cold-start deep link (musepi://connect?link=...) stored by onCreate before
 * the WebView has loaded. The JS bridge drains it via HarmonyNative.
 * consumeDeepLink() once the page is up.
 */
let pendingDeepLink: string | null = null;

/** Controller handed over by Index.ets once its WebView is created, so warm
 *  deep links can be pushed into the JS layer via runJavaScript. */
let activeController: webview.WebviewController | null = null;

export function getPendingDeepLink(): string | null {
  const link = pendingDeepLink;
  pendingDeepLink = null;
  return link;
}

export function setActiveController(controller: webview.WebviewController): void {
  activeController = controller;
}

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    if (want?.uri) {
      pendingDeepLink = want.uri;
      hilog.info(DOMAIN, TAG, 'cold deep link: %{public}s', want.uri);
    }
  }

  onNewWant(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    // Warm start: WebView may already be up — push the link straight into JS.
    const uri = want?.uri;
    if (uri && activeController) {
      const escaped = uri.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      try {
        activeController.runJavaScript(`window.__harmonyDeepLink('${escaped}')`);
      } catch {
        pendingDeepLink = uri;
      }
    } else if (uri) {
      pendingDeepLink = uri;
    }
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, TAG, 'loadContent failed: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, TAG, 'pages/Index loaded');
    });
  }
}
