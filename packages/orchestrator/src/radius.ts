import { hostname, platform } from "node:os";
import { getOrchestratorDir, getSocketPath } from "./config.ts";
import { loadMachine, saveMachine } from "./storage.ts";
import type { InstanceRecord, MachineRecord } from "./types.ts";

const DEFAULT_RADIUS_URL = "https://radius.pi.dev/";
const DEFAULT_ORCHESTRATOR_BASE_PATH = "/v1/";

interface RegisterMachineResponse {
	id: string;
	heartbeatIntervalMs: number;
	expiresInMs: number;
}

interface RegisterPiResponse {
	id: string;
	heartbeatIntervalMs: number;
	expiresInMs: number;
}

async function post<T>(path: string, body: unknown): Promise<T> {
	const response = await fetch(new URL(path, getRadiusOrchestratorBaseUrl()), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${getRadiusApiKey()}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		throw new Error(`Radius request failed: ${response.status} ${await response.text()}`);
	}

	return (await response.json()) as T;
}

function maybePost(path: string, body: unknown): Promise<Response> {
	return fetch(new URL(path, getRadiusOrchestratorBaseUrl()), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${getRadiusApiKey()}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
}

export function getRadiusUrl(): string {
	return process.env.PI_RADIUS_URL || DEFAULT_RADIUS_URL;
}

export function getRadiusOrchestratorBaseUrl(): string {
	const explicitUrl = process.env.PI_RADIUS_ORCHESTRATOR_URL;
	if (explicitUrl) {
		return explicitUrl;
	}

	return new URL(DEFAULT_ORCHESTRATOR_BASE_PATH, getRadiusUrl()).toString();
}

export function getRadiusApiKey(): string {
	const apiKey = process.env.PI_RADIUS_API_KEY;
	if (!apiKey) {
		throw new Error("PI_RADIUS_API_KEY is required for Radius integration");
	}
	return apiKey;
}

export function isRadiusEnabled(): boolean {
	return !!process.env.PI_RADIUS_API_KEY;
}

export class RadiusPresence {
	private heartbeatTimer?: NodeJS.Timeout;
	private machine?: MachineRecord;

	async start(label?: string): Promise<MachineRecord | undefined> {
		if (!isRadiusEnabled()) {
			return undefined;
		}

		const registered = await post<RegisterMachineResponse>("/v1/machines/register", {
			label,
			hostname: hostname(),
			platform: platform(),
			arch: process.arch,
			version: "0.79.6",
			capabilities: { spawn: true, relay: false, iroh: false },
		});

		const now = new Date().toISOString();
		this.machine = {
			id: registered.id,
			createdAt: now,
			lastSeenAt: now,
			label,
		};
		saveMachine(this.machine);
		this.heartbeatTimer = setInterval(() => {
			void this.heartbeatMachine();
		}, registered.heartbeatIntervalMs);
		return this.machine;
	}

	async stop(): Promise<void> {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
		if (!this.machine || !isRadiusEnabled()) {
			return;
		}
		await maybePost(`/v1/machines/${this.machine.id}/disconnect`, {});
		this.machine = undefined;
	}

	async registerPi(instance: InstanceRecord): Promise<InstanceRecord> {
		if (!isRadiusEnabled()) {
			return instance;
		}
		const machine = this.machine ?? loadMachine();
		if (!machine) {
			throw new Error("No registered machine available for Pi registration");
		}
		const registered = await post<RegisterPiResponse>("/v1/pis/register", {
			machineId: machine.id,
			label: instance.label,
			cwd: instance.cwd,
			hostname: hostname(),
			pid: process.pid,
			transport: "local-rpc",
			capabilities: { rpc: true, relay: false, iroh: false },
			sessionId: instance.sessionId,
		});
		return { ...instance, radiusPiId: registered.id };
	}

	async disconnectPi(instance: InstanceRecord): Promise<void> {
		if (!isRadiusEnabled() || !instance.radiusPiId) {
			return;
		}
		await maybePost(`/v1/pis/${instance.radiusPiId}/disconnect`, {});
	}

	private async heartbeatMachine(): Promise<void> {
		if (!this.machine || !isRadiusEnabled()) {
			return;
		}
		await maybePost(`/v1/machines/${this.machine.id}/heartbeat`, {
			cwd: getOrchestratorDir(),
			socketPath: getSocketPath(),
		});
	}
}

export const radiusPresence = new RadiusPresence();
