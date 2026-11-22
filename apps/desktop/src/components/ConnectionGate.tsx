/**
 * ConnectionGate — what the shell renders while no RPC client is open.
 *
 * The gate used to be `if (!rpc)` in `app.tsx`: every reason for "no client"
 * produced 无法连接本地守护进程, so a deliberate 断开 was reported as a fault.
 * The decision now lives here, in one place with one entry point, so the
 * surface a user sees is a function of the connection facts and nothing else:
 *
 *  - `unreachable`      → failure copy + 导出诊断 / 重启应用 (never the calm list alone);
 *  - `disconnected-by-user` / `unconfigured` → the connection manager, no failure copy;
 *  - `starting` / `connected` → the manager too, but with the header saying so.
 *
 * It exists as a component (rather than inline JSX) so the surface choice can
 * be asserted without mounting the whole shell: a regression that stopped
 * choosing the disconnected surface has to fail a test.
 */

import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { type ConnectionFacts, deriveConnectionState } from "../lib/connection/state";
import type { TargetStatusMap } from "../lib/connection/target-store";
import type { ConnectionTarget } from "../lib/connection/targets";
import type { WslRunner } from "../lib/connection/wsl";
import { ConnectionManager } from "./ConnectionManager";
import { BootRecoveryActions } from "./StartupSplash";

export function ConnectionGate({
	facts,
	targets,
	statuses,
	daemonUrl,
	activeTargetId,
	busyId,
	lastError,
	connectError,
	error,
	detect,
	platform,
	overlay,
	onConnect,
	onAdd,
	onRemove,
	onCopy,
}: {
	/** The four connection facts plus "has the user configured anything". */
	facts: ConnectionFacts;
	targets: readonly ConnectionTarget[];
	statuses: TargetStatusMap;
	daemonUrl: string;
	activeTargetId: string | null;
	busyId: string | null;
	/** Error of the attempt in flight. */
	lastError: string | null;
	/** Error the last attempt settled on (kept after it finished). */
	connectError: string | null;
	/** Shell-level error banner, shown alongside a failure. */
	error: string | null;
	detect?: WslRunner;
	platform?: string;
	/** Rendered inside the shell, above the gate (boot splash hand-off). */
	overlay?: ReactNode;
	onConnect(target: ConnectionTarget): void;
	onAdd(target: ConnectionTarget): void;
	onRemove(id: string): void;
	onCopy(text: string): void;
}): ReactNode {
	const connectionState = deriveConnectionState(facts);
	const busyTarget = targets.find(target => target.id === busyId) ?? null;
	return (
		<div className="gui-shell" data-connection-state={connectionState}>
			<ConnectionManager
				state={connectionState}
				targets={targets}
				statuses={statuses}
				daemonUrl={daemonUrl}
				activeTargetId={activeTargetId}
				busyId={busyTarget?.id ?? null}
				lastError={lastError}
				detect={detect}
				platform={platform}
				onConnect={onConnect}
				onAdd={onAdd}
				onRemove={onRemove}
				onCopy={onCopy}
			>
				{/* Failure-only actions. They belong to the failed attempt, not to
				 * the manager: a deliberate disconnect must not look like an error. */}
				{connectionState === "unreachable" ? (
					<>
						{connectError && <p className="gui-error">{connectError}</p>}
						{error && <p className="gui-error">{error}</p>}
						<BootRecoveryActions />
					</>
				) : (
					connectionState === "unconfigured" && <p className="gui-note">{t("settings.connectionUnconfigured")}</p>
				)}
			</ConnectionManager>
			{overlay}
		</div>
	);
}
