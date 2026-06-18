import { randomUUID } from "node:crypto";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	type RpcCommand,
	type RpcResponse,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { radiusPresence } from "./radius.ts";
import { handleRpcCommand } from "./rpc-bridge.ts";
import { getInstance, loadInstances, removeInstance, upsertInstance } from "./storage.ts";
import type { InstanceRecord } from "./types.ts";

interface LiveInstance {
	runtime: AgentSessionRuntime;
	record: InstanceRecord;
}

function cloneInstance(record: InstanceRecord): InstanceRecord {
	return { ...record };
}

async function createRuntime(cwd: string): Promise<AgentSessionRuntime> {
	const agentDir = getAgentDir();
	const sessionManager = SessionManager.create(cwd);
	const runtimeFactory: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		agentDir,
		sessionManager,
		sessionStartEvent,
	}) => {
		const services = await createAgentSessionServices({ cwd, agentDir });
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
		});
		return {
			...created,
			services,
			diagnostics: services.diagnostics,
		};
	};

	return createAgentSessionRuntime(runtimeFactory, {
		cwd,
		agentDir,
		sessionManager,
	});
}

export class OrchestratorSupervisor {
	private readonly liveInstances = new Map<string, LiveInstance>();

	listInstances(): InstanceRecord[] {
		return loadInstances().map(cloneInstance);
	}

	getInstance(instanceId: string): InstanceRecord | undefined {
		const live = this.liveInstances.get(instanceId);
		if (live) {
			return cloneInstance(live.record);
		}
		const stored = getInstance(instanceId);
		return stored ? cloneInstance(stored) : undefined;
	}

	async spawnInstance(options: { cwd: string; label?: string }): Promise<InstanceRecord> {
		const runtime = await createRuntime(options.cwd);
		const now = new Date().toISOString();
		const record: InstanceRecord = {
			id: randomUUID(),
			status: "online",
			cwd: options.cwd,
			createdAt: now,
			lastSeenAt: now,
			label: options.label,
			sessionId: runtime.session.sessionId,
			sessionFile: runtime.session.sessionFile,
		};

		const registeredRecord = await radiusPresence.registerPi(record);
		this.liveInstances.set(registeredRecord.id, { runtime, record: registeredRecord });
		upsertInstance(registeredRecord);
		return cloneInstance(registeredRecord);
	}

	async stopInstance(instanceId: string): Promise<InstanceRecord | undefined> {
		const live = this.liveInstances.get(instanceId);
		if (!live) {
			return undefined;
		}

		await radiusPresence.disconnectPi(live.record);
		await live.runtime.dispose();
		this.liveInstances.delete(instanceId);
		removeInstance(instanceId);
		return cloneInstance(live.record);
	}

	async handleRpc(instanceId: string, command: RpcCommand): Promise<RpcResponse | undefined> {
		const live = this.liveInstances.get(instanceId);
		if (!live) {
			return undefined;
		}

		return handleRpcCommand(live.runtime, command);
	}
}

export const supervisor = new OrchestratorSupervisor();
