import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const TAG: string = 'MusePrefs';
const DOMAIN: number = 0x0000;
const STORE_NAME: string = 'musepi_settings';

/**
 * User settings, owned by the shell.
 *
 * Until now the only copy lived in the WebView's `localStorage`, which made the
 * settings page a web page: it could not exist without a live connection, its
 * controls inherited web spacing, and Android/Harmony could not share a value
 * with the native chrome. The shell now owns the record and the page reads it
 * (`getPrefs`) or receives pushes (`__musepiPref`).
 *
 * Keys mirror the web preference names 1:1 so a value round-trips without a
 * translation table:
 *   theme          system | light | dark
 *   accent         theme | brand | mono | ocean | jade
 *   fontScale      13 | 15 | 17
 *   locale         zh-CN | en-US
 *   tabBarMaterial 0..3
 *   notifyOnFinish 1 | 0   (post a notification when a background turn ends)
 *   notifyOnAsk    1 | 0   (written by the page only; stored so it persists)
 *   notifyDnd      1 | 0
 *   voiceStyle     default | concise | warm
 *   voiceLocale    system | zh-CN | en-US
 *
 * Synchronous, because `getPrefs()` is a javaScriptProxy method and the bridge
 * contract is "answer without awaiting". `preferences` exposes `getSync` /
 * `putSync` since API 10; the install floor is API 12.
 */
export class PrefsStore {
	private static store: preferences.Preferences | null = null;

	static init(ctx: common.Context): void {
		if (PrefsStore.store !== null) {
			return;
		}
		try {
			const options: preferences.Options = { name: STORE_NAME };
			PrefsStore.store = preferences.getPreferencesSync(ctx, options);
		} catch (e) {
			hilog.warn(DOMAIN, TAG, 'preferences unavailable: %{public}s', JSON.stringify(e));
			PrefsStore.store = null;
		}
	}

	static get(key: string, fallback: string): string {
		const store = PrefsStore.store;
		if (store === null) {
			return fallback;
		}
		try {
			const value = store.getSync(key, fallback);
			return typeof value === 'string' ? value : fallback;
		} catch (e) {
			return fallback;
		}
	}

	static set(key: string, value: string): void {
		const store = PrefsStore.store;
		if (store === null) {
			return;
		}
		try {
			store.putSync(key, value);
			// The write must survive a kill; flush is async and the UI does not
			// wait for it (a failed flush leaves the in-memory value intact and
			// the next write retries).
			store.flush().catch((e: Error) => {
				hilog.warn(DOMAIN, TAG, 'flush failed: %{public}s', e.message);
			});
		} catch (e) {
			hilog.warn(DOMAIN, TAG, 'put failed: %{public}s', JSON.stringify(e));
		}
	}

	/** Every stored key as one JSON object; missing keys are simply absent, so
	 *  the page can tell "never set here" from "set to the default". */
	static snapshot(keys: string[]): string {
		const out: Record<string, string> = {};
		for (const key of keys) {
			const value = PrefsStore.get(key, '');
			if (value !== '') {
				out[key] = value;
			}
		}
		return JSON.stringify(out);
	}
}

/**
 * Keys mirrored to the page through `getPrefs` / `__musepiPref`.
 *
 * `notifyOnFinish` / `notifyOnAsk` are the page's own names (`mobile-prefs.ts`),
 * kept verbatim so both surfaces write one value instead of two. The shell has
 * no row for `notifyOnAsk`; storing it is what makes that page toggle survive a
 * restart. `notifyDnd` / `voiceStyle` / `voiceLocale` are switched here and read
 * by the page's voice panel. Shell-private keys (pane widths) stay out.
 */
export const PREF_KEYS: string[] = [
	'theme',
	'accent',
	'fontScale',
	'locale',
	'tabBarMaterial',
	'notifyOnFinish',
	'notifyOnAsk',
	'notifyDnd',
	'voiceStyle',
	'voiceLocale',
];
