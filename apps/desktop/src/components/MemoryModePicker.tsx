import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { Icon } from "../vendor/oc-icons";
import { MenuPopup } from "./MenuPopup";

export type SessionMemoryMode = "persistent" | "incognito" | "temporary";

function copy(mode: SessionMemoryMode): { title: string; hint: string; icon: "brain" | "eye-off" | "history" } {
	if (mode === "incognito") {
		return { title: t("general.memoryIncognito"), hint: t("general.memoryIncognitoHint"), icon: "eye-off" };
	}
	if (mode === "temporary") {
		return { title: t("general.memoryTemporary"), hint: t("general.memoryTemporaryHint"), icon: "history" };
	}
	return { title: t("general.memoryPersistent"), hint: t("general.memoryPersistentHint"), icon: "brain" };
}

export function MemoryModeOptions({
	value,
	onChange,
	modes = ["persistent", "incognito", "temporary"],
}: {
	value: SessionMemoryMode;
	onChange(mode: SessionMemoryMode): void;
	modes?: readonly SessionMemoryMode[];
}): ReactNode {
	return (
		<div className="gui-memory-mode-options">
			{modes.map(mode => {
				const item = copy(mode);
				return (
					<button
						type="button"
						key={mode}
						data-memory-mode={mode}
						className="gui-memory-mode-option"
						aria-pressed={value === mode}
						onClick={() => onChange(mode)}
					>
						<Icon name={item.icon} className="gui-memory-mode-icon" />
						<span className="gui-memory-mode-copy">
							<strong>{item.title}</strong>
							<span>{item.hint}</span>
						</span>
						{value === mode && <Icon name="check" className="h-3.5 w-3.5" />}
					</button>
				);
			})}
		</div>
	);
}

export function MemoryModeChip({
	value,
	onChange,
}: {
	value: SessionMemoryMode;
	onChange(mode: SessionMemoryMode): void;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const anchorRef = useRef<HTMLButtonElement | null>(null);
	const selected = copy(value);
	return (
		<>
			<button
				type="button"
				ref={anchorRef}
				className="gui-memory-chip gui-liquid-glass"
				aria-label={t("general.chooseMemoryMode")}
				aria-expanded={open}
				onClick={() => setOpen(current => !current)}
			>
				<Icon name={selected.icon} className="h-3.5 w-3.5" />
				<span>{value === "persistent" ? t("general.chooseMemoryMode") : selected.title}</span>
			</button>
			<MenuPopup
				open={open}
				className="gui-memory-mode-menu"
				anchor={anchorRef.current}
				align="right"
				onOpenChange={setOpen}
			>
				<MemoryModeOptions
					value={value}
					onChange={mode => {
						setOpen(false);
						onChange(mode);
					}}
				/>
			</MenuPopup>
		</>
	);
}
