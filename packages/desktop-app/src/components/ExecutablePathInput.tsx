import { t } from "@musepi/client-core";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { ExternalExecutableProbeResult } from "../lib/external-agent-config";
import { Icon } from "../vendor/oc-icons";

type ProbeState =
	| { status: "idle" | "checking" }
	| { status: "success"; result: Extract<ExternalExecutableProbeResult, { available: true }> }
	| { status: "error"; result: Extract<ExternalExecutableProbeResult, { available: false }> };

export function ExecutablePathInput({
	id,
	name,
	value,
	onChange,
	onProbe,
	disabled,
}: {
	id: string;
	name: string;
	value: string;
	onChange(value: string): void;
	onProbe(value: string): Promise<ExternalExecutableProbeResult>;
	disabled: boolean;
}): ReactNode {
	const [state, setState] = useState<ProbeState>({ status: "idle" });
	const valueRef = useRef(value);
	const requestRef = useRef(0);
	valueRef.current = value;

	const runProbe = useCallback(async () => {
		const request = ++requestRef.current;
		setState({ status: "checking" });
		try {
			const result = await onProbe(valueRef.current);
			if (request !== requestRef.current) return;
			setState(result.available ? { status: "success", result } : { status: "error", result });
		} catch (error) {
			if (request !== requestRef.current) return;
			setState({
				status: "error",
				result: {
					available: false,
					reason: "failed",
					error: error instanceof Error ? error.message : String(error),
				},
			});
		}
	}, [onProbe]);

	useEffect(() => {
		void runProbe();
		return () => {
			requestRef.current++;
		};
	}, [runProbe]);

	const feedbackId = `${id}-probe-feedback`;
	return (
		<div className="gui-plugin-config-control">
			<div className="gui-plugin-config-path-controls">
				<input
					id={id}
					name={name}
					type="text"
					className="gui-plugin-config-input"
					value={value}
					aria-label={name}
					aria-describedby={feedbackId}
					aria-invalid={state.status === "error" || undefined}
					disabled={disabled}
					onChange={event => {
						setState({ status: "idle" });
						onChange(event.target.value);
					}}
					onBlur={() => void runProbe()}
				/>
				<button
					type="button"
					className="gui-plugin-config-probe"
					disabled={disabled || state.status === "checking"}
					onClick={() => void runProbe()}
				>
					<Icon
						name={state.status === "checking" ? "loader-4" : "refresh"}
						className={`h-3 w-3${state.status === "checking" ? " animate-spin" : ""}`}
					/>
					{state.status === "checking"
						? t("tools.extConfigProbeChecking")
						: state.status === "idle"
							? t("tools.extConfigProbeCheck")
							: t("tools.extConfigProbeAgain")}
				</button>
			</div>
			<div id={feedbackId} className="gui-plugin-config-feedback" role="status" aria-live="polite">
				{state.status === "success" && (
					<>
						<span className="gui-plugin-config-feedback--success">
							<Icon name="check" className="h-3 w-3" />
							{state.result.version || t("tools.extConfigProbeAvailable")}
						</span>
						<span className="gui-plugin-config-feedback-path" title={state.result.path}>
							{state.result.path}
						</span>
					</>
				)}
				{state.status === "error" && (
					<span className="gui-plugin-config-feedback--error">
						<Icon name="alert" className="h-3 w-3" />
						{state.result.reason === "not-found"
							? t("tools.extConfigProbeNotFound")
							: state.result.error || t("tools.extConfigProbeFailed")}
					</span>
				)}
			</div>
		</div>
	);
}
