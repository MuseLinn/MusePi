import type { AgentSnapshot } from "@musepi/pi-wire";
import type { TranslationKey } from "../../i18n/index.js";

/** Localized label key for an agent's lifecycle state. One mapping for the
 *  rail row and the detail header, so neither can drift back to the raw
 *  wire word. */
export function agentStatusKey(status: AgentSnapshot["status"]): TranslationKey {
	switch (status) {
		case "running":
			return "agents.agentStatusRunning";
		case "parked":
			return "agents.agentStatusParked";
		case "aborted":
			return "agents.agentStatusAborted";
		case "idle":
			return "agents.agentStatusIdle";
	}
}
