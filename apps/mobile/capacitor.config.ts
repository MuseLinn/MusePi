import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
	appId: "com.musepi.mobile",
	appName: "MusePi",
	webDir: "dist",
	server: {
		androidScheme: "https",
	},
	android: {
		// The Android WebView serves the app from an https:// origin, so its
		// WebSocket calls to plain-http LAN daemons (ws://192.168.x.x) would be
		// blocked as mixed content even with cleartext allowed. Allow it —
		// LAN transport is the core feature; room keys are E2E-encrypted
		// (collab-proto) and relay/tunnel traffic is wss anyway.
		allowMixedContent: true,
	},
	plugins: {
		Keyboard: {
			// 'none' leaves the WebView at full height; the UI follows the
			// keyboard itself via the --mp-keyboard-inset CSS variable (see
			// guest-client mobile styles). The built-in 'native' resize lands
			// only after the keyboard animation finishes (visible lag).
			resize: "none",
			resizeOnFullScreen: true,
			autoBackdropColor: "dom",
		},
		StatusBar: {
			overlaysWebView: true,
			style: "DARK",
		},
		LocalNotifications: {
			// These are the only Android keys @capacitor/local-notifications
			// reads (smallIcon, iconColor, sound — see its
			// LocalNotificationManager). Channels are NOT configurable here: the
			// plugin creates an IMPORTANCE_DEFAULT channel named "Default" and
			// takes a per-notification `channelId` instead. The branded
			// "musepi-session" channel is created natively in MainActivity, with
			// its name and description in res/values/strings.xml.
			smallIcon: "ic_stat_musepi",
			iconColor: "#D9A441",
		},
	},
};

export default config;
