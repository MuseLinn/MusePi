import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { RpcClient } from "../lib/rpc";
import { Icon } from "../vendor/oc-icons";

export function BrowserImportCard({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [importing, setImporting] = useState(false);
	const [feedback, setFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(null);
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);

	const importData = async (): Promise<void> => {
		if (!rpc || importing) return;
		setImporting(true);
		setFeedback(null);
		try {
			const result = await rpc.request<{ ok?: boolean; importedFrom?: string; error?: string }>(
				"browser.importChrome",
				{},
			);
			if (!alive.current) return;
			if (result?.ok) {
				setFeedback({ kind: "success", message: t("tools.importChromeDataSuccess") });
			} else {
				setFeedback({
					kind: "error",
					message: result?.error || t("tools.importChromeDataFailed"),
				});
			}
		} catch (error) {
			if (!alive.current) return;
			setFeedback({
				kind: "error",
				message: error instanceof Error ? error.message : String(error),
			});
		} finally {
			if (alive.current) setImporting(false);
		}
	};

	return (
		<section className="gui-browser-import-card" aria-label={t("tools.importChromeDataShared")}>
			<span className="gui-browser-import-logo" aria-hidden>
				<Icon name="global" className="h-4 w-4" />
			</span>
			<div className="gui-browser-import-copy">
				<div className="gui-browser-import-title">{t("tools.importChromeDataShared")}</div>
				<div className="gui-browser-import-description">{t("tools.importChromeDataSharedDescription")}</div>
				{feedback ? (
					<div
						className={`gui-browser-import-feedback gui-browser-import-feedback--${feedback.kind}`}
						role={feedback.kind === "error" ? "alert" : "status"}
					>
						{feedback.message}
					</div>
				) : null}
			</div>
			<div className="gui-browser-import-actions">
				<button
					type="button"
					className="gui-btn gui-btn--small"
					disabled={!rpc || importing}
					onClick={() => void importData()}
				>
					{importing ? t("tools.importing") : t("general.import")}
				</button>
			</div>
		</section>
	);
}
