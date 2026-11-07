import { type TranslationKey, t, tLoose } from "@musepi/client-core";
import { CircleCheck as CircleCheckIconData, Circle as CircleIconData } from "lucide";
import { MorphIcon } from "morphicons/react";
import { type ReactNode, useEffect, useState } from "react";
import "../i18n/pet-style";
import { tapFeedback } from "../lib/haptic";
import {
	BUILTIN_PETDEX,
	BUILTIN_SVG_ID,
	loadPetdex,
	modeForPackage,
	type PetdexPackage,
	type PetMode,
	petForId,
	petId,
	setPetId,
	setPetMode,
} from "../lib/pet";
import {
	PET_ACCESSORIES,
	PET_DECOR_FLAGS,
	type PetAccessory,
	type PetDecor,
	petDecor,
	setPetAccessory,
	setPetDecorFlag,
} from "../lib/pet-decor";
import type { RpcClient } from "../lib/rpc";
import { dispatchSettingsChanged } from "../lib/settings-events";
import { AVATAR_PRESETS, avatarPresetId } from "./avatar-presets";
import { PetSprite } from "./PetSprite";

/** Onboarding personalization uses the same pet, decoration, avatar and
 * streaming preferences as Settings. Every pet card and the right-hand
 * desktop/composer preview render the selected PetSprite, including decor. */
export function PersonalizeSetup({
	rpc,
	petMode,
	onPetModeChange,
}: {
	rpc: RpcClient | null;
	petMode: "input" | "desktop";
	onPetModeChange: (mode: "input" | "desktop") => void;
}): ReactNode {
	const [avatarId, setAvatarId] = useState<string>(avatarPresetId);
	const [smooth, setSmooth] = useState(true);
	const [selectedPet, setSelectedPet] = useState<string>(() => petId());
	const [petdex] = useState<PetdexPackage[]>(() => loadPetdex());
	const [decor, setDecor] = useState<PetDecor>(() => petDecor());

	useEffect(() => {
		if (!rpc) return;
		void rpc
			.request<Record<string, unknown> | null>("settings.get", { keys: ["display.smoothStreaming"] })
			.then(v => {
				const s = v?.["display.smoothStreaming"];
				if (typeof s === "boolean") setSmooth(s);
			})
			.catch(() => {});
	}, [rpc]);

	const pickAvatar = (id: string): void => {
		tapFeedback();
		setAvatarId(id);
		try {
			localStorage.setItem("musepi-gui-avatar", id);
		} catch {
			// storage unavailable
		}
		window.dispatchEvent(new CustomEvent("omp-avatar-changed"));
	};

	const toggleSmooth = (): void => {
		tapFeedback();
		setSmooth(v => {
			const next = !v;
			void rpc
				?.request("settings.set", { key: "display.smoothStreaming", value: next })
				.then(() => dispatchSettingsChanged("display.smoothStreaming"))
				.catch(() => {});
			return next;
		});
	};

	const pickPet = (id: string): void => {
		tapFeedback();
		setSelectedPet(id);
		setPetId(id);
		window.dispatchEvent(new CustomEvent("omp-pet-changed"));
	};

	const petOptions: { id: string; displayName: string; description: string; mode: PetMode }[] = [
		{
			id: BUILTIN_SVG_ID,
			displayName: t("settings.builtinPet"),
			description: t("settings.builtinPetDescription"),
			mode: "vector",
		},
		...BUILTIN_PETDEX.map(p => ({
			id: p.id,
			displayName: t(p.displayName as TranslationKey),
			description: t(p.description as TranslationKey),
			mode: "sprite" as const,
		})),
		...petdex.map(p => ({
			id: p.id,
			displayName: p.displayName,
			description: p.description ?? "",
			mode: modeForPackage(p),
		})),
	];
	// The style follows the resolved selection: choosing a pet of the other
	// mode moves the switch, and picking a style restores that mode's pick.
	const style = petForId(selectedPet).mode;
	const visiblePetOptions = petOptions.filter(p => p.mode === style);
	// Decoration layers only exist on the builtin sphere; an imported sheet is
	// a baked bitmap.
	const builtinSelected = petForId(selectedPet).kind === "builtin";

	const pickStyle = (mode: PetMode): void => {
		tapFeedback();
		setPetMode(mode);
		setSelectedPet(petId());
		window.dispatchEvent(new CustomEvent("omp-pet-changed"));
	};

	const pickPetMode = (mode: "input" | "desktop"): void => {
		onPetModeChange(mode);
		try {
			localStorage.setItem("musepi-gui-pet-mode", mode);
		} catch {
			// storage unavailable
		}
		window.dispatchEvent(new CustomEvent("omp-pet-changed"));
	};

	return (
		<div className="gui-obo-personalize">
			<div className="gui-obo-pers-section">
				<div className="gui-obo-pers-label">{t("settings.petDisplayMode")}</div>
				<div className="flex items-center gap-1.5">
					<button
						type="button"
						className={`gui-obo-seg${petMode === "input" ? " gui-obo-seg--active" : ""}`}
						aria-pressed={petMode === "input"}
						onClick={() => pickPetMode("input")}
					>
						{t("settings.petModeInput")}
					</button>
					<button
						type="button"
						className={`gui-obo-seg${petMode === "desktop" ? " gui-obo-seg--active" : ""}`}
						aria-pressed={petMode === "desktop"}
						onClick={() => pickPetMode("desktop")}
					>
						{t("settings.petModeDesktop")}
					</button>
				</div>
			</div>

			<div className="gui-obo-pers-section">
				<div className="gui-obo-pers-label">{t("settings.agentAvatarStyle")}</div>
				<div className="flex items-center gap-1.5">
					{AVATAR_PRESETS.map(p => (
						<button
							key={p.id}
							type="button"
							className={`gui-avatar-opt${avatarId === p.id ? " gui-avatar-opt--active" : ""}`}
							title={t(p.labelKey as TranslationKey)}
							aria-pressed={avatarId === p.id}
							onClick={() => pickAvatar(p.id)}
						>
							{p.render("working", 20)}
						</button>
					))}
				</div>
			</div>

			<div className="gui-obo-pers-section">
				<div className="gui-obo-pers-label">{t("settings.smoothStreaming")}</div>
				<button
					type="button"
					role="switch"
					aria-checked={smooth}
					className={`gui-toggle${smooth ? " gui-toggle--on" : ""}`}
					onClick={toggleSmooth}
					aria-label={t("settings.smoothStreaming")}
				>
					<span className="gui-toggle-knob" />
				</button>
			</div>

			<div className="gui-obo-pers-section">
				<div className="gui-obo-pers-label">{tLoose("settings.petStyle")}</div>
				<div className="flex items-center gap-1.5">
					<button
						type="button"
						className={`gui-obo-seg${style === "vector" ? " gui-obo-seg--active" : ""}`}
						aria-pressed={style === "vector"}
						onClick={() => pickStyle("vector")}
					>
						{tLoose("settings.petStyleVector")}
					</button>
					<button
						type="button"
						className={`gui-obo-seg${style === "sprite" ? " gui-obo-seg--active" : ""}`}
						aria-pressed={style === "sprite"}
						onClick={() => pickStyle("sprite")}
					>
						{tLoose("settings.petStyleSprite")}
					</button>
				</div>
			</div>

			<div className="gui-obo-pers-section gui-obo-pers-section--stack">
				<div className="gui-obo-pers-label">{t("tools.petAppearance")}</div>
				<div className="gui-obo-pet-grid" role="radiogroup" aria-label={t("tools.petAppearance")}>
					{visiblePetOptions.map((p, index) => {
						const selected = selectedPet === p.id;
						return (
							<button
								key={p.id}
								type="button"
								role="radio"
								data-pet-option
								className={`gui-obo-pet-chip${selected ? " gui-obo-pet-chip--active" : ""}`}
								title={p.description || p.displayName}
								aria-checked={selected}
								tabIndex={selected ? 0 : -1}
								onClick={() => pickPet(p.id)}
								onKeyDown={e => {
									let nextIndex: number | null = null;
									if (e.key === "ArrowRight" || e.key === "ArrowDown")
										nextIndex = (index + 1) % visiblePetOptions.length;
									if (e.key === "ArrowLeft" || e.key === "ArrowUp")
										nextIndex = (index - 1 + visiblePetOptions.length) % visiblePetOptions.length;
									if (e.key === "Home") nextIndex = 0;
									if (e.key === "End") nextIndex = visiblePetOptions.length - 1;
									if (nextIndex === null) return;
									e.preventDefault();
									const next = visiblePetOptions[nextIndex];
									if (!next) return;
									pickPet(next.id);
									e.currentTarget.parentElement
										?.querySelectorAll<HTMLButtonElement>("[data-pet-option]")
										.item(nextIndex)
										.focus();
								}}
							>
								<span className="gui-obo-pet-preview" aria-hidden="true">
									<PetSprite
										mood="rest"
										pet={petForId(p.id)}
										size={40}
										scale={0.48}
										frozen
										gloss={decor.gloss}
										accessory={decor.accessory}
									/>
								</span>
								<span className="gui-obo-pet-name">
									{p.displayName}
									<MorphIcon
										icon={selected ? CircleCheckIconData : CircleIconData}
										size={14}
										spring="snappy"
										reducedMotion="user"
										className="gui-obo-pet-check"
									/>
								</span>
							</button>
						);
					})}
				</div>
			</div>

			<div className="gui-obo-pers-decor">
				{PET_DECOR_FLAGS.map(flag => (
					<div className="gui-obo-pers-decor-row" key={flag.key}>
						<span className="gui-obo-pers-label">{t(flag.labelKey as TranslationKey)}</span>
						<button
							type="button"
							role="switch"
							aria-checked={decor[flag.key]}
							className={`gui-toggle${decor[flag.key] ? " gui-toggle--on" : ""}`}
							disabled={!builtinSelected}
							onClick={() => {
								const value = !decor[flag.key];
								setDecor({ ...decor, [flag.key]: value });
								setPetDecorFlag(flag.key, value);
							}}
							aria-label={t(flag.labelKey as TranslationKey)}
						>
							<span className="gui-toggle-knob" />
						</button>
					</div>
				))}
				<div className="gui-obo-pers-decor-row">
					<span className="gui-obo-pers-label">{t("settings.petAccessory")}</span>
					<div className="gui-obo-pet-accessories" role="radiogroup" aria-label={t("settings.petAccessory")}>
						{PET_ACCESSORIES.map((value: PetAccessory) => (
							<button
								key={value}
								type="button"
								role="radio"
								aria-checked={decor.accessory === value}
								className={`gui-obo-seg${decor.accessory === value ? " gui-obo-seg--active" : ""}`}
								disabled={!builtinSelected}
								onClick={() => {
									setDecor({ ...decor, accessory: value });
									setPetAccessory(value);
								}}
							>
								{t(`pet accessory ${value}` as TranslationKey)}
							</button>
						))}
					</div>
				</div>
				<p className="gui-obo-pers-decor-note">
					{builtinSelected ? t("settings.petDecorDescription") : t("settings.petDecorDescriptionImported")}
				</p>
			</div>
		</div>
	);
}
