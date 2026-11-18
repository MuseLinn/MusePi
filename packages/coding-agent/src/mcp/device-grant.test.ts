import { describe, expect, it } from "bun:test";
import {
	DeviceGrantError,
	deviceAuthorizationUrl,
	pollDeviceAuthorization,
	startDeviceAuthorization,
} from "./device-grant";

/** One canned answer, in the shape the GitHub endpoints use. */
function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("device grant", () => {
	it("prefers the advertised endpoint over the conventional path", () => {
		expect(deviceAuthorizationUrl("https://github.com/login/oauth")).toBe(
			"https://github.com/login/oauth/.well-known/oauth-device-authorization",
		);
		expect(deviceAuthorizationUrl("https://github.com/login/oauth", "https://github.com/login/device/code")).toBe(
			"https://github.com/login/device/code",
		);
	});

	it("reads a user code and a device code from the start response", async () => {
		const fetchImpl = async (): Promise<Response> =>
			jsonResponse({
				device_code: "dc-123",
				user_code: "ABCD-1234",
				verification_uri: "https://github.com/login/device",
				expires_in: 900,
				interval: 5,
			});

		const start = await startDeviceAuthorization({
			authorizationServer: "https://github.com/login/oauth",
			clientId: "Iv1.example",
			scopes: "repo read:org",
			fetch: fetchImpl as unknown as typeof fetch,
		});

		expect(start.userCode).toBe("ABCD-1234");
		expect(start.deviceCode).toBe("dc-123");
		expect(start.verificationUri).toBe("https://github.com/login/device");
		expect(start.interval).toBe(5);
		expect(start.expiresIn).toBe(900);
	});

	it("reports a missing client id instead of asking the server", async () => {
		await expect(
			startDeviceAuthorization({
				authorizationServer: "https://github.com/login/oauth",
				clientId: "",
				fetch: (async () => jsonResponse({})) as unknown as typeof fetch,
			}),
		).rejects.toThrow(DeviceGrantError);
	});

	it("surfaces a server refusal with its own wording", async () => {
		const fetchImpl = async (): Promise<Response> =>
			jsonResponse({ error: "device_flow_disabled", error_description: "Device flow is off" });

		await expect(
			startDeviceAuthorization({
				authorizationServer: "https://github.com/login/oauth",
				clientId: "Iv1.example",
				fetch: fetchImpl as unknown as typeof fetch,
			}),
		).rejects.toThrow("Device flow is off");
	});

	it("treats a pending answer as progress rather than a failure", async () => {
		const fetchImpl = async (): Promise<Response> =>
			jsonResponse({ error: "authorization_pending", error_description: "still waiting" });

		const result = await pollDeviceAuthorization({
			tokenUrl: "https://github.com/login/oauth/access_token",
			clientId: "Iv1.example",
			deviceCode: "dc-123",
			fetch: fetchImpl as unknown as typeof fetch,
		});

		expect(result.status).toBe("pending");
		expect(result.slowDown).toBeUndefined();
	});

	it("reports a slow-down answer so the caller can wait longer", async () => {
		const fetchImpl = async (): Promise<Response> =>
			jsonResponse({ error: "slow_down", error_description: "too soon", interval: 10 });

		const result = await pollDeviceAuthorization({
			tokenUrl: "https://github.com/login/oauth/access_token",
			clientId: "Iv1.example",
			deviceCode: "dc-123",
			fetch: fetchImpl as unknown as typeof fetch,
		});

		expect(result.status).toBe("pending");
		expect(result.slowDown).toBe(true);
	});

	it("returns the tokens once the user authorizes", async () => {
		const fetchImpl = async (): Promise<Response> =>
			jsonResponse({
				access_token: "gho_token",
				refresh_token: "ghr_token",
				expires_in: 28800,
				scope: "repo,read:org",
				token_type: "bearer",
			});

		const result = await pollDeviceAuthorization({
			tokenUrl: "https://github.com/login/oauth/access_token",
			clientId: "Iv1.example",
			deviceCode: "dc-123",
			fetch: fetchImpl as unknown as typeof fetch,
		});

		expect(result.status).toBe("success");
		expect(result.tokens?.accessToken).toBe("gho_token");
		expect(result.tokens?.refreshToken).toBe("ghr_token");
		expect(result.tokens?.scope).toBe("repo,read:org");
	});

	it("turns a denial into an error the caller can show", async () => {
		const fetchImpl = async (): Promise<Response> =>
			jsonResponse({ error: "access_denied", error_description: "The user denied the request." });

		await expect(
			pollDeviceAuthorization({
				tokenUrl: "https://github.com/login/oauth/access_token",
				clientId: "Iv1.example",
				deviceCode: "dc-123",
				fetch: fetchImpl as unknown as typeof fetch,
			}),
		).rejects.toThrow("The user denied the request.");
	});
});
