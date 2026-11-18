import { BusinessError, deviceInfo, pasteboard } from '@kit.BasicServicesKit';
import {
	LengthMetrics,
	SegmentButton,
	SegmentButtonItemTuple,
	SegmentButtonOptions,
	SubHeader,
	TextModifier,
	UIContext,
	uiMaterial,
} from '@kit.ArkUI';
import { bundleManager, common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { webview } from '@kit.ArkWeb';
import { notificationManager } from '@kit.NotificationKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { PrefsStore } from '../common/prefs';

const TAG: string = 'MuseSettings';
const DOMAIN: number = 0x0000;

/** Stops of the two voice pickers; the labels live in string resources. */
const VOICE_STYLES: string[] = ['default', 'concise', 'warm'];
const VOICE_LOCALES: string[] = ['system', 'zh-CN', 'en-US'];

/** Entries the cache walk may visit in one pass. The walk runs on the UI thread
 *  when a section opens, and a warm cache can hold tens of thousands of
 *  shader/bundle fragments; the cut keeps the row responsive and the figure is
 *  still a measurement of what was counted. */
const WALK_LIMIT: number = 2000;

/**
 * One level of the settings stack entering.
 *
 * Shared with the shell page because the back KEY lives there: returning from
 * a section to the hub has to look like the in-page back button, which is this
 * motion — a bare state swap reads as two different apps.
 */
export function animateSettingsPush(ctx: UIContext, apply: () => void): void {
	ctx.animateTo({ duration: 220, curve: Curve.FastOutSlowIn }, apply);
}

/** One preset of the accent row, resolved by the page so the swatch IS the
 *  colour the tap applies (the token file derives a different lightness per
 *  scheme; the shell must not guess it). */
interface AccentSwatch {
	id: string;
	hex: string;
	label: Resource;
}

/** Shape of the diagnostics blob (ArkTS has no structural object literals). */
interface DiagnosticsPayload {
	app: string;
	version: string;
	api: string;
	device: string;
	theme: string;
	accent: string;
	fontScale: string;
	locale: string;
	tabBarMaterial: string;
	wide: string;
}

/**
 * Capsule stops for one setting.
 *
 * The field initialisers of `MuseSettings` run before `aboutToAppear`, so they
 * cannot read the resolved accent; the colours are optional so the empty
 * default (no stops yet) stays valid.
 */
function capsuleStops(labels: SegmentButtonItemTuple, track: ResourceColor, selected: ResourceColor,
	idleInk: ResourceColor, selectedInk: ResourceColor): SegmentButtonOptions {
	return SegmentButtonOptions.capsule({
		buttons: labels,
		backgroundColor: track,
		selectedBackgroundColor: selected,
		fontColor: idleInk,
		selectedFontColor: selectedInk,
		fontSize: 13,
		selectedFontSize: 13,
		fontWeight: FontWeight.Medium,
		selectedFontWeight: FontWeight.Medium,
	});
}

interface SettingRow {
	key: string;
	label: ResourceStr;
	value: ResourceStr;
}

/**
 * Capsule segmented control (official `SegmentButton`).
 *
 * A child component, not a `@Builder`: `SegmentButton` takes its options
 * through `@ObjectLink` and its selection through `@Link`, so both have to be
 * `@Observed`/state owned by the component that renders it. Colours arrive as
 * props instead of being read here — the page already resolves the accent and
 * the ink that stays readable on it.
 */
@Component
struct SegmentedControl {
	/** Stop labels, in display order; 2 to 5 entries (the component's limit). */
	@Prop labels: Resource[];
	/** Selected stop, mirrored from the page's own value. */
	@Prop @Watch('onSelectedChanged') selected: number;
	@Prop trackBg: ResourceColor;
	@Prop selectedBg: ResourceColor;
	@Prop idleInk: ResourceColor;
	@Prop selectedInk: ResourceColor;
	/** Report a tap; the page animates and persists the value. */
	onPick: (index: number) => void = () => {};
	/** Placeholder options for the two field states that exist before the first
	 *  build: `aboutToAppear` rebuilds them from the real labels and colours. */
	@State options: SegmentButtonOptions = SegmentButtonOptions.capsule({
		buttons: [{ text: '' }, { text: '' }],
	});
	@State private indexes: number[] = [0];

	aboutToAppear(): void {
		this.rebuild();
		this.indexes = [this.selected];
	}

	/** The page changed the value (or the accent/scheme did): restyle, re-select. */
	onSelectedChanged(): void {
		this.rebuild();
		if (this.indexes[0] !== this.selected) {
			this.indexes = [this.selected];
		}
	}

	private rebuild(): void {
		this.options = capsuleStops(this.buttons(), this.trackBg, this.selectedBg,
			this.idleInk, this.selectedInk);
	}

	/**
	 * The component takes a tuple of 2..5 stops, so the length is spelled out
	 * instead of mapped — a mapped array does not type as a tuple.
	 */
	private buttons(): SegmentButtonItemTuple {
		const labels = this.labels;
		if (labels.length >= 5) {
			return [{ text: labels[0] }, { text: labels[1] }, { text: labels[2] },
				{ text: labels[3] }, { text: labels[4] }];
		}
		if (labels.length === 4) {
			return [{ text: labels[0] }, { text: labels[1] }, { text: labels[2] }, { text: labels[3] }];
		}
		if (labels.length === 3) {
			return [{ text: labels[0] }, { text: labels[1] }, { text: labels[2] }];
		}
		return [{ text: labels[0] }, { text: labels[1] }];
	}

	build() {
		SegmentButton({
			options: this.options,
			selectedIndexes: $indexes,
			onItemClicked: (index: number) => {
				if (index !== this.selected) {
					this.onPick(index);
				}
			},
		})
	}
}

/**
 * Section title token for `SubHeader`.
 *
 * `SubHeader` styles its own title from the system token; MusePi's section
 * headers are one step quieter than a card title, so the modifier carries the
 * scheme's secondary ink. A fresh instance is created per build (see
 * `MuseSettings.sectionTitleModifier`) so a theme flip is picked up instead of
 * freezing the colour the page booted with.
 */
class SectionTitleModifier extends TextModifier {
	ink: ResourceColor = '#9C9AA1';

	applyNormalAttribute(instance: TextAttribute): void {
		instance
			.fontSize(13)
			.fontWeight(FontWeight.Medium)
			.fontColor(this.ink);
	}
}

/**
 * Native settings.
 *
 * This replaces the WebView's settings tab on HarmonyOS: the old page was a web
 * document — it inherited web spacing, its controls were 40px HTML buttons, and
 * half of it was gated behind a live connection even though theme, language and
 * material are purely local.
 *
 * Structure follows the shell's own navigation: a hub with rows that carry their
 * current value on the right, and one sub-page per decision. The preference
 * values are local here — the shell persists them (PrefsStore) and mirrors them
 * into the page through `__musepiPref` — while the stack level is owned by the
 * shell, because the back key that walks it is a page lifecycle callback.
 */
@Component
export struct MuseSettings {
	/** Owned by the page: the overlay covers the WebView without unmounting it. */
	@Link open: boolean;
	/** Resolved scheme, so the overlay matches the page behind it. */
	@Prop themeDark: boolean;
	/** System insets in vp: the overlay is a page, so it pads rather than
	 *  painting under the status bar. */
	@Prop insetTop: number;
	/** Bottom strip owned by the floating bar: gesture inset + pill block.
	 *  The page background paints through it (no second band of the shell's
	 *  own colour), while content scrolls no further than its top edge —
	 *  the pill floats over the page, exactly like it floats over the WebView. */
	@Prop bottomReserve: number;
	/** Left gutter owned by the wide-window sidebar. Zero on phones: settings is
	 *  a full page there, and a page docked beside the sidebar otherwise. */
	@Prop insetLeft: number;
	/** `{ theme, brand, mono, ocean, jade }` → hex, pushed by the page. */
	@Prop palette: string;
	/** True when the content column is wide enough for list + detail side by
	 *  side (the shell decides; a phone always drills in instead). */
	@Prop wide: boolean;
	/** Persist + mirror one preference into the page. */
	onPref: (key: string, value: string) => void = () => {};
	/** Open the page's own session switcher (the list lives there). */
	onOpenSessions: () => void = () => {};
	/** Close settings and switch the page to its connect destination. */
	onGoConnect: () => void = () => {};
	/** Reload the WebView after its stored credentials were wiped. */
	onClearWebData: () => void = () => {};
	/** Number of sessions the page currently has, for the computers row. */
	@Prop sessionCount: number;
	/** Which page of the stack is showing: `hub` or one of the sub-pages.
	 *  Owned by the shell page: the hardware back key is handled there, and it
	 *  has to walk the same stack (section → hub → closed) this page slides. */
	@Link page: string;
	@State theme: string = 'system';
	@State accent: string = 'theme';
	@State fontScale: string = '15';
	@State locale: string = 'zh-CN';
	@State material: string = '0';
	@State version: string = '';
	/** The system's grant, not a stored flag: see `setNotificationsOn`. */
	@State notificationsOn: boolean = false;
	@State notifyOnFinish: boolean = true;
	@State notifyDnd: boolean = false;
	@State voiceStyle: string = 'default';
	@State voiceLocale: string = 'system';
	/** Cache footprint in bytes; -1 until the first measurement lands. */
	@State cacheBytes: number = -1;
	/** True while the footprint walk / origin query is running. */
	@State measuring: boolean = false;
	/** Entries the current cache walk has visited (see WALK_LIMIT). */
	private walked: number = 0;
	/** Wide-mode level-one list width (0 = the 320vp default). Persisted like
	 *  the session column, so a user who widens the list keeps it. */
	@State paneW: number = 0;
	private paneDragFrom: number = 0;
	@State paneDragging: boolean = false;
	/** Localized "selected" hint, resolved once: `accessibilityDescription` has
	 *  separate string/Resource overloads, so a `Resource | ''` ternary matches
	 *  neither. */
	private selectedLabel: string = '';

	aboutToAppear(): void {
		try {
			const res = this.getUIContext().getHostContext()?.resourceManager;
			if (res) {
				this.selectedLabel = res.getStringSync($r('app.string.a11y_selected').id);
			}
		} catch (e) {
			this.selectedLabel = '';
		}
		this.theme = PrefsStore.get('theme', 'system');
		this.accent = PrefsStore.get('accent', 'theme');
		this.fontScale = PrefsStore.get('fontScale', '15');
		this.locale = PrefsStore.get('locale', 'zh-CN');
		this.material = PrefsStore.get('tabBarMaterial', '0');
		this.notificationsOn = this.readNotificationsOn();
		this.notifyOnFinish = PrefsStore.get('notifyOnFinish', '1') !== '0';
		this.notifyDnd = PrefsStore.get('notifyDnd', '0') === '1';
		this.voiceStyle = PrefsStore.get('voiceStyle', 'default');
		this.voiceLocale = PrefsStore.get('voiceLocale', 'system');
		this.refreshFootprint();
		// A docked page opens on its first section: an empty right-hand column
		// with only a title would read as "nothing here".
		if (this.wide) {
			this.page = 'appearance';
		}
		try {
			this.version = bundleManager.getBundleInfoForSelfSync(0).versionName;
		this.paneW = Number(PrefsStore.get('settingsPaneWidth', '0')) || 0;
		} catch (e) {
			hilog.warn(DOMAIN, TAG, 'version unavailable: %{public}s', JSON.stringify(e));
		}
	}

	private commit(key: string, value: string): void {
		PrefsStore.set(key, value);
		this.onPref(key, value);
	}

	/** Navigate the stack with the slide the rest of the system uses. */
	private goTo(target: string): void {
		animateSettingsPush(this.getUIContext(), () => {
			this.page = target;
		});
		// The footprint is a measurement, not a stored value: re-take it every
		// time the section is entered instead of showing what it was at boot.
		if (target === 'storage') {
			this.refreshFootprint();
		}
	}

	/** A choice that changes a visible surface animates; the store write stays
	 *  outside the animation, once, so a drag-like sequence of taps cannot
	 *  write per frame. */
	private pick(key: string, value: string, apply: () => void): void {
		this.getUIContext().animateTo({ duration: 200, curve: Curve.FastOutSlowIn }, apply);
		this.commit(key, value);
	}

	/* ---- palette -------------------------------------------------------- */

	private swatches(): AccentSwatch[] {
		let map: Record<string, string> = {};
		try {
			map = JSON.parse(this.palette) as Record<string, string>;
		} catch (e) {
			map = {};
		}
		const pick = (id: string, fallback: string): string => {
			const value = map[id];
			return typeof value === 'string' && value.startsWith('#') ? value : fallback;
		};
		return [
			{ id: 'theme', hex: pick('theme', this.themeDark ? '#D9A441' : '#8A6A1F'), label: $r('app.string.accent_theme') },
			{ id: 'brand', hex: pick('brand', '#D9A441'), label: $r('app.string.accent_brand') },
			{ id: 'mono', hex: pick('mono', '#A6A6A6'), label: $r('app.string.accent_mono') },
			{ id: 'ocean', hex: pick('ocean', '#3E7BFA'), label: $r('app.string.accent_ocean') },
			{ id: 'jade', hex: pick('jade', '#2FA36B'), label: $r('app.string.accent_jade') },
		];
	}

	/** Ink that stays readable on an arbitrary swatch (the check mark). */
	private inkOn(hex: string): string {
		const rgb = hex.replace('#', '');
		const r = parseInt(rgb.slice(0, 2), 16);
		const g = parseInt(rgb.slice(2, 4), 16);
		const b = parseInt(rgb.slice(4, 6), 16);
		return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.6 ? '#1A171F' : '#FFFFFF';
	}

	/* ---- colour + type tokens ------------------------------------------- */

	private apiLevel(): number {
		return deviceInfo.sdkApiVersion;
	}

	private textPrimary(): ResourceColor {
		return this.themeDark ? '#F2F1F3' : '#1B1A1D';
	}

	private textSecondary(): ResourceColor {
		return this.themeDark ? '#9C9AA1' : '#6E6B73';
	}

	private cardBg(): ResourceColor {
		return this.themeDark ? '#17181C' : '#FFFFFF';
	}

	private pageBg(): ResourceColor {
		return this.themeDark ? '#0E0F12' : '#F6F4F1';
	}

	/**
	 * Vertical gradient stops for the page background: a barely-there fall
	 * towards the bottom edge. The floating bar's immersive material samples
	 * whatever is behind the pill — a flat colour reads as an opaque slab, a
	 * gradient gives the glass depth and lets the light-sense actually show.
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

	private hairline(): ResourceColor {
		return this.themeDark ? '#26FFFFFF' : '#14000000';
	}

	/** Accent at low alpha for tinted surfaces (`#AARRGGBB`). */
	private tint(alpha: number): string {
		const rgb = this.accentColor().replace('#', '');
		const value = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
		return `#${value.toString(16).padStart(2, '0')}${rgb}`;
	}

	/** The app-wide immersive surface: same ladder as the tab-bar material, so
	 *  the preference that says "richer to the left, lighter on battery to the
	 *  right" governs every card, not just the bar. API 26 gates it: below the
	 *  floor these return undefined and the call sites fall back to their
	 *  existing colours. */
	private surfaceMaterial(): SystemUiMaterial | undefined {
		if (deviceInfo.sdkApiVersion < 26) {
			return undefined;
		}
		const styles: uiMaterial.ImmersiveStyle[] = [
			uiMaterial.ImmersiveStyle.THICK,
			uiMaterial.ImmersiveStyle.THICK,
			uiMaterial.ImmersiveStyle.THIN,
			uiMaterial.ImmersiveStyle.ULTRA_THIN,
		];
		const index = Number(this.material);
		const style = styles[index >= 0 && index < styles.length ? index : 0];
		return new uiMaterial.ImmersiveMaterial({
			style: style,
			interactive: false,
			applyShadow: true,
			colorInvert: false,
		});
	}

	/** Elevated, tinted material for the selected segment / primary control:
	 *  accent-tinted glass with the finger light, not a flat fill. */
	private accentMaterial(): SystemUiMaterial | undefined {
		if (deviceInfo.sdkApiVersion < 26) {
			return undefined;
		}
		return new uiMaterial.ImmersiveMaterial({
			style: uiMaterial.ImmersiveStyle.REGULAR,
			materialColor: this.tintHex(this.accentColor(), 0.18),
			interactive: true,
			applyShadow: true,
			colorInvert: false,
			lightEffect: { color: this.accentColor() },
		});
	}

	/** `#RRGGBB` with a leading alpha byte, for `materialColor`. */
	private tintHex(hex: string, alpha: number): string {
		const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255).toString(16).padStart(2, '0');
		return `#${a}${hex.replace('#', '')}`;
	}

	private accentColor(): string {
		const wanted = this.swatches().find((item: AccentSwatch) => item.id === this.accent);
		return wanted !== undefined ? wanted.hex : (this.themeDark ? '#D9A441' : '#8A6A1F');
	}

	/** Destructive action ink: red enough to read as irreversible in both
	 *  schemes, lightened in dark mode so it keeps contrast on the card. */
	private dangerColor(): ResourceColor {
		return this.themeDark ? '#FF8A7A' : '#C0392B';
	}

	/* ---- notifications -------------------------------------------------- */

	/** Ability context for the system notification dialog. Null in preview,
	 *  where the page is built without an ability behind it. */
	private abilityContext(): common.UIAbilityContext | null {
		const ctx = this.getUIContext().getHostContext();
		return ctx ? ctx as common.UIAbilityContext : null;
	}

	private readNotificationsOn(): boolean {
		try {
			return notificationManager.isNotificationEnabledSync();
		} catch (e) {
			return false;
		}
	}

	private syncNotificationsOn(): void {
		this.notificationsOn = this.readNotificationsOn();
	}

	/**
	 * The master switch.
	 *
	 * It reflects the SYSTEM grant, not a stored flag: a local boolean that
	 * disagreed with the permission would let the user "enable" something the
	 * system still blocks, and the mismatch would only surface when a
	 * notification silently failed to post. Turning it on asks the system;
	 * turning it off opens the system page, because an app cannot revoke its own
	 * grant. Either way the switch is re-read from the system afterwards.
	 */
	private setNotificationsOn(next: boolean): void {
		const ctx = this.abilityContext();
		if (ctx === null) {
			this.syncNotificationsOn();
			return;
		}
		if (!next) {
			this.openNotificationSettings(ctx);
			return;
		}
		// Resolves immediately when the grant already exists.
		notificationManager.requestEnableNotification(ctx)
			.then(() => this.syncNotificationsOn())
			.catch((e: BusinessError) => {
				// 1600004 (denied earlier) and every other failure land here: once
				// the request dialog has been refused it cannot be shown again, so
				// the system page is the route left.
				this.syncNotificationsOn();
				this.openNotificationSettings(ctx);
			});
	}

	private openNotificationSettings(ctx: common.UIAbilityContext): void {
		if (this.apiLevel() < 13) {
			// The notification page arrived in API 13; below it the grant can only
			// be changed by the user opening system Settings themselves.
			this.syncNotificationsOn();
			return;
		}
		notificationManager.openNotificationSettings(ctx)
			.then(() => this.syncNotificationsOn())
			.catch((e: BusinessError) => {
				hilog.warn(DOMAIN, TAG, 'notification settings unavailable: %{public}s', JSON.stringify(e));
				this.syncNotificationsOn();
			});
	}

	private setTurnDone(next: boolean): void {
		this.notifyOnFinish = next;
		this.commit('notifyOnFinish', next ? '1' : '0');
	}

	private setDnd(next: boolean): void {
		this.notifyDnd = next;
		this.commit('notifyDnd', next ? '1' : '0');
	}

	/* ---- storage -------------------------------------------------------- */

	private cacheDir(): string {
		const ctx = this.getUIContext().getHostContext();
		return ctx ? ctx.cacheDir : '';
	}

	private formatBytes(bytes: number): string {
		if (bytes < 0) {
			return '—';
		}
		if (bytes < 1024) {
			return `${bytes} B`;
		}
		const kb = bytes / 1024;
		if (kb < 1024) {
			return `${kb.toFixed(1)} KB`;
		}
		const mb = kb / 1024;
		if (mb < 1024) {
			return `${mb.toFixed(1)} MB`;
		}
		return `${(mb / 1024).toFixed(2)} GB`;
	}

	/** Bytes under one directory, capped by WALK_LIMIT. */
	private dirBytes(path: string): number {
		if (path === '' || this.walked >= WALK_LIMIT) {
			return 0;
		}
		let names: string[] = [];
		try {
			names = fs.listFileSync(path);
		} catch (e) {
			return 0;
		}
		let total = 0;
		for (const name of names) {
			if (this.walked >= WALK_LIMIT) {
				break;
			}
			this.walked += 1;
			const child = `${path}/${name}`;
			try {
				const stat = fs.statSync(child);
				total += stat.isDirectory() ? this.dirBytes(child) : stat.size;
			} catch (e) {
				// A cache entry evicted mid-walk is not an error.
			}
		}
		return total;
	}

	/**
	 * Footprint of everything this page can clear.
	 *
	 * Two stores hold it: ArkWeb's web storage and the app cache dir. WebStorage
	 * has no total-size getter — it reports usage per origin — so the figure is
	 * the directory walk plus the summed origin usage. Both are measurements;
	 * when web storage is not queryable yet the directory figure still stands.
	 */
	private refreshFootprint(): void {
		this.walked = 0;
		this.measuring = true;
		const dirBytes = this.dirBytes(this.cacheDir());
		this.cacheBytes = dirBytes;
		webview.WebStorage.getOrigins()
			.then((origins: webview.WebStorageOrigin[]) => {
				let web = 0;
				for (const origin of origins) {
					web += origin.usage;
				}
				this.cacheBytes = dirBytes + web;
				this.measuring = false;
			})
			.catch((e: BusinessError) => {
				// The directory figure is already a measurement of what the page
				// can clear; a failed origin query only drops the web-storage part.
				this.measuring = false;
				hilog.warn(DOMAIN, TAG, 'web storage usage unavailable: %{public}s', JSON.stringify(e));
			});
	}

	private confirmClear(): void {
		this.getUIContext().showAlertDialog({
			title: $r('app.string.storage_clear_title'),
			message: $r('app.string.storage_clear_message'),
			primaryButton: {
				value: $r('app.string.action_cancel'),
				action: () => {
				},
			},
			secondaryButton: {
				value: $r('app.string.storage_clear_confirm'),
				action: () => this.clearLocalData(),
			},
		});
	}

	/**
	 * One destructive action over three stores: ArkWeb's local storage, its
	 * cookies, and the app cache dir.
	 *
	 * The page is reloaded afterwards, not just re-rendered: the live document
	 * still holds the credentials that were just deleted, so leaving it running
	 * would show a connected UI over an empty store.
	 */
	private clearLocalData(): void {
		try {
			webview.WebStorage.deleteAllData();
		} catch (e) {
			hilog.warn(DOMAIN, TAG, 'web storage clear failed: %{public}s', JSON.stringify(e));
		}
		try {
			webview.WebCookieManager.clearAllCookiesSync();
		} catch (e) {
			hilog.warn(DOMAIN, TAG, 'cookie clear failed: %{public}s', JSON.stringify(e));
		}
		const dir = this.cacheDir();
		let names: string[] = [];
		try {
			names = fs.listFileSync(dir);
		} catch (e) {
			names = [];
		}
		for (const name of names) {
			this.removeTree(`${dir}/${name}`);
		}
		this.cacheBytes = 0;
		this.onClearWebData();
		try {
			this.getUIContext().getPromptAction().showToast({
				message: $r('app.string.storage_cleared'),
				duration: 1500,
			});
		} catch (e) {
			// A toast is a confirmation, not the result: the wipe already happened.
			hilog.warn(DOMAIN, TAG, 'clear toast failed: %{public}s', JSON.stringify(e));
		}
		this.refreshFootprint();
	}

	/** Recursive delete: `rmdirSync` refuses a non-empty directory. */
	private removeTree(path: string): void {
		try {
			const stat = fs.statSync(path);
			if (!stat.isDirectory()) {
				fs.unlinkSync(path);
				return;
			}
			const children = fs.listFileSync(path);
			for (const child of children) {
				this.removeTree(`${path}/${child}`);
			}
			fs.rmdirSync(path);
		} catch (e) {
			// Already gone, or held open by ArkWeb — the leftover is reported by
			// the next measurement rather than hidden.
		}
	}

	/* ---- builders ------------------------------------------------------- */

	@Builder
	header() {
		Row() {
			if (this.page !== 'hub' && !this.wide) {
				Button({ type: ButtonType.Circle }) {
					Text('‹').fontSize(24).fontColor(this.textPrimary()).margin({ bottom: 3 })
				}
				.width(40)
				.height(40)
				.backgroundColor(this.apiLevel() < 26 ? (this.themeDark ? '#1FFFFFFF' : '#0F000000') : Color.Transparent)
				.systemMaterial(this.surfaceMaterial())
				.accessibilityText($r('app.string.settings_back'))
				.onClick(() => this.goTo('hub'))
				.margin({ right: 8 })
			}
			Text(this.page === 'hub' || this.wide ? $r('app.string.tab_settings') : this.pageTitle())
				.fontSize(this.page === 'hub' || this.wide ? 28 : 20)
				.fontWeight(FontWeight.Bold)
				.fontColor(this.textPrimary())
				.layoutWeight(1)

		}
		.width('100%')
		.height(64)
		.padding({ left: 16, right: 16 })
		.alignItems(VerticalAlign.Center)
	}

	private pageTitle(): Resource {
		if (this.page === 'appearance') {
			return $r('app.string.settings_appearance');
		}
		if (this.page === 'language') {
			return $r('app.string.settings_language');
		}
		if (this.page === 'notifications') {
			return $r('app.string.settings_notifications');
		}
		if (this.page === 'voice') {
			return $r('app.string.settings_voice');
		}
		if (this.page === 'computers') {
			return $r('app.string.settings_computers');
		}
		if (this.page === 'diagnostics') {
			return $r('app.string.settings_diagnostics');
		}
		if (this.page === 'about') {
			return $r('app.string.settings_about');
		}
		if (this.page === 'storage') {
			return $r('app.string.settings_storage');
		}
		return $r('app.string.settings_material');
	}

	@Builder
	section(title: ResourceStr) {
		SubHeader({
			primaryTitle: title,
			primaryTitleModifier: this.sectionTitleModifier(),
			contentPadding: { start: LengthMetrics.vp(4), end: LengthMetrics.vp(0) },
		})
	}

	/** Secondary ink for a section header, rebound on every build (see
	 *  `SectionTitleModifier`). */
	private sectionTitleModifier(): SectionTitleModifier {
		const modifier = new SectionTitleModifier();
		modifier.ink = this.textSecondary();
		return modifier;
	}

	/** A row that opens a page: icon tile left, label + subtitle, current value
	 *  and chevron right. The tile is the section's first character inside an
	 *  accent-tinted block — the reference list language, with no icon assets. */
	@Builder
	navRow(tile: string, label: Resource, subtitle: ResourceStr, value: ResourceStr, target: string, last: boolean) {
		Column() {
			Row() {
				Text(tile)
					.fontSize(15)
					.fontWeight(FontWeight.Bold)
					.fontColor(this.accentColor())
					.textAlign(TextAlign.Center)
					.width(34)
					.height(34)
					.borderRadius(10)
					.backgroundColor(this.tint(this.themeDark ? 0.22 : 0.16))
					.margin({ right: 12 })
				Column({ space: 2 }) {
					Text(label)
						.fontSize(16)
						.fontWeight(FontWeight.Medium)
						.fontColor(this.textPrimary())
						.maxLines(1)
					Text(subtitle)
						.fontSize(12)
						.fontColor(this.textSecondary())
						.maxLines(1)
						.textOverflow({ overflow: TextOverflow.Ellipsis })
				}
				.alignItems(HorizontalAlign.Start)
				.layoutWeight(1)
				Text(value)
					.fontSize(14)
					.fontColor(this.textSecondary())
					.maxLines(1)
					.textOverflow({ overflow: TextOverflow.Ellipsis })
				Text('›')
					.fontSize(20)
					.fontColor(this.textSecondary())
					.margin({ left: 6, bottom: 2 })
			}
			.width('100%')
			.height(66)
			.padding({ left: 16, right: 12 })
			.alignItems(VerticalAlign.Center)
			if (!last) {
				Divider().strokeWidth(0.5).color(this.hairline()).margin({ left: 16 })
			}
		}
		.width('100%')
		.onClick(() => this.goTo(target))
		.accessibilityGroup(true)
		.accessibilityText(label)
	}

	/**
	 * The material row, with its value resolved INSIDE the builder.
	 *
	 * `navRow` takes the value as a parameter, and an ArkUI builder argument is
	 * evaluated when the parent builds — the row then keeps that string even
	 * after the preference changes. The slider therefore moved and its own
	 * caption followed, while the list summary stayed on the old value until
	 * the whole page was rebuilt.
	 *
	 * Reading `this.material` inside the builder body is what registers the
	 * dependency: ArkUI re-runs the builder when a state variable it read
	 * changes. Every other row passes a plain value and is unaffected.
	 */
	@Builder
	materialNavRow(target: string, last: boolean) {
		Column() {
			Row() {
				Text('材')
					.fontSize(15)
					.fontWeight(FontWeight.Bold)
					.fontColor(this.accentColor())
					.textAlign(TextAlign.Center)
					.width(34)
					.height(34)
					.borderRadius(10)
					.backgroundColor(this.tint(this.themeDark ? 0.22 : 0.16))
					.margin({ right: 12 })
				Column({ space: 2 }) {
					Text($r('app.string.settings_material'))
						.fontSize(16)
						.fontWeight(FontWeight.Medium)
						.fontColor(this.textPrimary())
						.maxLines(1)
					Text($r('app.string.settings_material_sub'))
						.fontSize(12)
						.fontColor(this.textSecondary())
						.maxLines(1)
						.textOverflow({ overflow: TextOverflow.Ellipsis })
				}
				.alignItems(HorizontalAlign.Start)
				.layoutWeight(1)
				Text(this.materialLabel())
					.fontSize(14)
					.fontColor(this.textSecondary())
					.maxLines(1)
					.textOverflow({ overflow: TextOverflow.Ellipsis })
				Text('›')
					.fontSize(20)
					.fontColor(this.textSecondary())
					.margin({ left: 6, bottom: 2 })
			}
			.width('100%')
			.height(66)
			.padding({ left: 16, right: 12 })
			.alignItems(VerticalAlign.Center)
			if (!last) {
				Divider().strokeWidth(0.5).color(this.hairline()).margin({ left: 16 })
			}
		}
		.width('100%')
		.onClick(() => this.goTo(target))
		.accessibilityGroup(true)
		.accessibilityText($r('app.string.settings_material'))
	}

	/**
	 * The material name for a stored index, read at call time.
	 *
	 * Same ladder as `materialValue()`: the stored value IS the shell's
	 * `ImmersiveStyle` index (0 精美, 1 均衡, 2 轻柔, 3 极薄).
	 */
	private materialLabel(): ResourceStr {
		if (this.material === '0') {
			return $r('app.string.material_regular');
		}
		if (this.material === '1') {
			return $r('app.string.material_balanced');
		}
		if (this.material === '2') {
			return $r('app.string.material_thin');
		}
		if (this.material === '3') {
			return $r('app.string.material_ultra');
		}
		return $r('app.string.material_balanced');
	}

	/** A row that only reports a value (version, system). */
	@Builder
	infoRow(label: ResourceStr, value: string, last: boolean) {
		Column() {
			Row() {
				Text(label)
					.fontSize(16)
					.fontWeight(FontWeight.Medium)
					.fontColor(this.textPrimary())
					.layoutWeight(1)
				Text(value)
					.fontSize(14)
					.fontColor(this.textSecondary())
					.maxLines(1)
			}
			.width('100%')
			.height(66)
			.padding({ left: 16, right: 16 })
			.alignItems(VerticalAlign.Center)
			if (!last) {
				Divider().strokeWidth(0.5).color(this.hairline()).margin({ left: 16 })
			}
		}
		.width('100%')
	}

	/**
	 * A switch row.
	 *
	 * The whole row is the target: ArkUI's Toggle is about 36×20 by itself, far
	 * under the 44vp touch floor, and a separate row + toggle would present one
	 * decision as two accessibility nodes. The Toggle is a read-out of the state
	 * passed in, so it neither takes hit tests nor speaks to a screen reader.
	 */
	@Builder
	switchRow(label: Resource, hint: ResourceStr, isOn: boolean, onToggle: () => void, last: boolean) {
		Column() {
			Row() {
				Column({ space: 2 }) {
					Text(label)
						.fontSize(16)
						.fontWeight(FontWeight.Medium)
						.fontColor(this.textPrimary())
						.maxLines(1)
					if (hint !== '') {
						Text(hint)
							.fontSize(12)
							.fontColor(this.textSecondary())
							.maxLines(1)
							.textOverflow({ overflow: TextOverflow.Ellipsis })
					}
				}
				.alignItems(HorizontalAlign.Start)
				.layoutWeight(1)

				Toggle({ type: ToggleType.Switch, isOn: isOn })
					.selectedColor(this.accentColor())
					.margin({ left: 12 })
					.hitTestBehavior(HitTestMode.None)
					.accessibilityLevel('no')
			}
			.width('100%')
			.height(66)
			.padding({ left: 16, right: 16 })
			.alignItems(VerticalAlign.Center)
			.stateStyles({
				pressed: { .backgroundColor(this.tint(this.themeDark ? 0.22 : 0.16)) },
			})
			.onClick(() => onToggle())
			.accessibilityGroup(true)
			.accessibilityText(label)
			.accessibilityDescription(isOn ? $r('app.string.a11y_switch_on') : $r('app.string.a11y_switch_off'))
			if (!last) {
				Divider().strokeWidth(0.5).color(this.hairline()).margin({ left: 16 })
			}
		}
		.width('100%')
	}

	/** A row that destroys something. Same geometry and press feedback as the
	 *  diagnostics row, with the label in the danger ink. */
	@Builder
	dangerRow(label: Resource, hint: ResourceStr) {
		Column() {
			Row() {
				Column({ space: 2 }) {
					Text(label)
						.fontSize(16)
						.fontWeight(FontWeight.Medium)
						.fontColor(this.dangerColor())
						.maxLines(1)
					Text(hint)
						.fontSize(12)
						.fontColor(this.textSecondary())
						.maxLines(1)
						.textOverflow({ overflow: TextOverflow.Ellipsis })
				}
				.alignItems(HorizontalAlign.Start)
				.layoutWeight(1)
				Text('›')
					.fontSize(20)
					.fontColor(this.textSecondary())
					.margin({ bottom: 2 })
			}
			.width('100%')
			.height(66)
			.padding({ left: 16, right: 12 })
			.alignItems(VerticalAlign.Center)
			.stateStyles({
				pressed: { .backgroundColor(this.tint(this.themeDark ? 0.26 : 0.20)) },
			})
			.onClick(() => this.confirmClear())
			.accessibilityGroup(true)
			.accessibilityText(label)
		}
		.width('100%')
	}


	/**
	 * One capsule control wired to a preference.
	 *
	 * `values` is the persisted spelling of each stop and `labels` is what the
	 * stop shows; `current` is the stored value, so a value that is not in the
	 * list selects nothing instead of silently picking stop 0.
	 */
	@Builder
	stops(key: string, values: string[], labels: Resource[], current: string, apply: (next: string) => void) {
		SegmentedControl({
			labels: labels,
			selected: values.indexOf(current),
			trackBg: this.apiLevel() < 26 ? (this.themeDark ? '#1FFFFFFF' : '#0A000000') : Color.Transparent,
			selectedBg: this.accentColor(),
			idleInk: this.textSecondary(),
			selectedInk: this.inkOn(this.accentColor()),
			onPick: (index: number) => {
				const next = values[index];
				this.pick(key, next, () => {
					apply(next);
				});
			},
		})
	}

	/** Card title (+ optional hint) above a control. The control is built at the
	 *  call site: a `@Builder` cannot take a component lambda, so the shared
	 *  part is the surface and the type, not the body. */
	@Builder
	cardHead(title: ResourceStr, hint: ResourceStr, showTitle: boolean) {
		Column({ space: 4 }) {
			if (showTitle) {
				Text(title)
					.fontSize(16)
					.fontWeight(FontWeight.Medium)
					.fontColor(this.textPrimary())
					.width('100%')
			}
			if (hint !== '') {
				Text(hint)
					.fontSize(12)
					.fontColor(this.textSecondary())
					.width('100%')
			}
		}
		.width('100%')
	}

	@Builder
	swatchRow() {
		Row({ space: 8 }) {
			ForEach(this.swatches(), (item: AccentSwatch) => {
				Stack() {
					Row()
						.width(30)
						.height(30)
						.borderRadius(15)
						.backgroundColor(item.hex)
					if (this.accent === item.id) {
						Text('✓')
							.fontSize(14)
							.fontWeight(FontWeight.Bold)
							.fontColor(this.inkOn(item.hex))
					}
				}
				.width(44)
				.height(44)
				.borderRadius(22)
				.accessibilityText(item.label)
				.accessibilityDescription(this.accent === item.id ? this.selectedLabel : '')
				.stateStyles({
					pressed: { .scale({ x: 0.9, y: 0.9 }) },
				})
				.onClick(() => this.pick('accent', item.id, () => {
					this.accent = item.id;
				}))
				.border(this.accent === item.id
					? { width: 2, color: this.textPrimary() }
					: { width: 2, color: Color.Transparent })
			}, (item: AccentSwatch) => item.id)
		}
		.width('100%')
	}

	@Builder
	appearancePage() {
		Scroll() {
			Column({ space: 16 }) {
				Column({ space: 12 }) {
					this.cardHead($r('app.string.theme_title'), '', true)
					this.stops('theme', ['system', 'light', 'dark'],
						[$r('app.string.theme_system'), $r('app.string.theme_light'), $r('app.string.theme_dark')],
						this.theme,
						(next: string) => {
							this.theme = next;
						})
				}
				.width('100%')
				.padding(16)
				.borderRadius(18)
				.backgroundColor(this.apiLevel() < 26 ? this.cardBg() : Color.Transparent)

				.systemMaterial(this.surfaceMaterial())

				Column({ space: 12 }) {
					this.cardHead($r('app.string.accent_title'), '', true)
					this.swatchRow()
				}
				.width('100%')
				.padding(16)
				.borderRadius(18)
				.backgroundColor(this.apiLevel() < 26 ? this.cardBg() : Color.Transparent)

				.systemMaterial(this.surfaceMaterial())

				Column({ space: 12 }) {
					this.cardHead($r('app.string.font_scale_title'), '', true)
					this.stops('fontScale', ['13', '15', '17'],
						[$r('app.string.font_small'), $r('app.string.font_default'), $r('app.string.font_large')],
						this.fontScale,
						(next: string) => {
							this.fontScale = next;
						})
				}
				.width('100%')
				.padding(16)
				.borderRadius(18)
				.backgroundColor(this.apiLevel() < 26 ? this.cardBg() : Color.Transparent)

				.systemMaterial(this.surfaceMaterial())
			}
			.padding({ left: 16, right: 16, top: 8, bottom: 32 })
		}
		.layoutWeight(1)
		.scrollBar(BarState.Off)
		.align(Alignment.Top)
		.transition(TransitionEffect.OPACITY
			.combine(TransitionEffect.translate({ x: 28 }))
			.animation({ duration: 240, curve: Curve.FastOutSlowIn }))
	}

	/** The level-one list's current width, clamped to the content column. */
	private listW(): number {
		const fallback = 320;
		const w = this.paneW > 0 ? this.paneW : fallback;
		return Math.round(Math.min(Math.max(w, 220), 400));
	}

	/** Drag the list/detail boundary; committed once on release. */
	private onPaneDrag(offsetX: number): void {
		const next = Math.round(Math.min(Math.max(this.paneDragFrom + offsetX, 220), 400));
		if (next !== this.paneW) {
			this.paneW = next;
		}
	}

	private commitPaneW(): void {
		PrefsStore.set('settingsPaneWidth', `${this.paneW}`);
	}

	/** Wide-mode level-one list: every section as a flat row, the chosen one
	 *  tinted. This is the "一级 tab" the platform settings language expects —
	 *  the grouped hub is only for the phone drill-in. */
	@Builder
	sectionList() {
		Scroll() {
			Column({ space: 2 }) {
				this.navRow('外', $r('app.string.settings_appearance'), $r('app.string.settings_appearance_sub'),
					this.themeValue(), 'appearance', false)
				this.navRow('语', $r('app.string.settings_language'), $r('app.string.settings_language_sub'),
					this.localeValue(), 'language', false)
				this.materialNavRow('tabbar', false)
				this.navRow('通', $r('app.string.settings_notifications'), $r('app.string.settings_notifications_sub'),
					this.notificationsValue(), 'notifications', false)
				this.navRow('声', $r('app.string.settings_voice'), $r('app.string.settings_voice_sub'),
					this.voiceValue(), 'voice', false)
				this.navRow('电', $r('app.string.settings_computers'), $r('app.string.settings_computers_sub'),
					this.sessionsValue(), 'computers', false)
				this.navRow('帮', $r('app.string.settings_diagnostics'), $r('app.string.settings_copy_diagnostics'),
					'', 'diagnostics', false)
				this.navRow('关', $r('app.string.settings_about'), $r('app.string.settings_version'),
					this.version === '' ? '—' : `v${this.version}`, 'about', false)
				this.navRow('存', $r('app.string.settings_storage'), $r('app.string.settings_storage_sub'),
					this.formatBytes(this.cacheBytes), 'storage', true)
			}
			.width('100%')
			.padding({ left: 8, right: 8, top: 4, bottom: 24 })
		}
		.layoutWeight(1)
		.scrollBar(BarState.Off)
		.align(Alignment.Top)
	}

	@Builder
	diagnosticsPage() {
		Scroll() {
			Column({ space: 16 }) {
				Column() {
					Column() {
						Row() {
							Text($r('app.string.settings_copy_diagnostics'))
								.fontSize(16)
								.fontWeight(FontWeight.Medium)
								.fontColor(this.textPrimary())
								.layoutWeight(1)
							Text('›')
								.fontSize(20)
								.fontColor(this.textSecondary())
								.margin({ bottom: 2 })
						}
						.width('100%')
						.height(58)
						.padding({ left: 16, right: 12 })
						.alignItems(VerticalAlign.Center)
						.stateStyles({
							pressed: { .backgroundColor(this.tint(this.themeDark ? 0.26 : 0.20)) },
						})
						.onClick(() => this.copyDiagnostics())
						.accessibilityGroup(true)
					}
					.width('100%')
				}
				.width('100%')
				.borderRadius(18)
				.backgroundColor(this.apiLevel() < 26 ? this.cardBg() : Color.Transparent)
				.systemMaterial(this.surfaceMaterial())
			}
			.padding({ left: 16, right: 16, top: 4, bottom: 32 })
		}
		.layoutWeight(1)
		.scrollBar(BarState.Off)
		.align(Alignment.Top)
		.transition(TransitionEffect.OPACITY
			.combine(TransitionEffect.translate({ x: 28 }))
			.animation({ duration: 240, curve: Curve.FastOutSlowIn }))
	}

	@Builder
	aboutPage() {
		Scroll() {
			Column() {
				Column() {
					this.infoRow($r('app.string.settings_version'), this.version === '' ? '—' : `v${this.version}`, false)
					this.infoRow($r('app.string.settings_system_version'), `API ${deviceInfo.sdkApiVersion}`, true)
				}
				.width('100%')
				.borderRadius(18)
				.backgroundColor(this.apiLevel() < 26 ? this.cardBg() : Color.Transparent)
				.systemMaterial(this.surfaceMaterial())
			}
			.padding({ left: 16, right: 16, top: 4, bottom: 32 })
		}
		.layoutWeight(1)
		.scrollBar(BarState.Off)
		.align(Alignment.Top)
		.transition(TransitionEffect.OPACITY
			.combine(TransitionEffect.translate({ x: 28 }))
			.animation({ duration: 240, curve: Curve.FastOutSlowIn }))
	}

	@Builder
	computersPage() {
		Scroll() {
			Column({ space: 16 }) {
				Column({ space: 2 }) {
					Text(this.sessionsValue())
						.fontSize(16)
						.fontWeight(FontWeight.Medium)
						.fontColor(this.textPrimary())
					Text($r('app.string.settings_computers_sub'))
						.fontSize(12)
						.fontColor(this.textSecondary())
				}
				.width('100%')
				.padding(16)
				.borderRadius(18)
				.backgroundColor(this.apiLevel() < 26 ? this.cardBg() : Color.Transparent)

				.systemMaterial(this.surfaceMaterial())
				.alignItems(HorizontalAlign.Start)

				Column() {
					Row() {
						Column({ space: 2 }) {
							Text($r('app.string.settings_sessions_open'))
								.fontSize(16)
								.fontWeight(FontWeight.Medium)
								.fontColor(this.textPrimary())
								.maxLines(1)
							Text(this.sessionsValue())
								.fontSize(12)
								.fontColor(this.textSecondary())
								.maxLines(1)
						}
						.alignItems(HorizontalAlign.Start)
						.layoutWeight(1)
						Text('›')
							.fontSize(20)
							.fontColor(this.textSecondary())
							.margin({ bottom: 2 })
					}
					.width('100%')
					.height(64)
					.padding({ left: 16, right: 12 })
					.alignItems(VerticalAlign.Center)
					.stateStyles({ pressed: { .backgroundColor(this.tint(this.themeDark ? 0.26 : 0.20)) } })
					.onClick(() => this.onOpenSessions())
					.accessibilityGroup(true)

					Divider().strokeWidth(0.5).color(this.hairline()).margin({ left: 16, right: 16 })

					Row() {
						Column({ space: 2 }) {
							Text($r('app.string.settings_connect_other'))
								.fontSize(16)
								.fontWeight(FontWeight.Medium)
								.fontColor(this.textPrimary())
								.maxLines(1)
							Text($r('app.string.settings_computers_sub'))
								.fontSize(12)
								.fontColor(this.textSecondary())
								.maxLines(1)
						}
						.alignItems(HorizontalAlign.Start)
						.layoutWeight(1)
						Text('›')
							.fontSize(20)
							.fontColor(this.textSecondary())
							.margin({ bottom: 2 })
					}
					.width('100%')
					.height(64)
					.padding({ left: 16, right: 12 })
					.alignItems(VerticalAlign.Center)
					.stateStyles({ pressed: { .backgroundColor(this.tint(this.themeDark ? 0.26 : 0.20)) } })
					.onClick(() => {
						// Leaving settings to the connect screen: the page's own
						// saved-computer list and QR entry live there.
						this.open = false;
						this.onGoConnect();
					})
					.accessibilityGroup(true)
				}
				.width('100%')
				.borderRadius(18)
				.backgroundColor(this.apiLevel() < 26 ? this.cardBg() : Color.Transparent)

				.systemMaterial(this.surfaceMaterial())
			}
			.padding({ left: 16, right: 16, top: 4, bottom: 32 })
		}
		.layoutWeight(1)
		.scrollBar(BarState.Off)
		.align(Alignment.Top)
		.transition(TransitionEffect.OPACITY
			.combine(TransitionEffect.translate({ x: 28 }))
			.animation({ duration: 240, curve: Curve.FastOutSlowIn }))
	}

	@Builder
	languagePage() {
		Scroll() {
			Column() {
				Column({ space: 12 }) {
					this.cardHead($r('app.string.settings_language'), '', true)
					this.stops('locale', ['zh-CN', 'en-US'],
						[$r('app.string.language_zh'), $r('app.string.language_en')],
						this.locale,
						(next: string) => {
							this.locale = next;
						})
				}
				.width('100%')
				.padding(16)
				.borderRadius(18)
				.backgroundColor(this.apiLevel() < 26 ? this.cardBg() : Color.Transparent)

				.systemMaterial(this.surfaceMaterial())
			}
			.padding({ left: 16, right: 16, top: 8, bottom: 32 })
		}
		.layoutWeight(1)
		.scrollBar(BarState.Off)
		.align(Alignment.Top)
		.transition(TransitionEffect.OPACITY
			.combine(TransitionEffect.translate({ x: 28 }))
			.animation({ duration: 240, curve: Curve.FastOutSlowIn }))
	}

	@Builder
	tabBarPage() {
		Scroll() {
			Column() {
				Column({ space: 12 }) {
					this.cardHead($r('app.string.settings_material'), $r('app.string.tabbar_hint'), true)
					Row() {
						// The slider runs 0 = REGULAR (精美) … 3 = ULTRA_THIN (极薄),
						// the same ladder the store keeps, so the ends are named for
						// the ends they sit on.
						Text($r('app.string.material_regular'))
							.fontSize(12)
							.fontColor(this.textSecondary())
						Slider({
							value: this.materialStep(),
							min: 0,
							max: 3,
							step: 1,
							style: SliderStyle.OutSet,
						})
							.layoutWeight(1)
							.margin({ left: 12, right: 12 })
							.selectedColor(this.accentColor())
							.blockColor(this.accentColor())
							.trackColor(this.apiLevel() < 26 ? (this.themeDark ? '#33FFFFFF' : '#1F000000') : Color.Transparent)
							.showSteps(true)
							.onChange((value: number, mode: SliderChangeMode) => {
								// Only the two commit modes write: `Moving` fires per frame
								// and flushing preferences there would hit the store on
								// every frame of a drag. A tap on the TRACK reports
								// `Click` alone (no `End`), which is why both are here.
								if (mode !== SliderChangeMode.End && mode !== SliderChangeMode.Click) return;
								const next = `${Math.round(value)}`;
								if (next === this.material) return;
								// State first, store second. `material` is what
								// `materialStep()` binds the thumb to and what
								// `materialValue()` reads for both the caption here and
								// the row summary on the hub page, so a store-only write
								// left the control snapped back to the old step while the
								// preference had already changed underneath it.
								this.material = next;
								this.commit('tabBarMaterial', next);
							})
						Text($r('app.string.material_ultra'))
							.fontSize(12)
							.fontColor(this.textSecondary())
					}
					.width('100%')
					Text(this.materialValue())
						.fontSize(13)
						.fontColor(this.textSecondary())
						.width('100%')
				}
				.width('100%')
				.padding(16)
				.borderRadius(18)
				.backgroundColor(this.apiLevel() < 26 ? this.cardBg() : Color.Transparent)

				.systemMaterial(this.surfaceMaterial())
			}
			.padding({ left: 16, right: 16, top: 8, bottom: 32 })
		}
		.layoutWeight(1)
		.scrollBar(BarState.Off)
		.align(Alignment.Top)
		.transition(TransitionEffect.OPACITY
			.combine(TransitionEffect.translate({ x: 28 }))
			.animation({ duration: 240, curve: Curve.FastOutSlowIn }))
	}

	/**
	 * Slider position of the current material.
	 *
	 * The slider runs on the SAME ladder the store keeps: the stored value IS
	 * the shell's `ImmersiveStyle` index (0 REGULAR / 1 THICK / 2 THIN /
	 * 3 ULTRA_THIN, see `Index.currentMaterial`), and the control reads left to
	 * right from the most detailed to the lightest — the ladder the hint
	 * describes. The two used to differ by one step, so moving the slider
	 * named a material the bar never showed.
	 */
	private materialStep(): number {
		const step = Number(this.material);
		return step >= 0 && step <= 3 ? step : 1;
	}

	@Builder
	notificationsPage() {
		Scroll() {
			Column({ space: 16 }) {
				Column() {
					this.switchRow($r('app.string.notify_allow'), $r('app.string.notify_allow_sub'),
						this.notificationsOn, () => this.setNotificationsOn(!this.notificationsOn), true)
				}
				.width('100%')
				.borderRadius(18)
				.backgroundColor(this.apiLevel() < 26 ? this.cardBg() : Color.Transparent)

				.systemMaterial(this.surfaceMaterial())

				Column() {
					this.switchRow($r('app.string.notify_turn_done'), $r('app.string.notify_turn_done_sub'),
						this.notifyOnFinish, () => this.setTurnDone(!this.notifyOnFinish), false)
					this.switchRow($r('app.string.notify_dnd'), $r('app.string.notify_dnd_sub'),
						this.notifyDnd, () => this.setDnd(!this.notifyDnd), true)
				}
				.width('100%')
				.borderRadius(18)
				.backgroundColor(this.apiLevel() < 26 ? this.cardBg() : Color.Transparent)

				.systemMaterial(this.surfaceMaterial())
			}
			.padding({ left: 16, right: 16, top: 8, bottom: 32 })
		}
		.layoutWeight(1)
		.scrollBar(BarState.Off)
		.align(Alignment.Top)
		.transition(TransitionEffect.OPACITY
			.combine(TransitionEffect.translate({ x: 28 }))
			.animation({ duration: 240, curve: Curve.FastOutSlowIn }))
	}

	/**
	 * Voice preferences only — the page's `VoicePanel` owns speech synthesis and
	 * recognition, and reads these two values through the prefs bridge
	 * (`getPrefs` / `__musepiPref`). Nothing here speaks or listens.
	 */
	@Builder
	voicePage() {
		Scroll() {
			Column({ space: 16 }) {
				Column({ space: 12 }) {
					this.cardHead($r('app.string.voice_style_title'), '', true)
					this.stops('voiceStyle', VOICE_STYLES,
						[$r('app.string.voice_style_default'), $r('app.string.voice_style_concise'),
							$r('app.string.voice_style_warm')],
						this.voiceStyle,
						(next: string) => {
							this.voiceStyle = next;
						})
				}
				.width('100%')
				.padding(16)
				.borderRadius(18)
				.backgroundColor(this.apiLevel() < 26 ? this.cardBg() : Color.Transparent)

				.systemMaterial(this.surfaceMaterial())

				Column({ space: 12 }) {
					this.cardHead($r('app.string.voice_lang_title'), '', true)
					this.stops('voiceLocale', VOICE_LOCALES,
						[$r('app.string.voice_lang_system'), $r('app.string.language_zh'), $r('app.string.language_en')],
						this.voiceLocale,
						(next: string) => {
							this.voiceLocale = next;
						})
				}
				.width('100%')
				.padding(16)
				.borderRadius(18)
				.backgroundColor(this.apiLevel() < 26 ? this.cardBg() : Color.Transparent)

				.systemMaterial(this.surfaceMaterial())
			}
			.padding({ left: 16, right: 16, top: 8, bottom: 32 })
		}
		.layoutWeight(1)
		.scrollBar(BarState.Off)
		.align(Alignment.Top)
		.transition(TransitionEffect.OPACITY
			.combine(TransitionEffect.translate({ x: 28 }))
			.animation({ duration: 240, curve: Curve.FastOutSlowIn }))
	}

	@Builder
	storagePage() {
		Scroll() {
			Column({ space: 16 }) {
				Column() {
					if (this.measuring) {
						// The walk runs on the UI thread and can take a frame or
						// two on a warm cache: the row shows the system spinner
						// instead of the dash that means "nothing measured yet".
						Row() {
							Text($r('app.string.storage_footprint'))
								.fontSize(16)
								.fontWeight(FontWeight.Medium)
								.fontColor(this.textPrimary())
								.layoutWeight(1)
							LoadingProgress()
								.width(22)
								.height(22)
								.color(this.accentColor())
						}
						.width('100%')
						.height(66)
						.padding({ left: 16, right: 16 })
						.alignItems(VerticalAlign.Center)
						.accessibilityText($r('app.string.storage_footprint'))
					} else {
						this.infoRow($r('app.string.storage_footprint'), this.formatBytes(this.cacheBytes), true)
					}
				}
				.width('100%')
				.borderRadius(18)
				.backgroundColor(this.apiLevel() < 26 ? this.cardBg() : Color.Transparent)

				.systemMaterial(this.surfaceMaterial())

				Column() {
					this.dangerRow($r('app.string.storage_clear'), $r('app.string.storage_clear_sub'))
				}
				.width('100%')
				.borderRadius(18)
				.backgroundColor(this.apiLevel() < 26 ? this.cardBg() : Color.Transparent)

				.systemMaterial(this.surfaceMaterial())
			}
			.padding({ left: 16, right: 16, top: 8, bottom: 32 })
		}
		.layoutWeight(1)
		.scrollBar(BarState.Off)
		.align(Alignment.Top)
		.transition(TransitionEffect.OPACITY
			.combine(TransitionEffect.translate({ x: 28 }))
			.animation({ duration: 240, curve: Curve.FastOutSlowIn }))
	}

	/**
	 * Copy the state a support reply needs.
	 *
	 * Everything here is local and non-sensitive (version, API level, the
	 * preference values); it is the first thing a bug report asks for and the
	 * one thing a phone cannot easily produce by hand.
	 */
	private copyDiagnostics(): void {
		const payload: DiagnosticsPayload = {
			app: 'MusePi',
			version: this.version,
			api: `${deviceInfo.sdkApiVersion}`,
			device: `${deviceInfo.productModel}`,
			theme: this.theme,
			accent: this.accent,
			fontScale: this.fontScale,
			locale: this.locale,
			tabBarMaterial: this.material,
			wide: this.wide ? 'true' : 'false',
		};
		try {
			const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, JSON.stringify(payload, null, 2));
			pasteboard.getSystemPasteboard().setDataSync(data);
			this.getUIContext().getPromptAction().showToast({ message: $r('app.string.settings_copied'), duration: 1500 });
		} catch (e) {
			hilog.warn(DOMAIN, TAG, 'copy diagnostics failed: %{public}s', JSON.stringify(e));
		}
	}

	@Builder
	hubPage() {
		Scroll() {
			Column({ space: 26 }) {
				Column() {
					this.section($r('app.string.settings_group_general'))
					Column() {
						this.navRow('外', $r('app.string.settings_appearance'), $r('app.string.settings_appearance_sub'), this.themeValue(), 'appearance', false)
						this.navRow('语', $r('app.string.settings_language'), $r('app.string.settings_language_sub'), this.localeValue(), 'language', false)
						this.materialNavRow('tabbar', true)
					}
					.width('100%')
					.borderRadius(18)
					.backgroundColor(this.apiLevel() < 26 ? this.cardBg() : Color.Transparent)

					.systemMaterial(this.surfaceMaterial())
				}
				.width('100%')

				Column() {
					this.section($r('app.string.settings_group_reach'))
					Column() {
						this.navRow('通', $r('app.string.settings_notifications'), $r('app.string.settings_notifications_sub'),
							this.notificationsValue(), 'notifications', false)
						this.navRow('声', $r('app.string.settings_voice'), $r('app.string.settings_voice_sub'),
							this.voiceValue(), 'voice', true)
					}
					.width('100%')
					.borderRadius(18)
					.backgroundColor(this.apiLevel() < 26 ? this.cardBg() : Color.Transparent)

					.systemMaterial(this.surfaceMaterial())
				}
				.width('100%')

				Column() {
					this.section($r('app.string.settings_computers'))
					Column() {
						this.navRow('电', $r('app.string.settings_computers'), $r('app.string.settings_computers_sub'),
							this.sessionsValue(), 'computers', true)
					}
					.width('100%')
					.borderRadius(18)
					.backgroundColor(this.apiLevel() < 26 ? this.cardBg() : Color.Transparent)

					.systemMaterial(this.surfaceMaterial())
				}
				.width('100%')

				Column() {
					this.section($r('app.string.settings_diagnostics'))
					Column() {
						Column() {
							Row() {
								Text($r('app.string.settings_copy_diagnostics'))
									.fontSize(16)
									.fontWeight(FontWeight.Medium)
									.fontColor(this.textPrimary())
									.layoutWeight(1)
								Text('›')
									.fontSize(20)
									.fontColor(this.textSecondary())
									.margin({ bottom: 2 })
							}
							.width('100%')
							.height(58)
							.padding({ left: 16, right: 12 })
							.alignItems(VerticalAlign.Center)
							.stateStyles({
								pressed: { .backgroundColor(this.tint(this.themeDark ? 0.26 : 0.20)) },
							})
							.onClick(() => this.copyDiagnostics())
							.accessibilityGroup(true)
							.accessibilityText($r('app.string.settings_copy_diagnostics'))
						}
						.width('100%')
					}
					.width('100%')
					.borderRadius(18)
					.backgroundColor(this.apiLevel() < 26 ? this.cardBg() : Color.Transparent)

					.systemMaterial(this.surfaceMaterial())
				}
				.width('100%')

				Column() {
					this.section($r('app.string.settings_about'))
					Column() {
						this.infoRow($r('app.string.settings_version'), this.version === '' ? '—' : this.version, false)
						this.infoRow($r('app.string.settings_system_version'), `API ${deviceInfo.sdkApiVersion}`, true)
					}
					.width('100%')
					.borderRadius(18)
					.backgroundColor(this.apiLevel() < 26 ? this.cardBg() : Color.Transparent)

					.systemMaterial(this.surfaceMaterial())
				}
				.width('100%')

				Column() {
					this.section($r('app.string.settings_storage'))
					Column() {
						this.navRow('存', $r('app.string.settings_storage'), $r('app.string.settings_storage_sub'),
							this.formatBytes(this.cacheBytes), 'storage', true)
					}
					.width('100%')
					.borderRadius(18)
					.backgroundColor(this.apiLevel() < 26 ? this.cardBg() : Color.Transparent)

					.systemMaterial(this.surfaceMaterial())
				}
				.width('100%')
			}
			.padding({ left: 16, right: 16, top: 4, bottom: 32 })
		}
		.layoutWeight(1)
		.scrollBar(BarState.Off)
		.align(Alignment.Top)
		.transition(TransitionEffect.OPACITY
			.combine(TransitionEffect.translate({ x: 28 }))
			.animation({ duration: 240, curve: Curve.FastOutSlowIn }))
	}

	private sessionsValue(): ResourceStr {
		return this.sessionCount > 0
			? $r('app.string.settings_sessions_count', this.sessionCount)
			: $r('app.string.settings_not_connected');
	}

	private themeValue(): ResourceStr {
		if (this.theme === 'light') {
			return $r('app.string.theme_light');
		}
		if (this.theme === 'dark') {
			return $r('app.string.theme_dark');
		}
		return $r('app.string.theme_system');
	}

	private localeValue(): ResourceStr {
		return this.locale.startsWith('zh') ? $r('app.string.language_zh') : $r('app.string.language_en');
	}

	/**
	 * The material name for a stored index.
	 *
	 * The stored value IS the `uiMaterial.ImmersiveStyle` index the shell uses
	 * (0 REGULAR / 1 THICK / 2 THIN / 3 ULTRA_THIN — see `Index.currentMaterial`),
	 * so the names line up with that ladder directly: 0 精美, 1 均衡, 2 轻柔,
	 * 3 极薄. The mapping used to shift the whole ladder by one, which put the
	 * name one step away from the material the bar actually showed.
	 */
	private materialValue(): ResourceStr {
		if (this.material === '0') {
			return $r('app.string.material_regular');
		}
		if (this.material === '1') {
			return $r('app.string.material_balanced');
		}
		if (this.material === '2') {
			return $r('app.string.material_thin');
		}
		if (this.material === '3') {
			return $r('app.string.material_ultra');
		}
		return $r('app.string.material_balanced');
	}

	/** The master switch is the system grant, so "off" here means the OS blocks
	 *  notifications — not that a local toggle was flipped. */
	private notificationsValue(): ResourceStr {
		if (!this.notificationsOn) {
			return $r('app.string.notify_state_off');
		}
		return this.notifyDnd ? $r('app.string.notify_state_dnd') : $r('app.string.notify_state_on');
	}

	private voiceValue(): ResourceStr {
		if (this.voiceStyle === 'concise') {
			return $r('app.string.voice_style_concise');
		}
		if (this.voiceStyle === 'warm') {
			return $r('app.string.voice_style_warm');
		}
		return $r('app.string.voice_style_default');
	}

	/** The controls of the open section — the second column when docked. */
	@Builder
	detailBody() {
		if (this.page === 'appearance') {
			this.appearancePage()
		} else if (this.page === 'language') {
			this.languagePage()
		} else if (this.page === 'notifications') {
			this.notificationsPage()
		} else if (this.page === 'voice') {
			this.voicePage()
		} else if (this.page === 'computers') {
			this.computersPage()
		} else if (this.page === 'diagnostics') {
			this.diagnosticsPage()
		} else if (this.page === 'about') {
			this.aboutPage()
		} else if (this.page === 'storage') {
			this.storagePage()
		} else {
			this.tabBarPage()
		}
	}

	build() {
		Column() {
			if (this.wide) {
				// Two panes inside a Stack so the divider is a positioned overlay
				// (the session column's pattern, which is the one that demonstrably
				// drags): a flow child of the Row never received the pan on device,
				// while an absolute strip over the boundary does.
				Stack({ alignContent: Alignment.TopStart }) {
					Row() {
						Column() {
							this.header()
							this.sectionList()
						}
						.width(this.listW())
						.height('100%')

						Column() {
							Row() {
								Text(this.pageTitle())
									.fontSize(22)
									.fontWeight(FontWeight.Bold)
									.fontColor(this.textPrimary())
									.layoutWeight(1)
							}
							.width('100%')
							.height(64)
							.padding({ left: 16, right: 16 })
							.alignItems(VerticalAlign.Center)
							this.detailBody()
						}
						.layoutWeight(1)
						.height('100%')
					}
					.width('100%')
					.height('100%')

					// Divider strip: the same positioned-overlay drag the session
					// column uses — a thin grab target that grows while dragging.
					// Same geometry as the session divider (26 → 44 on drag) so
					// the two panes feel like one mechanism.
					Column() {
						Row()
							.width(3)
							.height(this.paneDragging ? 44 : 26)
							.borderRadius(2)
							.backgroundColor(this.paneDragging
								? this.accentColor()
								: this.hairline())
							.animation({ duration: 180, curve: Curve.FastOutSlowIn })
					}
					.width(22)
					.height('100%')
					.justifyContent(FlexAlign.Center)
					.alignItems(HorizontalAlign.Center)
					.position({ x: this.listW() - 11, y: 0 })
					.backgroundColor(Color.Transparent)
					.accessibilityText($r('app.string.settings_pane_width'))
					.gesture(
						GestureGroup(GestureMode.Exclusive,
							PanGesture({ direction: PanDirection.Horizontal, distance: 1 })
								.onActionStart(() => {
									this.paneDragging = true;
									this.paneDragFrom = this.listW();
								})
								.onActionUpdate((event: GestureEvent) => this.onPaneDrag(event.offsetX))
								.onActionEnd(() => {
									this.paneDragging = false;
									this.commitPaneW();
								})
								.onActionCancel(() => {
									this.paneDragging = false;
								}),
							TapGesture({ count: 2 }).onAction(() => {
								this.paneW = 0;
								this.commitPaneW();
							}),
						),
					)
				}
				.width('100%')
				.layoutWeight(1)
				.height('100%')
			} else {
				this.header()
				// One directional motion: pushing a sub-page slides it in from the
				// trailing edge. Without it the native page snapped between levels
				// while the WebView behind kept animating, which read as two apps.
				if (this.page === 'hub') {
					this.hubPage()
				} else {
					this.detailBody()
				}
			}
		}
		// The shell decides how much width this page gets (full width on a phone,
		// the content column on a wide window) — the page itself only pads for
		// the system bars. `bottomReserve` keeps content clear of the floating
		// pill; the background still paints through the whole box, so the strip
		// under the pill is this page's own surface, not a band of the shell.
		.width('100%')
		.height('100%')
		.padding({ top: this.insetTop, bottom: this.bottomReserve })
		.linearGradient({ angle: 180, colors: this.pageBgGradient() })
		.transition(TransitionEffect.OPACITY.combine(TransitionEffect.translate({ x: 16 })))
	}
}
