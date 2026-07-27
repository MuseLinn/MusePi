/**
 * Selector Controller — all `showXxxSelector` / `showXxxDashboard` methods.
 *
 * Ported from OMP's selector-controller.ts. Each method creates a selector
 * overlay and returns the user's choice via the done callback.
 */

import type { Model } from "@musepi/pi-ai/compat";
import { ProjectTrustStore } from "../../../core/trust-manager.ts";
import { HistorySearchComponent } from "../components/history-search.ts";
import { ModelSelectorComponent } from "../components/model-selector.ts";
import { TrustSelectorComponent } from "../components/trust-selector.ts";
import { UserMessageSelectorComponent } from "../components/user-message-selector.ts";
import type { InteractiveModeContext } from "../types.ts";

export class SelectorController {
	readonly #ctx: InteractiveModeContext;

	constructor(ctx: InteractiveModeContext) {
		this.#ctx = ctx;
	}

	dispose(): void {
		// Nothing to dispose yet
	}

	showModelSelector(initialSearchInput?: string): void {
		this.#ctx.showFullscreenSelector((done) => {
			const selector = new ModelSelectorComponent(
				this.#ctx.ui,
				this.#ctx.session.model,
				this.#ctx.settingsManager,
				this.#ctx.session.modelRuntime,
				this.#ctx.session.scopedModels,
				async (model: Model<any>) => {
					try {
						await this.#ctx.session.setModel(model);
						this.#ctx.footer.invalidate();
						this.#ctx.updateEditorBorderColor();
						done();
						this.#ctx.showStatus(`Model: ${model.id}`);
						this.#ctx.warnAboutModel(model);
					} catch (error: unknown) {
						done();
						this.#ctx.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.#ctx.requestRender();
				},
				initialSearchInput,
			);
			return { component: selector, focus: selector };
		});
	}

	showTrustSelector(): void {
		const cwd = this.#ctx.sessionManager.getCwd();
		const trustStore = new ProjectTrustStore(this.#ctx.runtimeHost.services.agentDir);
		const savedDecision = trustStore.getEntry(cwd);
		this.#ctx.showSelector((done) => {
			const selector = new TrustSelectorComponent({
				cwd,
				savedDecision,
				projectTrusted: this.#ctx.settingsManager.isProjectTrusted(),
				onSelect: (selection) => {
					trustStore.setMany(selection.updates);
					done();
					this.#ctx.showStatus(
						`Saved trust decision: ${selection.trusted ? "trusted" : "untrusted"}. Restart pi for this to take effect.`,
					);
				},
				onCancel: () => {
					done();
					this.#ctx.requestRender();
				},
			});
			return { component: selector, focus: selector };
		});
	}

	showHistorySearch(): void {
		const all = this.#ctx.defaultEditor.getHistory();
		const entries = this.#ctx.isBashMode ? all.filter((entry) => entry.startsWith("!")) : [...all];
		if (entries.length === 0) {
			this.#ctx.showStatus("No history to search");
			return;
		}
		this.#ctx.showSelector((done) => {
			const component = new HistorySearchComponent(
				entries,
				(selected) => {
					done();
					this.#ctx.editor.setText(selected);
					this.#ctx.requestRender();
				},
				() => {
					done();
					this.#ctx.requestRender();
				},
			);
			return { component, focus: component };
		});
	}

	showUserMessageSelector(): void {
		const userMessages = this.#ctx.session.getUserMessagesForForking();
		if (userMessages.length === 0) {
			this.#ctx.showStatus("No messages to fork from");
			return;
		}
		const initialSelectedId = userMessages[userMessages.length - 1]?.entryId;
		this.#ctx.showSelector((done) => {
			const selector = new UserMessageSelectorComponent(
				userMessages.map((m) => ({ id: m.entryId, text: m.text })),
				async (entryId) => {
					done();
					try {
						const result = await this.#ctx.runtimeHost.fork(entryId);
						if (result.cancelled) {
							this.#ctx.requestRender();
							return;
						}
						this.#ctx.editor.setText(result.selectedText ?? "");
						this.#ctx.showStatus("Forked to new session");
					} catch (error: unknown) {
						this.#ctx.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.#ctx.requestRender();
				},
				initialSelectedId,
			);
			return { component: selector, focus: selector.getMessageList() };
		});
	}
}
