// ============================================================
// MusePi en-US locale - English source strings for the TUI.
//
// Keys are namespaced ("<domain>.<name>"); values are the English
// text shown for en-US. Regenerated from scripts/i18n-key-migration.json
// (the namespaced-key migration's old-literal -> new-key map); do not
// hand-edit entries that exist in the migration map.
// ============================================================

import type { TranslationMap } from "../index.ts";

export const auth: TranslationMap = {
	"auth.apiKey": "API Key",
	"auth.apiKeyConfigured": "API key configured",
	"auth.authNone": "Auth: None",
	"auth.authOauth": "Auth: OAuth (authenticated)",
	"auth.authorizationTokenUrlsRequired": "Authorization and Token URLs are required.",
	"auth.chooseNextAction": "Choose next action:",
	"auth.configured": "✓ configured",
	"auth.editOauthSettings": "  Edit OAuth settings",
	"auth.enterOauthAuthorizationEndpoint": "Enter the OAuth authorization endpoint:",
	"auth.enterOauthScopes": "Enter OAuth scopes (space-separated):",
	"auth.enterOauthTokenEndpoint": "Enter the OAuth token endpoint:",
	"auth.enterYourApiKey": "Enter your API key or token:",
	"auth.enterYourOauthClient": "Enter your OAuth client ID:",
	"auth.enterYourOauthClientSecret": "Enter your OAuth client secret:",
	"auth.launchingBrowserAuthorization": "Launching browser for authorization...",
	"auth.launchingOauthFlow": "Launching OAuth flow...",
	"auth.mcpOauthFlowCancelled": "MCP OAuth flow cancelled by user",
	"auth.mcpOauthFlowTimed": "MCP OAuth flow timed out",
	"auth.noAuthenticationRequired": "No authentication required",
	"auth.oauthParametersCouldNot": "OAuth parameters could not be discovered.",
	"auth.provideApiKeyToken": "Provide API key/token manually.",
	"auth.saveConfiguration": "Save this configuration?",
	"auth.selectProviderConfigure": "Select provider to configure:",
	"auth.selectProviderLogout": "Select provider to logout:",
	"auth.subscriptionConfigured": "subscription configured",
	"auth.unconfigured": "unconfigured",
	"auth.unconfigured2": "• unconfigured",
};
