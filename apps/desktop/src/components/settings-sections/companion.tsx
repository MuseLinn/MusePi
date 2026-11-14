import { Segmented, type SegmentedOption, SpotlightCard, type TranslationKey, t, tLoose } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import "../../i18n/companion-style";
import {
	artFormatForPackage,
	BUILTIN_SPRITE_PRESETS,
	BUILTIN_VECTOR_ART_ID,
	COMPANION_SCALE_MAX,
	COMPANION_SCALE_MIN,
	type CompanionArtFormat,
	type CompanionPlacement,
	companionArtForId,
	companionArtId,
	companionArtIdForFormat,
	companionEnabled,
	companionPlacement,
	companionScale,
	loadSpritePackages,
	measureSpriteAtlas,
	measureSpriteSheet,
	SPRITE_COLUMNS,
	SPRITE_CONTENT_TARGET_H,
	type SpriteAtlasGeometry,
	type SpriteAtlasState,
	type SpritePackage,
	saveSpritePackages,
	setCompanionArtFormat,
	setCompanionArtId,
	setCompanionScale,
} from "../../lib/companion";
// The card previews (BuiltinCompanionArt's gloss/accessory) still read the
// decor record; the EDITING controls moved to general.tsx CompanionDecorSection.
import { type CompanionDecor, companionDecor } from "../../lib/companion-decor";
import { Icon } from "../../vendor/oc-icons";
import { BuiltinCompanionArt, SpriteSheetArt } from "../CompanionArt";
import { GuiSelect } from "../GuiSelect";
import { Reveal } from "../Reveal";

/** Style picker: the mode gate that decides which creation paths the
 *  appearance section offers. */
const COMPANION_STYLE_SEGMENTS: SegmentedOption<CompanionArtFormat>[] = [
	{ value: "vector", label: tLoose("settings.petStyleVector") },
	{ value: "sprite", label: tLoose("settings.petStyleSprite") },
];

/** Agent companion (伙伴): master switch + display mode
 * (input / floating desktop pet) + appearance (drawing style first — vector
 * orb or spritesheet — then that style's presets and imports). Prefs are
 * renderer-local; the desktop pet window is driven through the Electron
 * bridge (pet-mode IPC). */
interface CompanionGridEntry {
	id: string;
	name: string;
	description: string;
	mode: CompanionArtFormat;
	src: string;
	width: number;
	height: number;
	format?: "sheet" | "atlas" | "svg";
	rows?: readonly number[];
	atlas?: SpriteAtlasGeometry;
	states?: Readonly<Record<string, SpriteAtlasState>>;
	contentH?: number;
	smooth?: boolean;
	/** Code-owned renderer instead of a spritesheet — `src`/`width`/`height`
	 *  are unused for these entries. */
	renderer?: "note";
	source: "preset" | "user";
}

type ImportedSpritePackage = Omit<SpritePackage, "width" | "height" | "rows" | "contentH" | "importedAt"> & {
	width?: number;
	height?: number;
	rows?: readonly number[];
	contentH?: number;
};

function completeSpritePackage(raw: ImportedSpritePackage, img: HTMLImageElement): SpritePackage | null {
	const width = img.naturalWidth;
	const height = img.naturalHeight;
	if (!width || !height) return null;
	const description = typeof raw.description === "string" && raw.description.trim() ? raw.description : undefined;
	if (raw.format === "atlas") {
		if (
			!raw.atlas ||
			!raw.states ||
			raw.atlas.frameWidth * raw.atlas.columns !== width ||
			raw.atlas.frameHeight * raw.atlas.rows !== height
		) {
			return null;
		}
		return {
			...raw,
			description,
			width,
			height,
			contentH: measureSpriteAtlas(img, raw.atlas).contentH,
			importedAt: Date.now(),
		};
	}
	const { rows, contentH } = measureSpriteSheet(img);
	return { ...raw, description, width, height, rows, contentH, importedAt: Date.now() };
}

/** One selectable companion card in the appearance grid: rest-frame
 *  thumbnail, name, truncated description; selected card gets the accent
 *  ring + check. Imported cards get a hover delete button (the delete lives
 *  on the card; stopPropagation keeps it from selecting). */
export function CompanionCard({
	entry,
	selected,
	onSelect,
	onDelete,
}: {
	entry: CompanionGridEntry;
	selected: boolean;
	onSelect(): void;
	onDelete?(): void;
}): ReactNode {
	return (
		<SpotlightCard
			className={`gui-pet-card${selected ? " gui-pet-card--selected" : ""}`}
			spotlightColor="rgba(255, 255, 255, 0.09)"
		>
			<div
				role="radio"
				aria-checked={selected}
				tabIndex={0}
				onClick={onSelect}
				onKeyDown={e => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						onSelect();
					}
				}}
			>
				<span className="gui-pet-card__thumb">
					{entry.mode === "vector" && entry.renderer === "note" ? (
						<BuiltinCompanionArt mood="rest" />
					) : (
						<SpriteSheetArt
							mood="rest"
							src={entry.src}
							width={entry.width}
							height={entry.height}
							format={entry.format}
							rows={entry.rows}
							atlas={entry.atlas}
							states={entry.states}
							contentH={entry.contentH}
							smooth={entry.smooth}
						/>
					)}
				</span>
				<span className="gui-pet-card__body">
					<span className="gui-pet-card__name">
						{entry.name}
						{selected && <Icon name="check" className="gui-pet-card__check" />}
					</span>
					<span className="gui-pet-card__desc">{entry.description}</span>
				</span>
				{onDelete && (
					<button
						type="button"
						className="gui-pet-card__delete"
						aria-label={t("settings.deletePet")}
						title={t("settings.deletePet")}
						onClick={e => {
							e.stopPropagation();
							onDelete();
						}}
					>
						<Icon name="delete-bin" className="h-3.5 w-3.5" />
					</button>
				)}
			</div>
		</SpotlightCard>
	);
}

/** One pet from the petdex.dev search API (main-process trimmed shape). */
interface SpriteCatalogEntry {
	slug: string;
	displayName: string;
	description: string | null;
	spritesheetPath: string;
	zipUrl: string | null;
	soundUrl: string | null;
	featured: boolean;
	kind: string | null;
	vibes: string[];
}

/** Compact preview target width for market cards: the 64px thumb with
 *  8px horizontal padding, so a fully-fitted sprite is exactly 56px wide. */
const SPRITE_MARKET_THUMB_PX = 56;

/** One search result in the embedded petdex market: animated preview
 *  (remote spritesheet measured like a local import) + install button. */
export function CompanionMarketCard({
	entry,
	installed,
	installing,
	onInstall,
}: {
	entry: SpriteCatalogEntry;
	installed: boolean;
	installing: boolean;
	onInstall(): void;
}): ReactNode {
	const [meta, setMeta] = useState<{ width: number; height: number; rows: number[]; contentH: number } | null>(null);
	useEffect(() => {
		let alive = true;
		const img = new Image();
		img.src = entry.spritesheetPath;
		img.onload = () => {
			if (!alive) return;
			try {
				const { rows, contentH } = measureSpriteSheet(img);
				setMeta({ width: img.naturalWidth, height: img.naturalHeight, rows, contentH });
			} catch {
				setMeta(null);
			}
		};
		img.onerror = () => {};
		return () => {
			alive = false;
		};
	}, [entry.spritesheetPath]);
	// SpriteSheetArt normalizes to a 100px-tall body; shrink it to fit the
	// compact market thumb (frame ratios differ per pack, so scale per pack).
	const fit = meta
		? SPRITE_MARKET_THUMB_PX / ((meta.width / SPRITE_COLUMNS) * (SPRITE_CONTENT_TARGET_H / meta.contentH))
		: 1;
	return (
		<div className="gui-pet-market-card">
			<span className="gui-pet-market-card__thumb">
				{meta ? (
					<SpriteSheetArt
						mood="rest"
						src={entry.spritesheetPath}
						width={meta.width}
						height={meta.height}
						rows={meta.rows}
						contentH={meta.contentH}
						scale={fit}
					/>
				) : (
					<span className="gui-pet-market-card__loading" />
				)}
			</span>
			<span className="gui-pet-market-card__name">{entry.displayName}</span>
			{installed ? (
				<span className="gui-pet-market-card__installed">
					<Icon name="check" className="h-3 w-3" />
					{t("companion.petInstalled")}
				</span>
			) : (
				<button
					type="button"
					className="gui-btn gui-btn--small"
					disabled={installing || !entry.zipUrl}
					onClick={onInstall}
				>
					{installing ? "…" : t("companion.petMarketInstall")}
				</button>
			)}
		</div>
	);
}

/** Embedded petdex.dev market: debounced search (main-process IPC — the
 *  site sends no CORS headers), animated previews, one-click install
 *  (download zip → same unpack path as the local import). */
export function CompanionMarket({
	petdex,
	onInstalled,
}: {
	petdex: SpritePackage[];
	onInstalled(pkg: SpritePackage): void;
}): ReactNode {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<SpriteCatalogEntry[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [installing, setInstalling] = useState<string | null>(null);
	// Petdex catalog search in-flight flag (the search effect + status line
	// both reference it — this state was dropped in a refactor, making the
	// search handler throw on first use).
	const [searching, setSearching] = useState(false);
	const searchRef = useRef(0);
	const runSearch = useCallback(async (q: string): Promise<void> => {
		const bridge = (
			window as unknown as {
				electronAPI?: { searchPetdex?(q: string): Promise<{ pets?: SpriteCatalogEntry[]; error?: string }> };
			}
		).electronAPI;
		if (!bridge?.searchPetdex) return;
		const seq = ++searchRef.current;
		setSearching(true);
		try {
			const res = await bridge.searchPetdex(q);
			if (seq !== searchRef.current) return;
			if (res?.error) {
				setError(res.error);
				setResults(null);
			} else {
				setResults(res?.pets ?? []);
				setError(null);
			}
		} catch (err) {
			if (seq !== searchRef.current) return;
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			if (seq === searchRef.current) setSearching(false);
		}
	}, []);
	// Debounced: instant on clear, 350ms while typing (search endpoint is
	// cheap but a keystroke-per-request fan-out is not).
	useEffect(() => {
		const timer = setTimeout(() => void runSearch(query.trim()), query.trim() ? 350 : 0);
		return () => clearTimeout(timer);
	}, [query, runSearch]);
	const install = async (entry: SpriteCatalogEntry): Promise<void> => {
		const bridge = (
			window as unknown as {
				electronAPI?: {
					installPetdexUrl?(
						zipUrl: string,
					): Promise<(SpritePackage & { width?: number; height?: number }) | { error: string } | null>;
				};
			}
		).electronAPI;
		if (!bridge?.installPetdexUrl || !entry.zipUrl) return;
		setInstalling(entry.slug);
		try {
			const raw = await bridge.installPetdexUrl(entry.zipUrl);
			if (!raw) return;
			if ("error" in raw) {
				setError(raw.error);
				return;
			}
			// Same measure path as the local import: the main process cannot
			// decode image dimensions, and SpriteSheetArt needs the real frame
			// size + per-row valid frame counts (empty padding columns).
			const img = new Image();
			img.src = raw.spritesheet;
			const { promise: decoded, resolve: resolveDecoded } = Promise.withResolvers<void>();
			img.onload = () => resolveDecoded();
			img.onerror = () => resolveDecoded();
			await decoded;
			const pkg = completeSpritePackage(raw, img);
			if (!pkg) {
				setError("invalid spritesheet geometry");
				return;
			}
			onInstalled(pkg);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setInstalling(null);
		}
	};
	return (
		<div className="gui-pet-market">
			<div className="gui-pet-market__head">
				<span className="gui-pet-group-label">{t("companion.petMarket")}</span>
				<input
					type="search"
					className="gui-input gui-pet-market__search"
					value={query}
					onChange={e => setQuery(e.target.value)}
					placeholder={t("companion.petMarketSearchPlaceholder")}
					aria-label={t("companion.petMarket")}
				/>
			</div>
			{error && <div className="gui-pet-market__error">{t("companion.petMarketError", { reason: error })}</div>}
			{searching && !results ? (
				<div className="gui-pet-market__status">{t("companion.petMarketSearching")}</div>
			) : null}
			{results && results.length === 0 && !searching ? (
				<div className="gui-pet-market__status">{t("companion.petMarketEmpty")}</div>
			) : null}
			{results && results.length > 0 && (
				<div className="gui-pet-market__grid">
					{results.map(p => (
						<CompanionMarketCard
							key={p.slug}
							entry={p}
							installed={petdex.some(x => x.id === p.slug)}
							installing={installing === p.slug}
							onInstall={() => void install(p)}
						/>
					))}
				</div>
			)}
		</div>
	);
}

/** Appearance detail (球面光泽 / 配饰) moved to the GENERAL page's agent
 *  avatar area (2026-09-21, user: 「这个小球的定制放到常规Agent头像那里去」) —
 *  it now lives next to the avatar cards that preview the ball. See
 *  general.tsx CompanionDecorSection; this page keeps the pick + size + market
 *  concerns. */
export function CompanionSection(): ReactNode {
	const [enabled, setEnabled] = useState<boolean>(() => companionEnabled());
	const [mode, setMode] = useState<CompanionPlacement>(() => companionPlacement());
	const [selectedArtId, setSelectedPetId] = useState<string>(() => companionArtId());
	const [petdex, setPetdex] = useState<SpritePackage[]>(() => loadSpritePackages());
	const [sizeScale, setSizeScale] = useState<number>(() => companionScale());
	const [decor, setDecor] = useState<CompanionDecor>(() => companionDecor());
	const [dock, setDock] = useState<boolean>(() => localStorage.getItem("musepi-gui-pet-dock") === "1");
	const [importing, setImporting] = useState(false);
	const [importError, setImportError] = useState<string | null>(null);
	const [expanded, setExpanded] = useState(true);
	const commit = (): void => {
		window.dispatchEvent(new CustomEvent("omp-pet-changed"));
	};
	const setPref = (key: "musepi-gui-pet" | "musepi-gui-pet-mode" | "musepi-gui-pet-id", value: string): void => {
		localStorage.setItem(key, value);
		commit();
	};
	const pickPet = (id: string): void => {
		setSelectedPetId(id);
		setCompanionArtId(id);
		commit();
	};
	// Derived from the resolved selection, not tracked separately: picking a
	// pet of the other mode moves the style with it.
	const style = companionArtForId(selectedArtId).mode;
	const pickStyle = (mode: CompanionArtFormat): void => {
		setCompanionArtFormat(mode);
		setSelectedPetId(companionArtId());
		commit();
	};
	const importPetdex = async (): Promise<void> => {
		const electronAPI = (
			window as unknown as {
				electronAPI?: {
					importPetdex?(): Promise<
						(SpritePackage & { width?: number; height?: number }) | { error: string } | null
					>;
				};
			}
		).electronAPI;
		if (!electronAPI?.importPetdex) {
			// Browser/absent bridge — nothing to pick from yet.
			return;
		}
		setImporting(true);
		setImportError(null);
		try {
			const raw = await electronAPI.importPetdex();
			await applyImportedPet(raw);
		} finally {
			setImporting(false);
		}
	};
	const importCodexPet = async (): Promise<void> => {
		const electronAPI = (
			window as unknown as {
				electronAPI?: {
					importCodexPet?(): Promise<
						(SpritePackage & { width?: number; height?: number }) | { error: string } | null
					>;
				};
			}
		).electronAPI;
		if (!electronAPI?.importCodexPet) {
			// Browser/absent bridge — nothing to pick from yet.
			return;
		}
		setImporting(true);
		setImportError(null);
		try {
			const raw = await electronAPI.importCodexPet();
			await applyImportedPet(raw);
		} finally {
			setImporting(false);
		}
	};
	const applyImportedPet = async (
		raw: (SpritePackage & { width?: number; height?: number }) | { error: string } | null,
	): Promise<void> => {
		if (!raw) return;
		if ("error" in raw) {
			console.error("[pet] import failed:", raw.error);
			setImportError(t("settings.petImportFailed"));
			return;
		}
		// The main process cannot decode image dimensions — measure the
		// spritesheet here (SpriteSheetArt needs real frame size + the
		// per-row valid frame counts to skip empty padding columns).
		const img = new Image();
		img.src = raw.spritesheet;
		const { promise: decoded, resolve: resolveDecoded } = Promise.withResolvers<void>();
		img.onload = () => resolveDecoded();
		img.onerror = () => resolveDecoded();
		await decoded;
		const pkg = completeSpritePackage(raw, img);
		if (!pkg) {
			console.error("[pet] invalid spritesheet geometry");
			setImportError(t("settings.petImportFailed"));
			return;
		}
		const next = [...petdex.filter(p => p.id !== pkg.id), pkg];
		saveSpritePackages(next);
		setPetdex(next);
		pickPet(pkg.id);
		setExpanded(true);
	};
	const removePet = (id: string): void => {
		const next = petdex.filter(p => p.id !== id);
		saveSpritePackages(next);
		setPetdex(next);
		if (selectedArtId === id) {
			pickPet(companionArtIdForFormat(style));
		}
	};
	// ── User SVG import (2026-09-20) ────────────────────────────────────
	// A single vector file becomes a one-frame companion: stored as a
	// petdex package with format "svg" (no 8×9 frame grid), so the grid,
	// the trigger, the composer and the desktop pet all render it through
	// the existing SpriteSheetArt path with the mood transform row intact.
	// Renderer-side on purpose — no main-process dialog hop; the file
	// never leaves this window.
	const svgInputRef = useRef<HTMLInputElement | null>(null);
	const importSvgPet = (): void => {
		const input = svgInputRef.current;
		if (!input) return;
		// Reset so picking the same file twice still fires onChange.
		input.value = "";
		input.click();
	};
	const importSvgSize = 512 * 1024;
	const onSvgPicked = async (file: File): Promise<void> => {
		setImporting(true);
		setImportError(null);
		try {
			if (file.size > importSvgSize) {
				console.error("[pet] svg too large:", file.size);
				setImportError(t("settings.petImportFailed"));
				return;
			}
			const text = await file.text();
			if (!/<svg[\s>]/i.test(text)) {
				console.error("[pet] not an svg document");
				setImportError(t("settings.petImportFailed"));
				return;
			}
			const dataUrl = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result));
				reader.onerror = () => reject(new Error("svg-read-failed"));
				reader.readAsDataURL(file);
			});
			// Intrinsic size: the browser resolves width/height/viewBox on
			// decode; an SVG with neither falls back to parsing the viewBox
			// out of the source text (Chromium reports 0×0 for sizeless SVGs).
			const img = new Image();
			img.src = dataUrl;
			const { promise: decoded, resolve: resolveDecoded } = Promise.withResolvers<void>();
			img.onload = () => resolveDecoded();
			img.onerror = () => resolveDecoded();
			await decoded;
			let width = img.naturalWidth;
			let height = img.naturalHeight;
			if (!width || !height) {
				const vb = text.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)["']/i);
				if (vb) {
					width = Number(vb[1]);
					height = Number(vb[2]);
				}
			}
			if (!width || !height) {
				console.error("[pet] svg has no resolvable size");
				setImportError(t("settings.petImportFailed"));
				return;
			}
			const pkg: SpritePackage = {
				id: `svg-${Date.now()}`,
				displayName: file.name.replace(/\.svg$/i, "") || "SVG",
				spritesheet: dataUrl,
				width,
				height,
				format: "svg",
				rows: [1],
				contentH: height,
				smooth: true,
				importedAt: Date.now(),
			};
			const next = [...petdex.filter(p => p.id !== pkg.id), pkg];
			saveSpritePackages(next);
			setPetdex(next);
			pickPet(pkg.id);
			setExpanded(true);
		} finally {
			setImporting(false);
		}
	};
	const isDesktopShell =
		typeof (window as unknown as { electronAPI?: { importPetdex?: unknown } }).electronAPI?.importPetdex ===
		"function";
	// Preset names/descriptions are i18n keys (English source strings,
	// localized via guest-client zh-CN); imported packages keep their own
	// pet.json text.
	// The hand-drawn sphere leads the preset grid (it is the default), then
	// the AI-generated sheet presets.
	const builtinSvgEntry: CompanionGridEntry = {
		id: BUILTIN_VECTOR_ART_ID,
		name: t("settings.builtinPet"),
		description: t("settings.builtinPetDescription"),
		mode: "vector",
		src: "",
		width: 0,
		height: 0,
		renderer: "note",
		source: "preset",
	};
	const presetEntries: CompanionGridEntry[] = [
		builtinSvgEntry,
		...BUILTIN_SPRITE_PRESETS.map(
			(p): CompanionGridEntry => ({
				id: p.id,
				name: t(p.displayName as TranslationKey),
				description: t(p.description as TranslationKey),
				mode: "sprite",
				src: p.spritesheetPath,
				width: p.width,
				height: p.height,
				rows: p.rows,
				contentH: p.contentH,
				smooth: p.smooth,
				source: "preset",
			}),
		),
	];
	const userEntries: CompanionGridEntry[] = petdex.map(p => ({
		id: p.id,
		name: p.displayName,
		description: p.description ?? "",
		mode: artFormatForPackage(p),
		src: p.spritesheet,
		width: p.width,
		height: p.height,
		format: p.format,
		rows: p.rows,
		atlas: p.atlas,
		states: p.states,
		contentH: p.contentH,
		smooth: p.smooth,
		source: "user",
	}));
	const userEntriesForStyle = userEntries.filter(e => e.mode === style);
	const presetEntriesForStyle = presetEntries.filter(e => e.mode === style);
	const allEntries = [...userEntries, ...presetEntries];
	const selectedEntry = allEntries.find(e => e.id === selectedArtId) ?? null;
	return (
		<>
			<h2 className="gui-settings-page-title">{t("settings.agentCompanion")}</h2>
			<p className="gui-settings-page-desc">{t("settings.petSettings")}</p>
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("tools.petDisplay")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("settings.showAgentCompanion")}</div>
						<div className="gui-settings-row-desc">{t("settings.showAgentCompanionDescription")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={enabled}
						className={`gui-toggle${enabled ? " gui-toggle--on" : ""}`}
						onClick={() => {
							const next = !enabled;
							setEnabled(next);
							setPref("musepi-gui-pet", next ? "1" : "0");
						}}
						aria-label={t("settings.showAgentCompanion")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				{enabled && (
					<>
						<div className="gui-settings-row">
							<div>
								<div className="gui-settings-row-label">{t("settings.petSize")}</div>
								<div className="gui-settings-row-desc">{t("settings.petSizeDescription")}</div>
							</div>
							<div className="flex items-center gap-2">
								<input
									type="range"
									min={COMPANION_SCALE_MIN}
									max={COMPANION_SCALE_MAX}
									step={5}
									value={Math.round(sizeScale * 100)}
									className="gui-range"
									onChange={e => {
										const v = Number(e.target.value);
										setSizeScale(v / 100);
										setCompanionScale(v);
										commit();
									}}
									aria-label={t("settings.petSize")}
								/>
								<span className="w-10 text-right text-[12.5px] tabular-nums text-[var(--color-text-muted)]">
									{Math.round(sizeScale * 100)}%
								</span>
							</div>
						</div>
						<div className="gui-settings-row">
							<div>
								<div className="gui-settings-row-label">{t("settings.displayPosition")}</div>
								<div className="gui-settings-row-desc">{t("settings.displayPositionDescription")}</div>
							</div>
							<GuiSelect
								className="gui-input gui-pet-mode-select"
								value={mode}
								onChange={v => {
									const next = v as CompanionPlacement;
									setMode(next);
									setPref("musepi-gui-pet-mode", next);
								}}
								ariaLabel={t("settings.displayPosition")}
								options={[
									{ value: "input", label: t("settings.petDisplayInput") },
									{ value: "desktop", label: t("settings.petDisplayDesktop") },
								]}
							/>
						</div>
						<div className="gui-settings-row">
							<div>
								<div className="gui-settings-row-label">{t("settings.dockScreenEdge")}</div>
								<div className="gui-settings-row-desc">{t("settings.dockScreenEdgeDescription")}</div>
							</div>
							<button
								type="button"
								role="switch"
								aria-checked={dock}
								className={`gui-toggle${dock ? " gui-toggle--on" : ""}`}
								onClick={() => {
									const next = !dock;
									setDock(next);
									localStorage.setItem("musepi-gui-pet-dock", next ? "1" : "0");
									commit();
									const api = (
										window as unknown as { electronAPI?: { setPetDock?(v: boolean): Promise<unknown> } }
									).electronAPI;
									void api?.setPetDock?.(next);
								}}
								aria-label={t("settings.dockScreenEdge")}
							>
								<span className="gui-toggle-knob" />
							</button>
						</div>
					</>
				)}
			</div>
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("tools.petAppearance")}</div>
				{enabled && (
					<>
						<div className="gui-settings-row">
							<div>
								<div className="gui-settings-row-label">{tLoose("settings.petStyle")}</div>
								<div className="gui-settings-row-desc">{tLoose("settings.petStyleDescription")}</div>
							</div>
							<Segmented
								ariaLabel={tLoose("settings.petStyle")}
								value={style}
								options={COMPANION_STYLE_SEGMENTS}
								onChange={mode => pickStyle(mode)}
							/>
						</div>
						{/* Appearance: header row with refresh +
						 * import, a trigger showing the selected pet, and an
						 * expandable preset grid grouped 预设 / 已导入. */}
						<div className="gui-settings-row">
							<div>
								<div className="gui-settings-row-label">{t("settings.companionAppearance")}</div>
								<div className="gui-settings-row-desc">{t("settings.companionAppearanceDescription")}</div>
							</div>
							<div className="flex items-center gap-2">
								<button
									type="button"
									className="gui-btn gui-btn--icon"
									aria-label={t("companion.petRefresh")}
									title={t("companion.petRefresh")}
									onClick={() => {
										setPetdex(loadSpritePackages());
										setSelectedPetId(companionArtId());
									}}
								>
									<Icon name="refresh" className="h-3.5 w-3.5" />
								</button>
								{style === "sprite" && (
									<>
										<button
											type="button"
											className="gui-btn"
											onClick={() => void importPetdex()}
											disabled={importing || !isDesktopShell}
											title={
												isDesktopShell ? t("settings.importPetdex") : t("settings.desktopPetNeedsDesktop")
											}
										>
											<Icon name="add" className="h-3.5 w-3.5" />
											{importing ? "…" : t("settings.importPetdex")}
										</button>
										<button
											type="button"
											className="gui-btn"
											onClick={() => void importCodexPet()}
											disabled={importing || !isDesktopShell}
											title={
												isDesktopShell
													? t("settings.importCodexSprite")
													: t("settings.desktopPetNeedsDesktop")
											}
										>
											<Icon name="download" className="h-3.5 w-3.5" />
											{importing ? "…" : t("settings.importCodexSprite")}
										</button>
									</>
								)}
								{style === "vector" && (
									/* User SVG import — renderer-side file pick, no
									 * desktop-shell gate (a file input works everywhere). */
									<button
										type="button"
										className="gui-btn"
										onClick={importSvgPet}
										disabled={importing}
										title={t("settings.importSvg")}
									>
										<Icon name="file-add" className="h-3.5 w-3.5" />
										{importing ? "…" : t("settings.importSvg")}
									</button>
								)}
								<input
									ref={svgInputRef}
									type="file"
									accept=".svg,image/svg+xml"
									className="hidden"
									aria-hidden="true"
									tabIndex={-1}
									onChange={e => {
										const f = e.target.files?.[0];
										if (f) void onSvgPicked(f);
									}}
								/>
							</div>
							{importError && (
								<p className="gui-pet-import-error" role="alert">
									{importError}
								</p>
							)}
						</div>
						<button
							type="button"
							className="gui-pet-trigger"
							aria-expanded={expanded}
							onClick={() => setExpanded(v => !v)}
						>
							<span className="gui-pet-trigger__thumb">
								{selectedEntry && (selectedEntry.mode !== "vector" || selectedEntry.renderer !== "note") ? (
									<SpriteSheetArt
										mood="rest"
										src={selectedEntry.src}
										width={selectedEntry.width}
										height={selectedEntry.height}
										format={selectedEntry.format}
										rows={selectedEntry.rows}
										atlas={selectedEntry.atlas}
										states={selectedEntry.states}
										contentH={selectedEntry.contentH}
										smooth={selectedEntry.smooth}
									/>
								) : (
									<BuiltinCompanionArt mood="rest" gloss={decor.gloss} accessory={decor.accessory} />
								)}
							</span>
							<span className="gui-pet-trigger__name">{selectedEntry?.name ?? t("settings.builtinPet")}</span>
							<Icon
								name="arrow-down"
								className={`gui-pet-trigger__chevron${expanded ? " gui-pet-trigger__chevron--open" : ""}`}
							/>
						</button>
						<Reveal open={expanded}>
							<div className="gui-pet-grid" role="radiogroup" aria-label={t("settings.companionAppearance")}>
								{userEntriesForStyle.length > 0 && (
									<div className="gui-pet-group-label">{t("settings.petImported")}</div>
								)}
								{userEntriesForStyle.map(entry => (
									<CompanionCard
										key={entry.id}
										entry={entry}
										selected={entry.id === selectedArtId}
										onSelect={() => pickPet(entry.id)}
										onDelete={() => removePet(entry.id)}
									/>
								))}
								{presetEntriesForStyle.length > 0 && (
									<div className="gui-pet-group-label">{t("settings.petPresets")}</div>
								)}
								{presetEntriesForStyle.map(entry => (
									<CompanionCard
										key={entry.id}
										entry={entry}
										selected={entry.id === selectedArtId}
										onSelect={() => pickPet(entry.id)}
									/>
								))}
							</div>
						</Reveal>
						{style === "sprite" && (
							<CompanionMarket
								petdex={petdex}
								onInstalled={pkg => {
									const next = [...petdex.filter(p => p.id !== pkg.id), pkg];
									setPetdex(next);
									saveSpritePackages(next);
									pickPet(pkg.id);
								}}
							/>
						)}
					</>
				)}
			</div>
		</>
	);
}
