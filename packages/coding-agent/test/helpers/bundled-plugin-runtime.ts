import { CordisDynamicPluginRuntime } from "../../src/daemon/cordis-dynamic-plugins";
import { DaemonHostContext } from "../../src/daemon/host-context";
import { TerminalRegistry } from "../../src/daemon/terminal-registry";
import { resetCapabilityActivations } from "../../src/extensibility/capability-activation";
import { resetVoiceEngineActivations } from "../../src/voice/engine-registry";

/** Real host runtime with the services bundled component entries require. */
export function createBundledPluginRuntime() {
	const host = new DaemonHostContext();
	const runtime = new CordisDynamicPluginRuntime(host);
	const terminalRegistry = new TerminalRegistry();
	runtime.provideHostService("terminal:backends", terminalRegistry);
	return {
		runtime,
		terminalRegistry,
		async dispose(): Promise<void> {
			await runtime.dispose();
			await host.dispose();
			resetCapabilityActivations();
			resetVoiceEngineActivations();
		},
	};
}
