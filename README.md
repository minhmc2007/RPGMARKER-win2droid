# rpgmarker-win2droid

Play your **RPG Maker MV / MZ** Windows games on Android.

The game is HTML5 + NW.js, so a WebView is enough. This repo keeps a tiny Java
WebView shell, builds it once in GitHub Actions, and ships a Python script that
injects a game into that prebuilt APK and re-signs it - no Android SDK, no
Gradle, no phone-side building.

```
GitHub Actions ──► prebuilt/base.apk   (empty WebView app, committed here)
                            │
build_apk.py --game-dir … ──┴──► dist/<game>.apk  (game injected + signed)
```

## Quick start

1. **Get the template APK.** Run *Actions → Build template APK → Run workflow*
   once (leave `commit_apk` on). It builds `prebuilt/base.apk` and commits it
   back to the repo. Run it again whenever you change the Java side.
2. **Build a game APK.**

   ```bash
   python build_apk.py --game-dir "../[Kimochi] RJ01610452 EN"
   ```

   Point `--game-dir` at the game folder **or** at the folder containing it -
   the script finds the folder with `index.html` and takes the app name from
   *that* folder (never from its parent).

   ```
   game:       Princess of Light Tiarie Prism
   package id: com.ffcfgllh.princessoflighttiarieprism
   injected:   812 files, 611.3 MB, icon …/icon/icon.png
   signed:     v2, 2048 bit RSA (debug key)
   output:     dist/princessoflighttiarieprism.apk
   ```
3. **Install it yourself**: `adb install -r dist/<game>.apk` (or copy the APK
   to the phone and open it).

Requires Python 3.9+ and nothing else - the APK reader, the binary manifest
editor and the v2 signer are plain standard library code.

## Application id and name

* **Name** - the game root folder name, cleaned up (trailing `_`/`-`, leading
  `[group]` tags). Override with `--name "My Game"`.
* **Application id** - `com.<random>.<gamename>`, e.g.
  `com.ffcfgllh.princessoflighttiarieprism`. The random part is a stable hash
  of the name, so rebuilding the same game keeps the same id (= updates
  install over the old app instead of creating a duplicate). Lowercase, no
  spaces, ASCII; non-latin titles fall back to `game<hash>`. Override with
  `--package com.example.mygame`.

## What the script does

1. Finds the game root (folder with `index.html`) and derives the identity.
2. Unpacks the prebuilt APK, rewrites `AndroidManifest.xml`
   (`package`, `android:label`, optionally `android:screenOrientation`) *in the
   binary XML*, keeping the element layout untouched.
3. Copies the game into `assets/www/` (the app loads
   `file:///android_asset/www/index.html`). NW.js/Chromium runtime files -
   `*.dll`, `*.pak`, `*.exe`, `locales/`, `swiftshader/`, `icudtl.dat`, the
   game updater - are skipped; everything a browser needs is kept.
4. Optionally swaps the launcher icon for the game's `icon/icon.png`.
5. Re-signs with APK Signature Scheme **v2** using the throwaway debug key in
   `tools/debug/` (a re-signed APK is mandatory: changing any byte invalidates
   the old signature).
6. Verifies its own signature before reporting success.

## Options

```
--game-dir        game folder, or the folder containing it (required)
--apk             template APK (default: prebuilt/base.apk)
--out             output directory (default: dist/)
--name            override the application name
--package         override the application id
--orientation     sensorLandscape | landscape | portrait | sensor | fullSensor | user | reverseLandscape
--icon            auto (game icon/icon.png) | none | path/to/icon.png
--key-dir         directory with debug.key.pem / debug.cert.pem (default: tools/debug)
--dry-run         print the detected identity and exit
```

## Runtime behaviour of the shell

* Landscape by default, immersive fullscreen, screen kept awake.
* DOM storage + database enabled, so **saves work** (RPG Maker stores them in
  `localStorage`, which lives inside the app and is wiped if you uninstall).
* `file://` XHR allowed, media autoplay allowed (needed for audio/BGM).
* The WebView is given window focus explicitly, and the injected host script
  keeps RPG Maker updating whenever the page is visible. MZ otherwise skips
  scene updates unless `window.top.document.hasFocus()` is true, which is
  unreliable inside a WebView and freezes the game on a black splash screen
  while the music keeps playing.
* Back button closes the virtual keyboard or the diagnostics panel if one is
  open, otherwise sends <kbd>Esc</kbd> (cancel/menu); press twice to exit.
* Game audio/timers pause when the app goes to the background.

## Shell overlay: diagnostics and virtual keyboard

`android/app/src/main/assets/rpg2android/host.js` ships **inside the app**, not
inside the game. `MainActivity` reads it and evaluates it into the page once the
document is committed, so the game's own `index.html` and every other game file
stay byte-identical to what the game shipped with. The overlay does not change
gameplay.

**Diagnostics panel.** Tap the small `i` in the top-right corner; it also opens
by itself after a JS error or when the canvas has painted nothing but black for
a while. It reports JS errors, failed resources and the rendering state (WebGL
renderer, frame count, canvas geometry, sampled pixels). Close it with the `✕`
button in its header. The same lines are mirrored to logcat under the
`RPG2Android` tag, and `chrome://inspect` works against the WebView when a
computer is connected.

**Virtual keyboard.** The keyboard icon next to the `i` opens a translucent US
laptop layout over the bottom of the screen — Esc, F1–F12, Tab, Caps, Shift,
Ctrl, Alt, Enter, Backspace, Delete and the arrow keys — with the game still
visible through the blurred, tinted backdrop. `✕` (or the hardware back button)
closes it. Keys are delivered as real key events, so they drive RPG Maker's
input; if a text field has focus (e.g. a plugin's name entry), typed characters
and Backspace/Delete edit it directly. Shift/Ctrl/Alt latch for one keypress;
tap twice to lock them (shown with an amber outline).

## Repo layout

```
android/                 Java WebView app + Gradle project (built only in CI)
  app/src/main/java/com/rpg2android/MainActivity.java
  app/src/main/assets/www/index.html   placeholder, replaced at inject time
  app/src/main/assets/rpg2android/host.js   shell overlay: diagnostics + keyboard
build_apk.py             CLI: inject a game into the template and sign it
tools/identity.py        game root detection, name + package id
tools/axml.py            binary AndroidManifest.xml reader/writer
tools/apkzip.py          APK zip reader/writer (compression + alignment)
tools/signer.py          APK Signature Scheme v2 sign/verify, pure Python
tools/debug/             throwaway signing key (debug key, not a secret)
prebuilt/base.apk        empty WebView APK produced by CI
.github/workflows/build.yml   builds the template + verifies the injector
```

## Notes and limits

* Game files are **never** committed - `.gitignore` keeps them out. Only the
  generic shell belongs in this repo.
* APKs are limited to 4 GB and 65535 entries (ZIP32), the v2 signer does not
  emit ZIP64. Huge games can drop unused `audio/`, `img/` or `effects/` assets
  first.
* The debug key means the APK is not distributed through Play; that is fine
  for personal sideloading. Rebuilding a game with a different key requires
  uninstalling the old app (signature mismatch).
* `targetSdk 34`, `minSdk 24`, so installs on Android 7.0+.
