import { t } from "../../i18n/index.js";
import type { ConnectionPhase } from "../../lib/client";

/**
 * Reader-facing name for a connection phase.
 *
 * The phase id is wire vocabulary (`live` / `workspace` / `waiting`), never
 * copy: every surface that shows it — the header's phase dot and the host
 * manager's status line — asks this function instead of rendering the id.
 */
export function phaseLabel(phase: ConnectionPhase): string {
	switch (phase) {
		case "live":
		case "workspace":
			return t("transcript.connected");
		case "reconnecting":
			return t("shell.reconnecting");
		case "ended":
			return t("settings.notConnected");
		case "waiting":
			return t("shell.joiningSession");
		default:
			return t("settings.connecting2");
	}
}
