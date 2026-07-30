import type { Model } from "@oh-my-pi/pi-ai";

export type ComputerExposureMode = "native" | "function" | "unavailable";

export interface ComputerExposureOptions {
	azureBaseUrl?: string;
	azureResourceName?: string;
}

function isFirstPartyAzureEndpoint(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		return (
			url.protocol === "https:" &&
			(url.hostname.endsWith(".openai.azure.com") || url.hostname === "models.inference.ai.azure.com")
		);
	} catch {
		return false;
	}
}

/** Match the provider transport's effective Computer Use tool representation. */
export function computerExposureMode(
	model: Model | undefined,
	options?: ComputerExposureOptions,
): ComputerExposureMode {
	if (!model) return "unavailable";
	if (model.supportsComputerUse !== true) return "function";
	if (model.api !== "azure-openai-responses" || model.supportsComputerUseConfig !== undefined) return "native";
	const baseUrl =
		options?.azureBaseUrl?.trim() ||
		process.env.AZURE_OPENAI_BASE_URL?.trim() ||
		(options?.azureResourceName || process.env.AZURE_OPENAI_RESOURCE_NAME
			? `https://${options?.azureResourceName || process.env.AZURE_OPENAI_RESOURCE_NAME}.openai.azure.com/openai/v1`
			: undefined) ||
		model.baseUrl;
	return baseUrl && isFirstPartyAzureEndpoint(baseUrl) ? "native" : "function";
}
