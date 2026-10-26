package com.rpg2android;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

/**
 * Minimal WebView host for RPG Maker MV / MZ games.
 *
 * The game itself lives in assets/www/ and is loaded from
 * file:///android_asset/www/index.html. The build script (build_apk.py)
 * replaces that folder and patches the application id / label, so nothing
 * game specific is hardcoded here.
 */
public class MainActivity extends Activity {
    private static final String TAG = "RPG2Android";
    private static final String START_URL = "file:///android_asset/www/index.html";

    private WebView webView;
    private long lastBackPress = 0L;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Lets "chrome://inspect" on a connected computer see this WebView.
        WebView.setWebContentsDebuggingEnabled(true);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.BLACK);
        webView.addJavascriptInterface(new HostBridge(), "RPG2Host");
        webView.setLongClickable(false);
        webView.setHapticFeedbackEnabled(false);
        webView.setOnLongClickListener(new View.OnLongClickListener() {
            @Override
            public boolean onLongClick(View v) {
                return true;
            }
        });

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        // RPG Maker loads data/*.json with XMLHttpRequest from file:// URLs.
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                Log.d(TAG, message.message() + " @" + message.sourceId() + ":" + message.lineNumber());
                return true;
            }
        });

        // RPG Maker only advances its scene while document.hasFocus() is true,
        // so the WebView itself has to hold window focus.
        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        root.setFocusable(false);
        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);

        hideSystemUi();
        webView.requestFocus();
        if (savedInstanceState == null) {
            webView.loadUrl(START_URL);
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    /** Receives the diagnostics that assets/rpg2android/host.js collects. */
    private static final class HostBridge {
        @JavascriptInterface
        public void log(String message) {
            if (message == null) {
                return;
            }
            String text = message.length() > 2000 ? message.substring(0, 2000) : message;
            Log.i("RPG2Android", text);
        }
    }

    private void hideSystemUi() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            hideSystemUi();
            if (webView != null) {
                webView.requestFocus();
            }
        }
    }

    /** Sends an Escape key press to the game (maps to "cancel"/menu in RPG Maker). */
    private void sendEscape() {
        if (webView == null) {
            return;
        }
        webView.evaluateJavascript(
                "(function(){" +
                        "var down=new KeyboardEvent('keydown',{bubbles:true,cancelable:true});" +
                        "Object.defineProperty(down,'keyCode',{get:function(){return 27;}});" +
                        "Object.defineProperty(down,'which',{get:function(){return 27;}});" +
                        "document.dispatchEvent(down);" +
                        "var up=new KeyboardEvent('keyup',{bubbles:true,cancelable:true});" +
                        "Object.defineProperty(up,'keyCode',{get:function(){return 27;}});" +
                        "Object.defineProperty(up,'which',{get:function(){return 27;}});" +
                        "document.dispatchEvent(up);" +
                        "})();", null);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        sendEscape();
        long now = SystemClock.uptimeMillis();
        if (now - lastBackPress < 2000L) {
            super.onBackPressed();
        } else {
            lastBackPress = now;
            Toast.makeText(this, "Press back again to exit", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) {
            webView.saveState(outState);
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) {
            webView.onPause();
            webView.pauseTimers();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.resumeTimers();
            webView.onResume();
            webView.requestFocus();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.stopLoading();
            webView.loadUrl("about:blank");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
