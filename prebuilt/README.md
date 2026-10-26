# prebuilt/

`base.apk` is the empty WebView shell, built by the
[`Build template APK`](../.github/workflows/build.yml) workflow and committed
here so `build_apk.py` does not need an Android SDK or a Gradle build.

It is a generic app: no game assets, a placeholder page under `assets/www/`.
`build_apk.py` replaces the placeholder with a real game, rewrites the
manifest (application id + label + orientation) and re-signs the result with
the debug key in `tools/debug/`.

Regenerate it from the Actions tab: **Build template APK → Run workflow**
(pass `game_name`/`app_name` to bake in different defaults, and leave
`commit_apk` enabled to update this file).
