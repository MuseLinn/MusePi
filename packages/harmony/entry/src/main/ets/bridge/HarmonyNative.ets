import { display, window } from '@kit.ArkUI';
import { notificationManager } from '@kit.NotificationKit';
import { getPendingDeepLink } from '../entryability/EntryAbility';

/**
 * Native bridge object exposed to the WebView as `window.harmonyNative`
 * via Web({ javaScriptProxy }). Each method must return a string (JSON for
 * structured data) — the javaScriptProxy contract is synchronous.
 *
 * Mirrors the Capacitor Insets/Badge plugins and the low-level deep-link
 * channel so the shared desktop-web bundle routes through whichever shell
 * is present (see lib/capacitor.ts).
 */
export class HarmonyNative {
  /**
   * System-bar insets as vp values (vp == CSS px in ArkWeb). Returns
   * conservative fallbacks when the avoid area is unavailable.
   */
  getSystemBars(): string {
    try {
      const win = window.getLastWindow(getContext(this) as Context) as window.Window;
      const avoid = win.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
      const density = this.density();
      const top = Math.round(avoid.topRect.height / density);
      const bottom = Math.round(avoid.bottomRect.height / density);
      return JSON.stringify({ top, bottom });
    } catch {
      return JSON.stringify({ top: 48, bottom: 24 });
    }
  }

  /** Current launcher badge count. */
  getBadge(): string {
    try {
      const count = notificationManager.getActiveNotificationCountSync();
      return JSON.stringify({ count });
    } catch {
      return JSON.stringify({ count: 0 });
    }
  }

  /** Set the launcher badge to an absolute count. */
  setBadgeCount(count: number): void {
    try {
      notificationManager.setBadgeNumber(count);
    } catch {
      // launcher / permission without badge support — silent
    }
  }

  /** Clear the launcher badge. */
  clearBadge(): void {
    try {
      notificationManager.setBadgeNumber(0);
    } catch {
      // launcher / permission without badge support — silent
    }
  }

  /** Drain the cold-start deep link (returns '' when none pending). */
  consumeDeepLink(): string {
    return getPendingDeepLink() ?? '';
  }

  /** Display density: px → vp conversion factor. */
  private density(): number {
    try {
      const defaultDisplay = display.getDefaultDisplaySync();
      return defaultDisplay.densityPixels;
    } catch {
      return 3.0;
    }
  }
}
