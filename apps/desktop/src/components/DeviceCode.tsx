import { t } from "@musepi/client-core";
import { useCallback, useEffect, useRef, useState } from "react";
import { copyToClipboard } from "../lib/electron";

/**
 * A device-verification code, rendered as the copy target itself.
 *
 * The code is the one string a person has to move from this window into a
 * browser tab, so it should never require selecting it by hand: it lands on
 * the clipboard when it arrives, and clicking the chip copies it again (the
 * clipboard may have been overwritten by the time they get back). Both paths
 * share one feedback state — the label flips to 已复制 for a moment.
 */
export function DeviceCode({ code, autoCopy = true }: { code: string; autoCopy?: boolean }): React.ReactNode {
	const [copied, setCopied] = useState(false);
	const resetTimer = useRef<Timer | null>(null);

	const copy = useCallback(async (): Promise<void> => {
		if (!code) return;
		if (!(await copyToClipboard(code))) return;
		setCopied(true);
		if (resetTimer.current) clearTimeout(resetTimer.current);
		resetTimer.current = setTimeout(() => setCopied(false), 1600);
	}, [code]);

	useEffect(() => {
		setCopied(false);
		if (!autoCopy || !code) return;
		// Arrival is the only moment worth copying without a gesture: the code
		// is about to be needed in another window, and typing it by hand from a
		// screenshot-prone dialog is the bug this replaces.
		void copy();
	}, [autoCopy, code, copy]);

	useEffect(
		() => () => {
			if (resetTimer.current) clearTimeout(resetTimer.current);
		},
		[],
	);

	return (
		<button
			type="button"
			className={`gui-device-code${copied ? " gui-device-code--copied" : ""}`}
			onClick={() => void copy()}
			title={copied ? t("general.codeCopied") : t("general.copyCode")}
			aria-label={t("general.copyCode")}
		>
			<code className="gui-device-code-value">{code}</code>
			<span className="gui-device-code-hint">{copied ? t("general.codeCopied") : t("general.copyCode")}</span>
		</button>
	);
}
