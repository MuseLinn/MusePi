package com.musepi.mobile;

import android.view.WindowInsets;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Exposes the real system-bar insets (status bar top, navigation bar bottom)
 * to the web layer. Android WebView does not surface these via
 * env(safe-area-inset-*) even in edge-to-edge mode, so the app reads them
 * here and injects the CSS variables (--safe-top / --safe-bottom) instead.
 * Values are returned in dp.
 */
@CapacitorPlugin(name = "Insets")
public class InsetsPlugin extends Plugin {
	@PluginMethod
	public void getSystemBars(PluginCall call) {
		JSObject ret = new JSObject();
		try {
			WindowInsets insets = getActivity().getWindow().getDecorView().getRootWindowInsets();
			float density = getActivity().getResources().getDisplayMetrics().density;
			int top = 0;
			int bottom = 0;
			if (insets != null) {
				top = insets.getInsets(WindowInsets.Type.statusBars()).top;
				bottom = insets.getInsets(WindowInsets.Type.navigationBars()).bottom;
			}
			ret.put("top", Math.round(top / density));
			ret.put("bottom", Math.round(bottom / density));
		} catch (Exception e) {
			ret.put("top", 0);
			ret.put("bottom", 0);
		}
		call.resolve(ret);
	}
}