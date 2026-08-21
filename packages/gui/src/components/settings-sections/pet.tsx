import {
	type TranslationKey,
	t,
} from "@musepi/desktop-web";
import {
	GuiSelect,
} from "../GuiSelect";
import type {
	ReactNode,
} from "react";
import {
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	BUILTIN_PETDEX,
	DEFAULT_PET_ID,
	loadPetdex,
	measurePetdex,
	PET_CONTENT_TARGET_H,
	PET_SCALE_MAX,
	PET_SCALE_MIN,
	PETDEX_COLUMNS,
	type PetDisplayMode,
	type PetdexPackage,
	petEnabled,
	petId,
	petMode,
	petScale,
	savePetdex,
	setPetScale,
} from "../../lib/pet";
import {
	Icon,
} from "../../vendor/oc-icons";
import {
	BuiltinPetSprite,
	PetdexSprite,
} from "../PetSprite";
import {
	Reveal,
} from "../Reveal";
import {
	SpotlightCard,
} from "../SpotlightCard";

/** Agent companion (伙伴, BitFun parity): master switch + display mode
 * (input / floating desktop pet) + appearance (preset grid or imported
 * Petdex package). Prefs are renderer-local; the desktop pet window is
 * driven through the Electron bridge (pet-mode IPC). */
interface PetGridEntry {
	id: string;
	name: string;
	description: string;
	src: string;
	width: number;
	height: number;
	rows?: readonly number[];
	contentH?: number;
	source: "preset" | "user";
}

/** One selectable companion card in the appearance grid: rest-frame
 *  thumbnail, name, truncated description; selected card gets the accent
 *  ring + check. Imported cards get a hover delete button (BitFun parity:
 *  the delete lives on the card, stopPropagation keeps it from selecting). */
export function PetCard({
	entry,
	selected,
	onSelect,
	onDelete,
}: {
	entry: PetGridEntry;
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
					<PetdexSprite
						mood="rest"
						src={entry.src}
						width={entry.width}
						height={entry.height}
						rows={entry.rows}
						contentH={entry.contentH}
					/>
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
						aria-label={t("delete pet")}
						title={t("delete pet")}
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
interface PetdexCatalogEntry {
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
const PET_MARKET_THUMB_PX = 56;

/** One search result in the embedded petdex market: animated preview
 *  (remote spritesheet measured like a local import) + install button. */
export function PetMarketCard({
	pet,
	installed,
	installing,
	onInstall,
}: {
	pet: PetdexCatalogEntry;
	installed: boolean;
	installing: boolean;
	onInstall(): void;
}): ReactNode {
	const [meta, setMeta] = useState<{ width: number; height: number; rows: number[]; contentH: number } | null>(null);
	useEffect(() => {
		let alive = true;
		const img = new Image();
		img.src = pet.spritesheetPath;
		img.onload = () => {
			if (!alive) return;
			try {
				const { rows, contentH } = measurePetdex(img);
				setMeta({ width: img.naturalWidth, height: img.naturalHeight, rows, contentH });
			} catch {
				setMeta(null);
			}
		};
		img.onerror = () => {};
		return () => {
			alive = false;
		};
	}, [pet.spritesheetPath]);
	// PetdexSprite normalizes to a 100px-tall body; shrink it to fit the
	// compact market thumb (frame ratios differ per pack, so scale per pack).
	const fit = meta
		? PET_MARKET_THUMB_PX / ((meta.width / PETDEX_COLUMNS) * (PET_CONTENT_TARGET_H / meta.contentH))
		: 1;
	return (
		<div className="gui-pet-market-card">
			<span className="gui-pet-market-card__thumb">
				{meta ? (
					<PetdexSprite
						mood="rest"
						src={pet.spritesheetPath}
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
			<span className="gui-pet-market-card__name">{pet.displayName}</span>
			{installed ? (
				<span className="gui-pet-market-card__installed">
					<Icon name="check" className="h-3 w-3" />
					{t("pet installed")}
				</span>
			) : (
				<button
					type="button"
					className="gui-btn gui-btn--small"
					disabled={installing || !pet.zipUrl}
					onClick={onInstall}
				>
					{installing ? "…" : t("pet market install")}
				</button>
			)}
		</div>
	);
}

/** Embedded petdex.dev market: debounced search (main-process IPC — the
 *  site sends no CORS headers), animated previews, one-click install
 *  (download zip → same unpack path as the local import). */
export function PetMarket({
	petdex,
	onInstalled,
}: {
	petdex: PetdexPackage[];
	onInstalled(pkg: PetdexPackage): void;
}): ReactNode {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<PetdexCatalogEntry[] | null>(null);
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
				electronAPI?: { searchPetdex?(q: string): Promise<{ pets?: PetdexCatalogEntry[]; error?: string }> };
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
	const install = async (pet: PetdexCatalogEntry): Promise<void> => {
		const bridge = (
			window as unknown as {
				electronAPI?: {
					installPetdexUrl?(
						zipUrl: string,
					): Promise<(PetdexPackage & { width?: number; height?: number }) | { error: string } | null>;
				};
			}
		).electronAPI;
		if (!bridge?.installPetdexUrl || !pet.zipUrl) return;
		setInstalling(pet.slug);
		try {
			const raw = await bridge.installPetdexUrl(pet.zipUrl);
			if (!raw) return;
			if ("error" in raw) {
				setError(raw.error);
				return;
			}
			// Same measure path as the local import: the main process cannot
			// decode image dimensions, and PetdexSprite needs the real frame
			// size + per-row valid frame counts (empty padding columns).
			const img = new Image();
			img.src = raw.spritesheet;
			const { promise: decoded, resolve: resolveDecoded } = Promise.withResolvers<void>();
			img.onload = () => resolveDecoded();
			img.onerror = () => resolveDecoded();
			await decoded;
			if (!img.naturalWidth || !img.naturalHeight) {
				setError("undecodable spritesheet");
				return;
			}
			const { rows, contentH } = measurePetdex(img);
			onInstalled({
				id: raw.id,
				displayName: raw.displayName,
				description: typeof raw.description === "string" && raw.description ? raw.description : undefined,
				spritesheet: raw.spritesheet,
				width: img.naturalWidth,
				height: img.naturalHeight,
				rows,
				contentH,
				importedAt: Date.now(),
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setInstalling(null);
		}
	};
	return (
		<div className="gui-pet-market">
			<div className="gui-pet-market__head">
				<span className="gui-pet-group-label">{t("pet market")}</span>
				<input
					type="search"
					className="gui-input gui-pet-market__search"
					value={query}
					onChange={e => setQuery(e.target.value)}
					placeholder={t("pet market search placeholder")}
					aria-label={t("pet market")}
				/>
			</div>
			{error && <div className="gui-pet-market__error">{t("pet market error", { reason: error })}</div>}
			{searching && !results ? <div className="gui-pet-market__status">{t("pet market searching")}</div> : null}
			{results && results.length === 0 && !searching ? (
				<div className="gui-pet-market__status">{t("pet market empty")}</div>
			) : null}
			{results && results.length > 0 && (
				<div className="gui-pet-market__grid">
					{results.map(p => (
						<PetMarketCard
							key={p.slug}
							pet={p}
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

export function PetSection(): ReactNode {
	const [enabled, setEnabled] = useState<boolean>(() => petEnabled());
	const [mode, setMode] = useState<PetDisplayMode>(() => petMode());
	const [selectedPetId, setSelectedPetId] = useState<string>(() => petId());
	const [petdex, setPetdex] = useState<PetdexPackage[]>(() => loadPetdex());
	const [sizeScale, setSizeScale] = useState<number>(() => petScale());
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
		setPref("musepi-gui-pet-id", id);
	};
	const importPetdex = async (): Promise<void> => {
		const electronAPI = (
			window as unknown as {
				electronAPI?: {
					importPetdex?(): Promise<
						(PetdexPackage & { width?: number; height?: number }) | { error: string } | null
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
						(PetdexPackage & { width?: number; height?: number }) | { error: string } | null
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
		raw: (PetdexPackage & { width?: number; height?: number }) | { error: string } | null,
	): Promise<void> => {
		if (!raw) return;
		if ("error" in raw) {
			console.error("[pet] import failed:", raw.error);
			setImportError(t("pet import failed"));
			return;
		}
		// The main process cannot decode image dimensions — measure the
		// spritesheet here (PetdexSprite needs real frame size + the
		// per-row valid frame counts to skip empty padding columns).
		const img = new Image();
		img.src = raw.spritesheet;
		const { promise: decoded, resolve: resolveDecoded } = Promise.withResolvers<void>();
		img.onload = () => resolveDecoded();
		img.onerror = () => resolveDecoded();
		await decoded;
		if (!img.naturalWidth || !img.naturalHeight) {
			console.error("[pet] spritesheet undecodable");
			setImportError(t("pet import failed"));
			return;
		}
		const { rows, contentH } = measurePetdex(img);
		const pkg: PetdexPackage = {
			id: raw.id,
			displayName: raw.displayName,
			description: typeof raw.description === "string" && raw.description ? raw.description : undefined,
			spritesheet: raw.spritesheet,
			width: img.naturalWidth,
			height: img.naturalHeight,
			rows,
			contentH,
			importedAt: Date.now(),
		};
		const next = [...petdex.filter(p => p.id !== pkg.id), pkg];
		savePetdex(next);
		setPetdex(next);
		pickPet(pkg.id);
		setExpanded(true);
	};
	const removePet = (id: string): void => {
		const next = petdex.filter(p => p.id !== id);
		savePetdex(next);
		setPetdex(next);
		if (selectedPetId === id) {
			pickPet(DEFAULT_PET_ID);
		}
	};
	const isDesktopShell =
		typeof (window as unknown as { electronAPI?: { importPetdex?: unknown } }).electronAPI?.importPetdex ===
		"function";
	// Preset names/descriptions are i18n keys (English source strings,
	// localized via desktop-web zh-CN); imported packages keep their own
	// pet.json text.
	const presetEntries: PetGridEntry[] = BUILTIN_PETDEX.map(p => ({
		id: p.id,
		name: t(p.displayName as TranslationKey),
		description: t(p.description as TranslationKey),
		src: p.spritesheetPath,
		width: p.width,
		height: p.height,
		rows: p.rows,
		contentH: p.contentH,
		source: "preset",
	}));
	const userEntries: PetGridEntry[] = petdex.map(p => ({
		id: p.id,
		name: p.displayName,
		description: p.description ?? "",
		src: p.spritesheet,
		width: p.width,
		height: p.height,
		rows: p.rows,
		contentH: p.contentH,
		source: "user",
	}));
	const allEntries = [...userEntries, ...presetEntries];
	const selectedEntry = allEntries.find(e => e.id === selectedPetId) ?? null;
	return (
		<>
			<h2 className="gui-settings-page-title">{t("agent companion")}</h2>
			<p className="gui-settings-page-desc">{t("pet settings")}</p>
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("pet display")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("show agent companion")}</div>
						<div className="gui-settings-row-desc">{t("show agent companion description")}</div>
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
						aria-label={t("show agent companion")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				{enabled && (
					<>
						<div className="gui-settings-row">
							<div>
								<div className="gui-settings-row-label">{t("pet size")}</div>
								<div className="gui-settings-row-desc">{t("pet size description")}</div>
							</div>
							<div className="flex items-center gap-2">
								<input
									type="range"
									min={PET_SCALE_MIN}
									max={PET_SCALE_MAX}
									step={5}
									value={Math.round(sizeScale * 100)}
									className="gui-range"
									onChange={e => {
										const v = Number(e.target.value);
										setSizeScale(v / 100);
										setPetScale(v);
										commit();
									}}
									aria-label={t("pet size")}
								/>
								<span className="w-10 text-right text-[12.5px] tabular-nums text-[var(--color-text-muted)]">
									{Math.round(sizeScale * 100)}%
								</span>
							</div>
						</div>
						<div className="gui-settings-row">
							<div>
								<div className="gui-settings-row-label">{t("display position")}</div>
								<div className="gui-settings-row-desc">{t("display position description")}</div>
							</div>
							<GuiSelect
					className="gui-input gui-pet-mode-select"
					value={mode}
					onChange={v => {
									const next = v as PetDisplayMode;
									setMode(next);
									setPref("musepi-gui-pet-mode", next);
								}}
					ariaLabel={t("display position")}
					options={[{ value: "input", label: t("pet display input") }, { value: "desktop", label: t("pet display desktop") }]}
				/>
						</div>
						<div className="gui-settings-row">
							<div>
								<div className="gui-settings-row-label">{t("dock to screen edge")}</div>
								<div className="gui-settings-row-desc">{t("dock to screen edge description")}</div>
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
								aria-label={t("dock to screen edge")}
							>
								<span className="gui-toggle-knob" />
							</button>
						</div>
					</>
				)}
			</div>
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("pet appearance")}</div>
				{enabled && (
					<>
						{/* Appearance (BitFun parity): header row with refresh +
						 * import, a trigger showing the selected pet, and an
						 * expandable preset grid grouped 预设 / 已导入. */}
						<div className="gui-settings-row">
							<div>
								<div className="gui-settings-row-label">{t("companion appearance")}</div>
								<div className="gui-settings-row-desc">{t("companion appearance description")}</div>
							</div>
							<div className="flex items-center gap-2">
								<button
									type="button"
									className="gui-btn gui-btn--icon"
									aria-label={t("pet refresh")}
									title={t("pet refresh")}
									onClick={() => {
										setPetdex(loadPetdex());
										setSelectedPetId(petId());
									}}
								>
									<Icon name="refresh" className="h-3.5 w-3.5" />
								</button>
								<button
									type="button"
									className="gui-btn"
									onClick={() => void importPetdex()}
									disabled={importing || !isDesktopShell}
									title={isDesktopShell ? t("import petdex") : t("desktop pet needs desktop app")}
								>
									<Icon name="add" className="h-3.5 w-3.5" />
									{importing ? "…" : t("import petdex")}
								</button>
								<button
									type="button"
									className="gui-btn"
									onClick={() => void importCodexPet()}
									disabled={importing || !isDesktopShell}
									title={isDesktopShell ? t("import codex sprite") : t("desktop pet needs desktop app")}
								>
									<Icon name="download" className="h-3.5 w-3.5" />
									{importing ? "…" : t("import codex sprite")}
								</button>
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
								{selectedEntry ? (
									<PetdexSprite
										mood="rest"
										src={selectedEntry.src}
										width={selectedEntry.width}
										height={selectedEntry.height}
										rows={selectedEntry.rows}
										contentH={selectedEntry.contentH}
									/>
								) : (
									<BuiltinPetSprite mood="rest" />
								)}
							</span>
							<span className="gui-pet-trigger__name">{selectedEntry?.name ?? t("builtin pet")}</span>
							<Icon
								name="arrow-down"
								className={`gui-pet-trigger__chevron${expanded ? " gui-pet-trigger__chevron--open" : ""}`}
							/>
						</button>
						<Reveal open={expanded}>
							<div className="gui-pet-grid" role="radiogroup" aria-label={t("companion appearance")}>
								{userEntries.length > 0 && <div className="gui-pet-group-label">{t("pet imported")}</div>}
								{userEntries.map(entry => (
									<PetCard
										key={entry.id}
										entry={entry}
										selected={entry.id === selectedPetId}
										onSelect={() => pickPet(entry.id)}
										onDelete={() => removePet(entry.id)}
									/>
								))}
								<div className="gui-pet-group-label">{t("pet presets")}</div>
								{presetEntries.map(entry => (
									<PetCard
										key={entry.id}
										entry={entry}
										selected={entry.id === selectedPetId}
										onSelect={() => pickPet(entry.id)}
									/>
								))}
							</div>
						</Reveal>
						<PetMarket
							petdex={petdex}
							onInstalled={pkg => {
								const next = [...petdex.filter(p => p.id !== pkg.id), pkg];
								setPetdex(next);
								savePetdex(next);
								pickPet(pkg.id);
							}}
						/>
					</>
				)}
			</div>
		</>
	);
}
