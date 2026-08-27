import { type TranslationKey, t } from "@musepi/desktop-web";
import { type ReactNode, useEffect, useState } from "react";
import { tapFeedback } from "../lib/haptic";
import { BUILTIN_PETDEX, loadPetdex, type PetdexPackage, petId } from "../lib/pet";
import type { RpcClient } from "../lib/rpc";
import { Icon } from "../vendor/oc-icons";
import { AVATAR_PRESETS, avatarPresetId } from "./avatar-presets";

/**
 * Onboarding personalization step (post-provider setup): pick the agent
 * avatar style, the streaming reveal toggle and the desktop-pet theme —
 * all live-previewed and persisted exactly like the settings rows they
 * mirror (设置 → 常规 / 伙伴 / display.smoothStreaming).
 */
export function PersonalizeSetup({
	rpc,
	petMode,
	onPetModeChange,
}: {
	rpc: RpcClient | null;
	/** Pet display mode — lifted to OnboardingOverlay so the preview (right
	 *  pane) hides the pet in "desktop" mode and shows it in "input". */
	petMode: "input" | "desktop";
	onPetModeChange: (mode: "input" | "desktop") => void;
}): ReactNode {
	const [avatarId, setAvatarId] = useState<string>(avatarPresetId);
	const [smooth, setSmooth] = useState(true);
	const [selectedPet, setSelectedPet] = useState<string>(() => {
		try {
			return localStorage.getItem("musepi-gui-pet-id") ?? "musepi";
		} catch {
			return "musepi";
		}
	});
	const [petdex, setPetdex] = useState<PetdexPackage[]>(() => loadPetdex());

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
				.then(() =>
					window.dispatchEvent(
						new CustomEvent("omp-settings-changed", { detail: { key: "display.smoothStreaming" } }),
					),
				)
				.catch(() => {});
			return next;
		});
	};

	const pickPet = (id: string): void => {
		tapFeedback();
		setSelectedPet(id);
		try {
			localStorage.setItem("musepi-gui-pet-id", id);
		} catch {
			// storage unavailable
		}
		window.dispatchEvent(new CustomEvent("omp-pet-changed"));
	};

	const petOptions = [
		...BUILTIN_PETDEX,
		...petdex.map(p => ({ id: p.id, displayName: p.displayName, description: "" })),
	];
	// Where the pet lives: docked inside the composer ("input") or its own
	// desktop window ("desktop") — musepi-gui-pet-mode, same key the pet host
	// reads. State is lifted (OnboardingOverlay) so the chat preview on the
	// right reflects the choice live.
	const pickPetMode = (mode: "input" | "desktop"): void => {
		onPetModeChange(mode);
		try {
			localStorage.setItem("musepi-gui-pet-mode", mode);
		} catch {
			// ignore
		}
		window.dispatchEvent(new CustomEvent("omp-pet-changed"));
	};

	return (
		<div className="gui-obo-personalize">
			<div className="gui-obo-pers-section">
				<div className="gui-obo-pers-label">{t("pet display mode")}</div>
				<div className="flex items-center gap-1.5">
					<button
						type="button"
						className={`gui-obo-seg${petMode === "input" ? " gui-obo-seg--active" : ""}`}
						aria-pressed={petMode === "input"}
						onClick={() => pickPetMode("input")}
					>
						{t("pet mode input")}
					</button>
					<button
						type="button"
						className={`gui-obo-seg${petMode === "desktop" ? " gui-obo-seg--active" : ""}`}
						aria-pressed={petMode === "desktop"}
						onClick={() => pickPetMode("desktop")}
					>
						{t("pet mode desktop")}
					</button>
				</div>
			</div>

			<div className="gui-obo-pers-section">
				<div className="gui-obo-pers-label">{t("agent avatar style")}</div>
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
				<div className="gui-obo-pers-label">{t("smooth streaming")}</div>
				<button
					type="button"
					role="switch"
					aria-checked={smooth}
					className={`gui-toggle${smooth ? " gui-toggle--on" : ""}`}
					onClick={toggleSmooth}
					aria-label={t("smooth streaming")}
				>
					<span className="gui-toggle-knob" />
				</button>
			</div>

			<div className="gui-obo-pers-section">
				<div className="gui-obo-pers-label">{t("pet theme")}</div>
				<div className="gui-obo-pet-grid">
					{petOptions.map(p => (
						<button
							key={p.id}
							type="button"
							className={`gui-obo-pet-chip${selectedPet === p.id ? " gui-obo-pet-chip--active" : ""}`}
							title={p.description || p.displayName}
							aria-pressed={selectedPet === p.id}
							onClick={() => pickPet(p.id)}
						>
							<Icon name={selectedPet === p.id ? "checkbox-circle" : "checkbox-blank"} className="h-3.5 w-3.5" />
							<span className="gui-obo-pet-name">{p.displayName}</span>
						</button>
					))}
				</div>
			</div>
		</div>
	);
}
