import { t } from "@musepi/client-core";
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { listOpenInApps, type OpenInApp, openWith } from "../lib/electron";
import { MenuPopup } from "./MenuPopup";

/** Per-file open-with picker. The adjacent default-app action stays separate. */
export function FileOpenWith({ path }: { path: string }): ReactNode {
	const anchor = useRef<HTMLButtonElement | null>(null);
	const [open, setOpen] = useState(false);
	const [apps, setApps] = useState<OpenInApp[]>([]);
	const show = async (): Promise<void> => {
		setApps(await listOpenInApps());
		setOpen(true);
	};
	return (
		<>
			<button
				ref={anchor}
				type="button"
				className="gui-btn gui-btn-icon"
				title={t("settings.openWith")}
				aria-label={t("settings.openWith")}
				aria-expanded={open}
				onClick={() => void show()}
			>
				<ChevronDown size={12} />
			</button>
			<MenuPopup
				open={open}
				className="gui-openin-menu gui-file-open-with"
				anchor={anchor.current}
				align="right"
				onOpenChange={setOpen}
			>
				{apps.map(app => (
					<button
						key={app.id}
						type="button"
						className="gui-view-opt"
						onClick={() => {
							setOpen(false);
							void openWith(app.appName, path);
						}}
					>
						<span className="gui-openin-app-icon">
							{app.iconDataUrl ? <img src={app.iconDataUrl} alt="" draggable={false} /> : app.label.slice(0, 1)}
						</span>
						<span>{app.label}</span>
					</button>
				))}
				{apps.length === 0 && <div className="gui-file-open-with-empty">{t("general.noApps")}</div>}
			</MenuPopup>
		</>
	);
}
