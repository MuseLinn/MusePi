/**
 * Debug command handler with interactive menu.
 *
 * Provides tools for debugging, bug report generation, and system diagnostics.
 */
import { type Component, Container, type SelectItem, SelectList, Spacer, Text } from "@musepi/pi-tui";
import { DynamicBorder } from "../modes/interactive/components/dynamic-border.ts";
import { getSelectListTheme, theme } from "../modes/interactive/theme/theme.ts";
import { buildSampleImage, ProtocolProbeComponent } from "./protocol-probe.ts";
import { collectSystemInfo, formatSystemInfo } from "./system-info.ts";
import { collectTerminalState, formatTerminalState } from "./terminal-info.ts";

export interface DebugSelectorDelegate {
	showError(message: string): void;
	showWarning(message: string): void;
	showStatus(message: string): void;
	presentBlock(text: string): void;
	presentComponent(component: Component): void;
	ui: {
		terminal: { columns: number; rows: number };
		requestRender(): void;
	};
	handleDebugTranscriptCommand?(): Promise<void>;
}

/** Debug menu options */
const DEBUG_MENU_ITEMS: SelectItem[] = [
	{ value: "system", label: "View: system info", description: "Show environment details" },
	{ value: "terminal", label: "View: terminal state", description: "Capabilities, geometry, protocols" },
	{ value: "protocols", label: "Test: terminal protocols", description: "Styling, links, graphics" },
	{ value: "transcript", label: "Export: TUI transcript", description: "Write visible TUI conversation to text" },
	{ value: "performance", label: "Report: performance issue", description: "Profile CPU, reproduce, then bundle" },
	{ value: "dump", label: "Report: dump session", description: "Create report bundle immediately" },
	{ value: "memory", label: "Report: memory issue", description: "Heap snapshot + bundle" },
	{ value: "logs", label: "View: recent logs", description: "Show last 50 log entries" },
	{ value: "raw-sse", label: "View: raw SSE stream", description: "Show live provider SSE frames" },
	{ value: "open-artifacts", label: "Open: artifact folder", description: "Open session artifacts in file manager" },
	{ value: "clear-cache", label: "Clear: artifact cache", description: "Remove old session artifacts" },
];

/**
 * Debug selector component — rendered as an inline card with DynamicBorder.
 */
export class DebugSelectorComponent extends Container {
	#selectList: SelectList;
	#delegate: DebugSelectorDelegate;

	constructor(delegate: DebugSelectorDelegate, onDone: () => void) {
		super();

		this.#delegate = delegate;

		// Title
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", "Debug Tools")), 1, 0));
		this.addChild(new Spacer(1));

		// Select list
		this.#selectList = new SelectList(DEBUG_MENU_ITEMS, 7, getSelectListTheme());

		this.#selectList.onSelect = (item) => {
			onDone();
			void this.#handleSelection(item.value);
		};

		this.#selectList.onCancel = () => {
			onDone();
		};

		this.addChild(this.#selectList);
		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		this.#selectList.handleInput(keyData);
	}

	async #handleSelection(value: string): Promise<void> {
		switch (value) {
			case "system":
				await this.#handleViewSystemInfo();
				break;
			case "terminal":
				await this.#handleViewTerminalState();
				break;
			case "protocols":
				await this.#handleViewProtocols();
				break;
			case "transcript":
				await this.#handleTranscriptExport();
				break;
			case "performance":
			case "dump":
			case "memory":
			case "logs":
			case "raw-sse":
			case "open-artifacts":
			case "clear-cache":
				this.#delegate.showWarning(`"${value}" not yet available in MusePi debug tools`);
				break;
		}
	}

	async #handleViewSystemInfo(): Promise<void> {
		try {
			const info = await collectSystemInfo();
			const formatted = formatSystemInfo(info);
			this.#delegate.presentBlock(formatted);
		} catch (err) {
			this.#delegate.showError(`Failed to collect system info: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async #handleViewTerminalState(): Promise<void> {
		const info = collectTerminalState({
			columns: this.#delegate.ui.terminal.columns,
			rows: this.#delegate.ui.terminal.rows,
		});
		const formatted = formatTerminalState(info);
		this.#delegate.presentBlock(formatted);
	}

	async #handleViewProtocols(): Promise<void> {
		this.#delegate.presentComponent(
			new ProtocolProbeComponent({
				image: buildSampleImage(),
			}),
		);
	}

	async #handleTranscriptExport(): Promise<void> {
		if (this.#delegate.handleDebugTranscriptCommand) {
			await this.#delegate.handleDebugTranscriptCommand();
		} else {
			this.#delegate.showWarning("Transcript export not available in this mode");
		}
	}
}
