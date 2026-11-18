package com.musepi.mobile;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Intent;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.provider.Settings;
import android.webkit.WebView;
import android.widget.Toast;
import androidx.core.content.ContextCompat;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
	/**
	 * Id of the branded notification channel. The web layer has to pass this as
	 * `channelId` when it schedules a notification — see ensureSessionChannel().
	 */
	private static final String SESSION_CHANNEL_ID = "musepi-session";

	/** Deep link the web layer understands (see lib/capacitor.ts). */
	private static final String CONNECT_URI = "musepi://connect?link=";

	/**
	 * Upper bound on the launch screen. The document load is the intended exit
	 * signal, but a failed load must not pin the splash over the app's own
	 * error/connect screen.
	 */
	private static final long SPLASH_TIMEOUT_MS = 4000;

	/**
	 * Set once the WebView reports the document finished loading. Not
	 * `onPageCommitVisible`: keeping the splash up cancels the content view's
	 * pre-draw, and a WebView only commits a visible frame while it is being
	 * drawn — the condition would then never clear and every cold start would
	 * sit on the splash until the timeout.
	 */
	private volatile boolean pageLoaded;

	@Override
	public void onCreate(Bundle savedInstanceState) {
		// Must run before super.onCreate(): it resolves the launch theme's
		// splash attributes and re-themes the window to postSplashScreenTheme.
		// Without it `Theme.SplashScreen` behaves as a plain theme and the
		// system splash is dismissed the moment the (still blank) WebView
		// window draws — the white/blank frame the web BootSplash cannot cover.
		long splashDeadline = SystemClock.uptimeMillis() + SPLASH_TIMEOUT_MS;
		SplashScreen.installSplashScreen(this).setKeepOnScreenCondition(
			() -> !pageLoaded && SystemClock.uptimeMillis() < splashDeadline);
		// Queued on bridgeBuilder, which super.onCreate() hands to the bridge:
		// the listener has to exist before the WebView starts loading.
		bridgeBuilder.addWebViewListener(new WebViewListener() {
			@Override
			public void onPageLoaded(WebView webView) {
				pageLoaded = true;
			}
		});
		// registerPlugin() only appends to bridgeBuilder — the bridge is
		// built (and plugins loaded) inside super.onCreate(), so the custom
		// Insets plugin must be queued BEFORE the super call.
		registerPlugin(InsetsPlugin.class);
		// A share-sheet handoff has to become this activity's intent before the
		// bridge is built: the bridge reads the launch data once in its
		// constructor, and the App plugin forwards only ACTION_VIEW intents to
		// the web layer's `appUrlOpen`.
		Intent incoming = getIntent();
		Intent shared = sharedDeepLinkIntent(incoming);
		if (shared != null) setIntent(shared);
		super.onCreate(savedInstanceState);
		// After super: plugin load has created its own "default" channel, and
		// this one is independent of it.
		ensureSessionChannel();
		// True edge-to-edge: the WebView paints under the transparent status
		// and gesture-navigation bars; the web UI offsets itself via the
		// Insets plugin (Android WebView ignores env(safe-area-inset-*)).
		WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
		// Consume every inset type at the decor so the WebView is laid out in
		// the full window (content bleeds behind the status and nav bars).
		// IME insets are deliberately included too — the Capacitor keyboard
		// plugin and CSS visualViewport handling manage keyboard offsets.
		ViewCompat.setOnApplyWindowInsetsListener(getWindow().getDecorView(), (v, insets) ->
			WindowInsetsCompat.CONSUMED);
	}

	/**
	 * Second launch of the running app (launchMode="singleTask"): a warm share
	 * or `musepi://` link arrives here instead of through onCreate. Capacitor
	 * also routes the launch intent through here (`BridgeActivity.load()` calls
	 * `onNewIntent(getIntent())`), so the no-link notice lives only in this
	 * method and fires once per handoff.
	 */
	@Override
	public void onNewIntent(Intent intent) {
		Intent shared = sharedDeepLinkIntent(intent);
		Intent delivered = shared != null ? shared : intent;
		// Android contract: the newest intent becomes getIntent(), so a later
		// activity recreate or WebView reload cannot replay an intent the
		// running page has already consumed.
		setIntent(delivered);
		super.onNewIntent(delivered);
		if (shared == null && isSharedText(intent)) {
			Toast.makeText(this, R.string.share_no_link, Toast.LENGTH_LONG).show();
		}
	}

	/** True for a share-sheet handoff carrying text (the SEND filter's MIME). */
	private static boolean isSharedText(Intent intent) {
		return intent != null && Intent.ACTION_SEND.equals(intent.getAction());
	}

	/**
	 * The `musepi://connect` intent for a collab link shared into the app, or
	 * null when the intent is not a share / the shared text carries no link.
	 *
	 * Only the shape is recognised here; whether the room and key are usable is
	 * decided by `parseCollabLink` in the web layer, which stays the single
	 * validator for every link source (QR, paste, notification, share).
	 */
	private static Intent sharedDeepLinkIntent(Intent intent) {
		if (!isSharedText(intent)) return null;
		CharSequence extra = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
		if (extra == null) return null;
		String link = firstCollabLink(extra.toString());
		if (link == null) return null;
		// Not started, only handed to the bridge as this activity's launch data:
		// no component is needed, and the App plugin keys off action + data.
		return new Intent(Intent.ACTION_VIEW, Uri.parse(CONNECT_URI + Uri.encode(link)));
	}

	/**
	 * First whitespace-delimited token that looks like a collab link:
	 * `ws(s)://host/r/<room>.<key>`, its http(s) form, or an already-formed
	 * `musepi://connect?link=` deep link. Chat apps wrap links in punctuation
	 * and prose, so tokens are split on whitespace and stripped of trailing
	 * sentence punctuation before parsing.
	 */
	private static String firstCollabLink(String shared) {
		for (String raw : shared.trim().split("\\s+")) {
			String token = stripTrailingPunctuation(raw);
			Uri uri = Uri.parse(token);
			String scheme = uri.getScheme();
			if (scheme == null) continue;
			if ("musepi".equalsIgnoreCase(scheme)) {
				String link = uri.getQueryParameter("link");
				if ("connect".equalsIgnoreCase(uri.getHost()) && link != null && !link.isEmpty()) return link;
				continue;
			}
			if (!isTransportScheme(scheme)) continue;
			String path = uri.getPath();
			if (path != null && path.contains("/r/")) return token;
		}
		return null;
	}

	private static boolean isTransportScheme(String scheme) {
		return "ws".equalsIgnoreCase(scheme)
			|| "wss".equalsIgnoreCase(scheme)
			|| "http".equalsIgnoreCase(scheme)
			|| "https".equalsIgnoreCase(scheme);
	}

	/** Drop `).,;:!?` quotes and CJK brackets a sentence puts after a link. */
	private static String stripTrailingPunctuation(String token) {
		int end = token.length();
		while (end > 0) {
			char last = token.charAt(end - 1);
			if (last == '.' || last == ',' || last == ';' || last == ':' || last == '!' || last == '?'
				|| last == ')' || last == ']' || last == '}' || last == '"' || last == '\''
				|| last == '\u3002' || last == '\uFF0C' || last == '\uFF09' || last == '\u300D'
				|| last == '\u300F' || last == '\u300B' || last == '\uFF1F' || last == '\uFF01') {
				end--;
				continue;
			}
			break;
		}
		return token.substring(0, end);
	}

	/**
	 * Branded channel for session-update notifications.
	 *
	 * @capacitor/local-notifications (v8) reads only `smallIcon`, `iconColor` and
	 * `sound` from capacitor.config.ts; it has no channel configuration and
	 * hard-codes its own IMPORTANCE_DEFAULT "default" channel named "Default".
	 * Channels cannot be changed afterwards (only the user can), so the branded
	 * one has to be created here, natively, from the system APIs. Notifications
	 * only land on it once the web layer passes `channelId: SESSION_CHANNEL_ID`
	 * to LocalNotifications.schedule().
	 */
	private void ensureSessionChannel() {
		if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
		NotificationManager manager = getSystemService(NotificationManager.class);
		if (manager == null) return;
		NotificationChannel channel = new NotificationChannel(
			SESSION_CHANNEL_ID,
			getString(R.string.notification_channel_session_name),
			NotificationManager.IMPORTANCE_HIGH);
		channel.setDescription(getString(R.string.notification_channel_session_description));
		channel.enableVibration(true);
		channel.enableLights(true);
		channel.setLightColor(ContextCompat.getColor(this, R.color.colorPrimary));
		channel.setSound(Settings.System.DEFAULT_NOTIFICATION_URI, new AudioAttributes.Builder()
			.setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
			.setUsage(AudioAttributes.USAGE_NOTIFICATION)
			.build());
		// Re-creating an existing channel is a no-op for behaviour it already
		// locked and keeps the localized name/description current.
		manager.createNotificationChannel(channel);
	}

	// The Android 12+ SplashScreen (core-splashscreen) drives the window
	// through the launch transition and may restore decor-fit after onCreate.
	// Re-assert edge-to-edge once the window gains focus (post-transition) so
	// the WebView reliably bleeds under the system bars.
	@Override
	public void onWindowFocusChanged(boolean hasFocus) {
		super.onWindowFocusChanged(hasFocus);
		if (hasFocus) {
			WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
		}
	}
}
