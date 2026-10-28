# rpgmarker-win2droid

Play RPG Maker MV / MZ Windows games on Android.

The game is HTML5 + NW.js, so a WebView is enough. This repo has a small Java
WebView shell, built once in GitHub Actions, plus a Python script that injects a
game into that prebuilt APK and signs it. No Android SDK, Gradle or phone-side
building needed.

```
GitHub Actions -> prebuilt/base.apk   (empty WebView app, committed here)
build_apk.py --game-dir ... -> dist/<game>.apk   (game injected and signed)
```

## Quick start

1. **Get the template APK.** Run *Actions > Build template APK > Run workflow*
   once, with `commit_apk` on. It builds `prebuilt/base.apk` and commits it.
   Run it again after changing the Java side.
2. **Build a game APK.**

   ```bash
   python build_apk.py --game-dir "../[Kimochi] RJ01610452 EN"
   ```

   `--game-dir` can point at the game folder or the folder that contains it.
   The script finds the folder with `index.html` and takes the app name from
   that folder.

   ```
   game:       Princess of Light Tiarie Prism
   package id: com.ffcfgllh.princessoflighttiarieprism
   injected:   812 files, 611.3 MB, icon .../icon/icon.png
   signed:     v2, 2048 bit RSA (debug key)
   output:     dist/princessoflighttiarieprism.apk
   ```
3. **Install it:** `adb install -r dist/<game>.apk`, or copy the APK to the
   phone and open it.

Needs Python 3.9+. The APK reader, manifest editor and v2 signer use only the
standard library.

## Name and app id

* **Name**: the game root folder name, cleaned up (trailing `_`/`-`, leading
  `[group]` tags). Override with `--name "My Game"`.
* **App id**: `com.<random>.<gamename>`, for example
  `com.ffcfgllh.princessoflighttiarieprism`. The random part is a stable hash of
  the name, so a rebuild updates the old app instead of installing a duplicate.
  Override with `--package com.example.mygame`.

## What the script does

1. Finds the game root and works out its name and app id.
2. Unpacks the template APK and patches `AndroidManifest.xml` (package, label,
   optional orientation) in the binary XML.
3. Copies the game into `assets/www/`. NW.js runtime files (`*.dll`, `*.pak`,
   `*.exe`, `locales/`, `swiftshader/`, `icudtl.dat`, the updater) are skipped.
4. Optionally replaces the launcher icon with the game's `icon/icon.png`.
5. Signs the APK with APK Signature Scheme v2, using the debug key in
   `tools/debug/`.
6. Checks its own signature before reporting success.

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

## Runtime behaviour

* Landscape by default, immersive fullscreen, screen kept awake.
* DOM storage is enabled, so saves work. Saves live in `localStorage` inside the
  app and are lost when the app is uninstalled.
* `file://` XHR and media autoplay are allowed, which audio and BGM need.
* Movies are copied out of the APK into the app's files directory the first
  time they play, because Android's media stack cannot open files inside an APK.
* Audio uses the extension the game actually ships (usually `.ogg`), not the one
  RPG Maker guesses from the user agent.
* The hardware back button closes the button editor, keyboard or diagnostics
  panel if one is open. Otherwise it sends <kbd>Esc</kbd>. Press it twice to
  exit.
* Game audio and timers pause while the app is in the background.

## Shell overlay

`android/app/src/main/assets/rpg2android/host.js` ships inside the app, not
inside the game. `MainActivity` evaluates it into the page, so the game files
stay byte-identical. It adds:

* **Diagnostics panel.** Tap the `i` in the top right. It also opens after a JS
  error or when the canvas stays black. It shows JS errors, failed resources and
  rendering state. Close it with `x`. Lines also go to logcat under the
  `RPG2Android` tag.
* **Virtual keyboard.** The keyboard icon opens a translucent US layout with
  Esc, F1 to F12, modifiers, arrows and the usual keys. Keys go to the game, or
  to a focused text field. Shift, Ctrl and Alt latch for one keypress; tap twice
  to lock them.
* **On-screen buttons.** The gamepad icon shows floating buttons that send a key
  to the game while held. Hold the icon to open the editor, where you can add,
  move, resize, relabel, reshape and delete buttons. The layout is saved in
  `localStorage` as `r2a.controls.v1` and kept per app.

## Repo layout

```
android/                 Java WebView app + Gradle project (built only in CI)
  app/src/main/java/com/rpg2android/MainActivity.java
  app/src/main/java/com/rpg2android/MediaPath.java
  app/src/main/java/com/rpg2android/AudioAssets.java
  app/src/main/assets/rpg2android/host.js
  app/src/main/assets/www/index.html   placeholder, replaced at inject time
build_apk.py             inject a game into the template and sign it
tools/identity.py        game root detection, name + package id
tools/axml.py            binary AndroidManifest.xml reader/writer
tools/apkzip.py          APK zip reader/writer (compression + alignment)
tools/signer.py          APK Signature Scheme v2 sign/verify
tools/debug/             throwaway signing key
prebuilt/base.apk        empty WebView APK produced by CI
.github/workflows/build.yml   builds the template and checks the injector
```

## Limits

* Game files are never committed. `.gitignore` keeps them out.
* APKs are limited to 4 GB and 65535 entries (ZIP32). The v2 signer does not
  write ZIP64. For huge games, remove unused `audio/`, `img/` or `effects/`
  assets first.
* The debug key means the APK is for personal sideloading, not the Play Store.
  Rebuilding a game with a different key needs an uninstall first.
* `targetSdk 34`, `minSdk 24`, so it runs on Android 7.0 and newer.
