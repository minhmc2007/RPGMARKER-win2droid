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
import java.util.Arrays;

/**
 * Minimal WebView host for RPG Maker MV / MZ games. The game is loaded from
 * assets/www/; build_apk.py replaces it and patches the app id and label.
 */
public class MainActivity extends Activity {
    private static final String TAG = "RPG2Android";
    private static final String START_URL = "file:///android_asset/www/index.html";

    /** Guards the one-shot media extraction (the bridge thread calls it). */
    private static final Object MEDIA_LOCK = new Object();
    /** Longest movie the shell is willing to copy out of the APK. */
    private static final long MAX_MEDIA_BYTES = 512L * 1024L * 1024L;
    /** Audio folders RPG Maker ships, in the order the extension is probed. */
    private static final String[] AUDIO_FOLDERS = {"bgm", "bgs", "me", "se", "vo"};

    private WebView webView;
    private long lastBackPress = 0L;
    private String hostScript;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Lets chrome://inspect see this WebView.
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

        // The overlay belongs to the shell. readAsset loads it from this APK, so
        // game files stay untouched.
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

        // RPG Maker only advances a scene while document.hasFocus() is true.
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
        /** Answer of {@link #audioFileExt()}, cached after the first call. */
        private String audioExt;

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
         * Returns the audio extension the game ships, for example ".ogg", or ""
         * when it is mixed or missing. RPG Maker guesses ".m4a" on Android, which
         * Windows games usually do not ship.
         */
        @JavascriptInterface
        public String audioFileExt() {
            synchronized (MEDIA_LOCK) {
                if (audioExt != null) {
                    return audioExt;
                }
                audioExt = "";
                for (String folder : AUDIO_FOLDERS) {
                    try {
                        String ext = AudioAssets.fileExt(Arrays.asList(
                                context.getAssets().list("www/audio/" + folder)));
                        if (!ext.isEmpty()) {
                            audioExt = ext;
                            break;
                        }
                    } catch (IOException e) {
                        // No such folder in this game; try the next one.
                    }
                }
                Log.i(TAG, "game audio extension: " +
                        (audioExt.isEmpty() ? "mixed/unknown (engine default)" : audioExt));
                return audioExt;
            }
        }

        /**
         * Copies a movie out of the APK and returns a file:// URL, or "". The
         * media stack cannot open a path inside an APK.
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
     * Drops copies from an older app version, since a new install may ship
     * different movies.
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
     * Copies an asset through a .part file, so an interrupted copy is never
     * mistaken for a finished one. Returns false when the asset is missing or
     * too large.
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

    /** Sends Escape to the game (cancel/menu in RPG Maker). */
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
        // Let the overlay close the keyboard or panel first.
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
