import { webview } from '@kit.ArkWeb';
import { HarmonyNative } from '../bridge/HarmonyNative';
import { setActiveController } from '../entryability/EntryAbility';

/**
 * Main page: loads the shared desktop-web dist from rawfile into a
 * full-screen WebView, wired with the HarmonyNative javaScriptProxy bridge
 * for insets, badge, deep links, and keyboard height.
 */
@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  private native: HarmonyNative = new HarmonyNative();

  aboutToAppear(): void {
    setActiveController(this.controller);
  }

  build() {
    Column() {
      Web({ src: $rawfile('index.html'), controller: this.controller })
        .width('100%')
        .height('100%')
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .fileAccess(true)
        .mixedMode(MixedMode.All)
        .backgroundColor(Color.Black)
        .javaScriptProxy({
          object: this.native,
          name: 'harmonyNative',
          methodList: [
            'getSystemBars',
            'getBadge',
            'setBadgeCount',
            'clearBadge',
            'consumeDeepLink',
          ],
          controller: this.controller,
        })
        .onKeyboardHeightChange((height: number) => {
          this.controller.runJavaScript(`window.__harmonyKeyboard(${height})`);
        })
    }
    .width('100%')
    .height('100%')
  }
}