package com.rpg2android;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.res.AssetManager;
import android.graphics.Color;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.ValueCallback;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;

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

    /** Guards the one-shot media extraction below (the bridge thread calls it). */
    private static final Object MEDIA_LOCK = new Object();
    /** Longest movie the shell is willing to copy out of the APK. */
    private static final long MAX_MEDIA_BYTES = 512L * 1024L * 1024L;

    private WebView webView;
    private long lastBackPress = 0L;
    private String hostScript;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Lets "chrome://inspect" on a connected computer see this WebView.
        WebView.setWebContentsDebuggingEnabled(true);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.BLACK);
        webView.addJavascriptInterface(new HostBridge(getApplicationContext()), "RPG2Host");
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

        // The overlay (diagnostics panel + virtual keyboard) is part of the
        // shell, never of the game: it is read from this APK's own assets and
        // evaluated into whatever page the WebView loads, so the game files are
        // left exactly as shipped.
        hostScript = readAsset("rpg2android/host.js");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageCommitVisible(WebView view, String url) {
                super.onPageCommitVisible(view, url);
                injectHostScript();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                injectHostScript();
            }
        });
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

    private String readAsset(String name) {
        try (InputStream in = getAssets().open(name);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) > 0) {
                out.write(buffer, 0, read);
            }
            return out.toString("UTF-8");
        } catch (IOException e) {
            Log.w(TAG, "overlay asset missing: " + name, e);
            return null;
        }
    }

    /** Runs assets/rpg2android/host.js in the page; it is idempotent. */
    private void injectHostScript() {
        if (webView == null || hostScript == null || hostScript.isEmpty()) {
            return;
        }
        webView.evaluateJavascript(hostScript + "\n//# sourceURL=rpg2android/host.js", null);
    }

    /** Receives the diagnostics that assets/rpg2android/host.js collects. */
    private static final class HostBridge {
        private final Context context;

        HostBridge(Context context) {
            this.context = context;
        }

        @JavascriptInterface
        public void log(String message) {
            if (message == null) {
                return;
            }
            String text = message.length() > 2000 ? message.substring(0, 2000) : message;
            Log.i("RPG2Android", text);
        }

        /**
         * Copies a movie out of the APK into the app's own files directory and
         * returns a file:// URL for it, or "" when that is not possible.
         *
         * Android's media stack opens media files itself and cannot read a path
         * that only exists inside an APK: a &lt;video&gt; element pointed at
         * file:///android_asset/www/movies/x.webm reports an error before its
         * first frame. RPG Maker hands its media to the page as plain relative
         * paths (movies/...), so the overlay asks for the file here instead and
         * gets back a real path the media stack can open.
         *
         * @param path game relative path, e.g. "movies/feather.webm"
         */
        @JavascriptInterface
        public String mediaFile(String path) {
            String relative = MediaPath.normalize(path);
            if (relative == null) {
                return "";
            }
            synchronized (MEDIA_LOCK) {
                try {
                    File dir = new File(context.getFilesDir(), "media");
                    prepareMediaDir(dir, buildStamp(context));
                    File out = new File(dir, relative);
                    if (!isUsableFile(out) && !extract(context.getAssets(), "www/" + relative, out)) {
                        return "";
                    }
                    return "file://" + out.getAbsolutePath();
                } catch (Exception e) {
                    Log.w(TAG, "cannot provide media file for " + relative, e);
                    return "";
                }
            }
        }
    }

    private static boolean isUsableFile(File file) {
        return file.isFile() && file.length() > 0;
    }

    /**
     * Throws away copies made by an earlier version of the app: the movies come
     * from the APK, so a new install may carry different ones.
     */
    private static void prepareMediaDir(File dir, String current) {
        File stamp = new File(dir, ".version");
        if (current.equals(readText(stamp))) {
            return;
        }
        deleteRecursively(dir);
        if (dir.mkdirs()) {
            writeText(stamp, current);
        }
    }

    private static String buildStamp(Context context) {
        try {
            PackageInfo info = context.getPackageManager()
                    .getPackageInfo(context.getPackageName(), 0);
            return info.lastUpdateTime + ":" + info.versionName;
        } catch (Exception e) {
            return "unknown";
        }
    }

    /**
     * Copies one asset to a real file (via a .part file, so an interrupted copy
     * is never mistaken for a finished one).
     *
     * @return true when the file exists afterwards, false when the asset is
     *         missing or too large
     */
    private static boolean extract(AssetManager assets, String asset, File out) {
        File parent = out.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            Log.w(TAG, "cannot create " + parent);
            return false;
        }
        File partial = new File(out.getAbsolutePath() + ".part");
        InputStream in = null;
        FileOutputStream stream = null;
        try {
            in = assets.open(asset, AssetManager.ACCESS_STREAMING);
            stream = new FileOutputStream(partial);
            byte[] buffer = new byte[64 * 1024];
            long total = 0;
            int read;
            while ((read = in.read(buffer)) > 0) {
                total += read;
                if (total > MAX_MEDIA_BYTES) {
                    Log.w(TAG, "media file too large: " + asset);
                    return false;
                }
                stream.write(buffer, 0, read);
            }
            closeQuietly(stream);
            stream = null;
            closeQuietly(in);
            in = null;
            if (out.exists() && !out.delete()) {
                Log.w(TAG, "cannot replace " + out);
            }
            if (!partial.renameTo(out)) {
                Log.w(TAG, "cannot move " + partial + " into place");
                return false;
            }
            Log.i(TAG, "extracted " + asset + " (" + total + " bytes)");
            return true;
        } catch (IOException e) {
            Log.w(TAG, "asset missing: " + asset);
            return false;
        } finally {
            closeQuietly(stream);
            closeQuietly(in);
            if (partial.isFile() && !out.isFile()) {
                partial.delete();
            }
        }
    }

    private static void closeQuietly(Closeable stream) {
        if (stream == null) {
            return;
        }
        try {
            stream.close();
        } catch (IOException e) {
            // nothing useful to do while tearing a copy down
        }
    }

    private static String readText(File file) {
        if (!isUsableFile(file)) {
            return "";
        }
        // java.nio.file needs API 26, this app supports 24.
        try (java.io.FileInputStream in = new java.io.FileInputStream(file)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[512];
            int read;
            while ((read = in.read(buffer)) > 0) {
                out.write(buffer, 0, read);
            }
            return out.toString("UTF-8");
        } catch (IOException e) {
            return "";
        }
    }

    private static void writeText(File file, String text) {
        try (FileOutputStream stream = new FileOutputStream(file)) {
            stream.write(text.getBytes());
        } catch (IOException e) {
            Log.w(TAG, "cannot write " + file, e);
        }
    }

    private static void deleteRecursively(File file) {
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursively(child);
                }
            }
        }
        if (file.exists() && !file.delete()) {
            Log.w(TAG, "cannot delete " + file);
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
        if (webView == null) {
            backFallback();
            return;
        }
        // Let the overlay consume the press first (close the keyboard/panel).
        webView.evaluateJavascript(
                "(window.RPG2Android && RPG2Android.handleBack)" +
                        " ? RPG2Android.handleBack() : false",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if (!"true".equals(value)) {
                            backFallback();
                        }
                    }
                });
    }

    private void backFallback() {
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
