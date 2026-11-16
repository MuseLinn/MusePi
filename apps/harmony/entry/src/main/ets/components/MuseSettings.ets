import { deviceInfo, pasteboard } from '@kit.BasicServicesKit';
import { promptAction, UIContext, uiMaterial } from '@kit.ArkUI';
import { bundleManager } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { PREF_KEYS, PrefsStore } from '../common/prefs';

const TAG: string = 'MuseSettings';
const DOMAIN: number = 0x0000;

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

interface SettingRow {
	key: string;
	label: ResourceStr;
	value: ResourceStr;
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

	/** Track of a segmented control: a hair under the cards it lives in. */
	private trackMaterial(): SystemUiMaterial | undefined {
		if (deviceInfo.sdkApiVersion < 26) {
			return undefined;
		}
		return new uiMaterial.ImmersiveMaterial({
			style: uiMaterial.ImmersiveStyle.ULTRA_THIN,
			interactive: false,
			applyShadow: false,
			colorInvert: false,
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
		if (this.page === 'computers') {
			return $r('app.string.settings_computers');
		}
		if (this.page === 'diagnostics') {
			return $r('app.string.settings_diagnostics');
		}
		if (this.page === 'about') {
			return $r('app.string.settings_about');
		}
		return $r('app.string.settings_material');
	}

	/** Section card: the group owns the surface, rows own the hairline. */
	@Builder
	section(title: ResourceStr) {
		Column() {
			Text(title)
				.fontSize(13)
				.fontWeight(FontWeight.Medium)
				.fontColor(this.textSecondary())
				.margin({ left: 4, bottom: 10 })
		}
		.width('100%')
		.alignItems(HorizontalAlign.Start)
	}

	/** A row that opens a page: icon tile left, label + subtitle, current value
	 *  and chevron right. The tile is the section's first character inside an
	 *  accent-tinted block — the reference list language, with no icon assets. */
	@Builder
	navRow(tile: string, label: ResourceStr, subtitle: ResourceStr, value: ResourceStr, target: string, last: boolean) {
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
	 * Sliding segmented control, 44vp tall.
	 *
	 * Built by hand rather than with `Tabs`/`Select`: three to five equal
	 * stops, one tap to change, and the selected stop carries the accent —
	 * the same control language the web settings uses, so a user moving
	 * between platforms is not relearning a widget.
	 */
	@Builder
	segmented(values: string[], labels: ResourceStr[], current: string, onPick: (next: string) => void) {
		Row() {
			ForEach(values, (value: string, index: number) => {
				Text(labels[index])
					.fontSize(13)
					.fontWeight(FontWeight.Medium)
					.maxLines(1)
					.fontColor(current === value ? this.textPrimary() : this.textSecondary())
					.layoutWeight(1)
					.height(38)
					.borderRadius(11)
					.backgroundColor(current === value ? (this.apiLevel() < 26 ? (this.themeDark ? '#3C414C' : '#FFFFFF') : Color.Transparent) : Color.Transparent)

					.systemMaterial(current === value ? this.accentMaterial() : undefined)
					.textAlign(TextAlign.Center)
					.stateStyles({
						pressed: { .opacity(0.55) },
					})
					.onClick(() => onPick(value))
			}, (value: string) => value)
		}
		.width('100%')
		.padding(3)
		.borderRadius(14)
		.backgroundColor(this.apiLevel() < 26 ? (this.themeDark ? '#1FFFFFFF' : '#0A000000') : Color.Transparent)

		.systemMaterial(this.trackMaterial())
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
					this.segmented(['system', 'light', 'dark'],
						[$r('app.string.theme_system'), $r('app.string.theme_light'), $r('app.string.theme_dark')],
						this.theme,
						(next: string) => this.pick('theme', next, () => {
							this.theme = next;
						}))
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
					this.segmented(['13', '15', '17'],
						[$r('app.string.font_small'), $r('app.string.font_default'), $r('app.string.font_large')],
						this.fontScale,
						(next: string) => this.pick('fontScale', next, () => {
							this.fontScale = next;
						}))
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
				this.navRow('材', $r('app.string.settings_material'), $r('app.string.settings_material_sub'),
					this.materialValue(), 'tabbar', false)
				this.navRow('电', $r('app.string.settings_computers'), $r('app.string.settings_computers_sub'),
					this.sessionsValue(), 'computers', false)
				this.navRow('帮', $r('app.string.settings_diagnostics'), $r('app.string.settings_copy_diagnostics'),
					'', 'diagnostics', false)
				this.navRow('关', $r('app.string.settings_about'), $r('app.string.settings_version'),
					this.version === '' ? '—' : `v${this.version}`, 'about', true)
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
					this.segmented(['zh-CN', 'en-US'],
						[$r('app.string.language_zh'), $r('app.string.language_en')],
						this.locale,
						(next: string) => this.pick('locale', next, () => {
							this.locale = next;
						}))
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
					this.cardHead($r('app.string.settings_material'), $r('app.string.tabbar_hint'), false)
					this.segmented(['1', '0', '2', '3'],
						[$r('app.string.material_regular'), $r('app.string.material_balanced'),
							$r('app.string.material_thin'), $r('app.string.material_ultra')],
						this.material,
						(next: string) => this.pick('tabBarMaterial', next, () => {
							this.material = next;
						}))
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
					this.section($r('app.string.settings_group_general'))
					Column() {
						this.navRow('外', $r('app.string.settings_appearance'), $r('app.string.settings_appearance_sub'), this.themeValue(), 'appearance', false)
						this.navRow('语', $r('app.string.settings_language'), $r('app.string.settings_language_sub'), this.localeValue(), 'language', false)
						this.navRow('材', $r('app.string.settings_material'), $r('app.string.settings_material_sub'), this.materialValue(), 'tabbar', true)
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

	private materialValue(): ResourceStr {
		if (this.material === '1') {
			return $r('app.string.material_regular');
		}
		if (this.material === '2') {
			return $r('app.string.material_thin');
		}
		if (this.material === '3') {
			return $r('app.string.material_ultra');
		}
		return $r('app.string.material_balanced');
	}

	/** The controls of the open section — the second column when docked. */
	@Builder
	detailBody() {
		if (this.page === 'appearance') {
			this.appearancePage()
		} else if (this.page === 'language') {
			this.languagePage()
		} else if (this.page === 'computers') {
			this.computersPage()
		} else if (this.page === 'diagnostics') {
			this.diagnosticsPage()
		} else if (this.page === 'about') {
			this.aboutPage()
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
