import { afterEach, beforeEach } from "bun:test";

import type { CompleteOptions, LlmBackend } from "@musepi/pi-mnemopi/core/llm-backends";
import { resetHostLlmBackendForTests, setHostLlmBackend } from "@musepi/pi-mnemopi/core/llm-backends";
import { resetDefaultInstanceForTests } from "@musepi/pi-mnemopi/core/memory";

export function resetModuleStateForTests(): void {
	resetDefaultInstanceForTests();
	resetHostLlmBackendForTests();
}

export function disableLocalLlmForTests(): void {
	resetHostLlmBackendForTests();
}

export function withLocalLlm(fakeResponseOrBackend: string | LlmBackend = "fake summary"): LlmBackend {
	const backend =
		typeof fakeResponseOrBackend === "string"
			? new FakeLocalLlmBackend(fakeResponseOrBackend)
			: fakeResponseOrBackend;

	setHostLlmBackend(backend);
	return backend;
}

class FakeLocalLlmBackend implements LlmBackend {
	readonly name = "fake-local-llm";

	constructor(public response: string) {}

	complete(_prompt: string, _opts?: CompleteOptions): string {
		return this.response;
	}

	createChatCompletion(): { choices: [{ message: { content: string } }] } {
		return { choices: [{ message: { content: this.response } }] };
	}
}

beforeEach(() => {
	resetModuleStateForTests();
});

afterEach(() => {
	resetModuleStateForTests();
});
