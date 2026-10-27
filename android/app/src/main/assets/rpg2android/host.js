/*
 * rpg2android host overlay.
 *
 * Part of the shell APK, not of the game: MainActivity reads this file from
 * assets/rpg2android/ and evaluates it into the game page once the document is
 * committed. No game file is ever modified, and the same overlay ships with
 * every game built from the template.
 *
 * Three pieces of UI, all floating above the canvas:
 *
 *   - the diagnostics panel: tap the small "i" in the top-right corner, or it
 *     opens by itself after a JS error / a canvas that only paints black. It
 *     has its own ✕ close button. What it sees is kept in a ring buffer and
 *     mirrored to logcat through the RPG2Host bridge (when present).
 *   - the virtual keyboard: tap the keyboard button next to it to open a
 *     translucent US laptop layout (Esc, F1-F12, Ctrl/Alt/Shift/Caps, arrows)
 *     that types into the game, including any focused text field. ✕ closes it,
 *     and the hardware back button closes it too.
 *   - the on-screen pad (keymapper): floating game buttons that send a key to
 *     the game while held. Tap the gamepad button to show/hide them; hold it
 *     to open the editor, where buttons are added, moved, resized, relabelled,
 *     reshaped and deleted, and the layout is stored in localStorage.
 *
 * All three only observe/inject input; the game logic itself is untouched.
 */
(function () {
    "use strict";

    if (window.RPG2Android && window.RPG2Android.__hostLoaded) {
        return;
    }

    var MAX_LINES = 60;
    var PROBE_INTERVAL_MS = 700;
    var REPORT_INTERVAL_MS = 1000;

    var lines = [];
    var panel = null;
    var button = null;
    var panelVisible = false;
    var panelBody = null;
    var reportTimer = null;
    var autoOpened = false;

    var kb = null;
    var kbButton = null;
    var kbVisible = false;
    var kbPointers = {};
    var kbMods = { shift: false, ctrl: false, alt: false, caps: false };
    var kbLock = { shift: false, ctrl: false, alt: false };
    var kbTapAt = { shift: 0, ctrl: 0, alt: 0 };
    var kbModKeys = [];

    var traceLines = [];
    var traceHook = false;
    var focusWarned = false;
    var watchdog = { scene: "", since: 0, fired: false };

    var probe = {
        hooked: false,
        noGl: 0,
        samples: 0,
        lit: 0,
        lastPixels: 0,
        lastAt: 0,
        contextLost: false,
        error: ""
    };

    // ---------------------------------------------------------------- logging

    function stamp() {
        var d = new Date();
        return (
            ("0" + d.getMinutes()).slice(-2) +
            ":" +
            ("0" + d.getSeconds()).slice(-2) +
            "." +
            ("00" + d.getMilliseconds()).slice(-3)
        );
    }

    function forward(kind, text) {
        try {
            if (window.RPG2Host && window.RPG2Host.log) {
                window.RPG2Host.log(kind + ": " + text);
            }
        } catch (e) {
            /* bridge unavailable: on-screen panel is still there */
        }
    }

    function add(kind, text) {
        var line = "[" + stamp() + "] " + kind + " " + text;
        lines.push(line);
        if (lines.length > MAX_LINES) {
            lines.shift();
        }
        forward(kind, text);
        if (panelVisible) {
            renderPanel();
        }
    }

    function trace(text) {
        traceLines.push("[" + stamp() + "] " + text);
        if (traceLines.length > 14) {
            traceLines.shift();
        }
        forward("trace", text);
        if (panelVisible) {
            renderPanel();
        }
    }

    function describe(value) {
        if (value instanceof Error) {
            return value.name + ": " + value.message;
        }
        if (typeof value === "object" && value !== null) {
            try {
                return JSON.stringify(value);
            } catch (e) {
                return String(value);
            }
        }
        return String(value);
    }

    var consoleMethods = ["log", "info", "warn", "error"];
    for (var i = 0; i < consoleMethods.length; i++) {
        (function (method) {
            var original = console[method];
            if (typeof original !== "function") {
                return;
            }
            console[method] = function () {
                var parts = [];
                for (var j = 0; j < arguments.length; j++) {
                    parts.push(describe(arguments[j]));
                }
                var text = parts.join(" ");
                if (method === "error" || method === "warn") {
                    add(method, text.length > 400 ? text.slice(0, 400) + "..." : text);
                }
                return original.apply(console, arguments);
            };
        })(consoleMethods[i]);
    }

    window.addEventListener("error", function (event) {
        if (event && event.target && event.target !== window && event.target.src) {
            add("resfail", String(event.target.src).split("/").slice(-3).join("/"));
            return;
        }
        var where = event && event.filename ? " (" + String(event.filename).split("/").slice(-2).join("/") + ":" + event.lineno + ")" : "";
        add("jsfail", (event && event.message ? event.message : "unknown error") + where);
        showPanel(true);
    }, true);

    window.addEventListener("unhandledrejection", function (event) {
        add("reject", describe(event && event.reason ? event.reason : event));
        showPanel(true);
    });

    // ---------------------------------------------------------------- probing

    function hookGameActive() {
        // MZ only updates the current scene while window.top.document.hasFocus().
        // In an Android WebView that is a race: the page can be fully visible and
        // still report no focus, which freezes the game (audio keeps playing, the
        // canvas keeps rendering the last frame). A visible page is an active
        // game, so treat visibility as the condition.
        var manager = window.SceneManager;
        if (!manager || manager.__r2aGameActive ||
                typeof manager.isGameActive !== "function") {
            return;
        }
        manager.__r2aGameActive = true;
        var original = manager.isGameActive;
        manager.isGameActive = function () {
            try {
                if (document.visibilityState === "hidden") {
                    return false;
                }
                if (original.apply(manager, arguments)) {
                    return true;
                }
                if (document.visibilityState === "visible") {
                    if (!focusWarned) {
                        focusWarned = true;
                        add("warn", "no document focus; keeping the game running while visible");
                    }
                    return true;
                }
                return false;
            } catch (e) {
                return true;
            }
        };
    }

    function hookSceneTrace() {
        var manager = window.SceneManager;
        if (traceHook || !manager || typeof manager.goto !== "function" ||
                typeof window.Scene_Base === "undefined") {
            return;
        }
        traceHook = true;

        var originalGoto = manager.goto;
        manager.goto = function (sceneClass) {
            trace("goto " + (sceneClass && sceneClass.name ? sceneClass.name : "?"));
            return originalGoto.apply(manager, arguments);
        };

        var originalChangeScene = manager.changeScene;
        if (typeof originalChangeScene === "function") {
            manager.changeScene = function () {
                var before = manager._scene ? manager._scene.constructor.name : "-";
                var result = originalChangeScene.apply(manager, arguments);
                var after = manager._scene ? manager._scene.constructor.name : "-";
                if (before !== after) {
                    trace("scene " + before + " -> " + after);
                }
                return result;
            };
        }

        var originalCatch = manager.catchException;
        if (typeof originalCatch === "function") {
            manager.catchException = function (error) {
                add("jsfail", "caught " + describe(error));
                return originalCatch.apply(manager, arguments);
            };
        }

        var base = window.Scene_Base.prototype;
        var originalFadeIn = base.startFadeIn;
        base.startFadeIn = function (duration, white) {
            trace("fadeIn " + this.constructor.name + " d=" + duration);
            return originalFadeIn.apply(this, arguments);
        };
        var originalFadeOut = base.startFadeOut;
        base.startFadeOut = function (duration, white) {
            trace("fadeOut " + this.constructor.name + " d=" + duration);
            return originalFadeOut.apply(this, arguments);
        };
    }

    function runWatchdog() {
        if (watchdog.fired) {
            return;
        }
        var manager = window.SceneManager;
        if (!manager || !manager._scene) {
            return;
        }
        var name = manager._scene.constructor.name || "";
        if (watchdog.scene !== name) {
            watchdog.scene = name;
            watchdog.since = Date.now();
            return;
        }
        if (/splash/i.test(name) && Date.now() - watchdog.since > 25000) {
            watchdog.fired = true;
            add("warn", "watchdog: " + name + " stuck for 25s, forcing Scene_Title");
            if (typeof window.Scene_Title !== "undefined") {
                manager.goto(window.Scene_Title);
            }
        }
    }

    function hookRenderProbe() {
        var G = window.Graphics;
        if (!G || !G._app || probe.hooked) {
            return;
        }
        var app = G._app;
        if (typeof app.render !== "function") {
            return;
        }
        probe.hooked = true;
        var originalRender = app.render;
        app.render = function () {
            var result = originalRender.apply(app, arguments);
            sampleFrame(app);
            return result;
        };
        var canvas = G._canvas;
        if (canvas && canvas.addEventListener) {
            canvas.addEventListener("webglcontextlost", function () {
                probe.contextLost = true;
                add("glfail", "webgl context lost");
                showPanel(true);
            });
        }
        add("info", "renderer hooked");
    }

    function sampleFrame(app) {
        var now = Date.now();
        if (now - probe.lastAt < PROBE_INTERVAL_MS) {
            return;
        }
        probe.lastAt = now;
        try {
            var renderer = app.renderer;
            var gl = renderer && renderer.gl;
            if (!gl) {
                probe.noGl += 1;
                return;
            }
            var width = gl.drawingBufferWidth;
            var height = gl.drawingBufferHeight;
            if (!width || !height) {
                probe.error = "drawingBuffer " + width + "x" + height;
                return;
            }
            var size = 8;
            var buffer = new Uint8Array(4 * size * size);
            var lit = 0;
            var samples = 0;
            for (var gy = 1; gy <= 3; gy++) {
                for (var gx = 1; gx <= 3; gx++) {
                    var x = Math.max(0, Math.floor((width * gx) / 4) - size / 2);
                    var y = Math.max(0, Math.floor((height * gy) / 4) - size / 2);
                    gl.readPixels(x, y, size, size, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
                    samples += size * size;
                    for (var p = 0; p < buffer.length; p += 4) {
                        if (buffer[p] > 8 || buffer[p + 1] > 8 || buffer[p + 2] > 8) {
                            lit += 1;
                        }
                    }
                }
            }
            probe.samples += 1;
            probe.lit += samples > 0 ? lit / samples : 0;
            probe.lastPixels = samples > 0 ? Math.round((lit * 100) / samples) : 0;
        } catch (e) {
            probe.error = describe(e);
        }
    }

    function glInfo() {
        try {
            var renderer = window.Graphics && window.Graphics._app && window.Graphics._app.renderer;
            var gl = renderer && renderer.gl;
            if (!gl) {
                return "gl=none";
            }
            var debug = gl.getExtension("WEBGL_debug_renderer_info");
            var vendor = debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
            var model = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
            return (
                "gl=" + vendor + " / " + model +
                " lost=" + (gl.isContextLost() ? 1 : 0) +
                " buffer=" + gl.drawingBufferWidth + "x" + gl.drawingBufferHeight +
                " maxTex=" + gl.getParameter(gl.MAX_TEXTURE_SIZE)
            );
        } catch (e) {
            return "gl=?" + describe(e);
        }
    }

    function canvasInfo() {
        var canvas = document.getElementById("gameCanvas");
        if (!canvas) {
            return "canvas=missing";
        }
        var style = window.getComputedStyle(canvas);
        var rect = canvas.getBoundingClientRect();
        return (
            "canvas attr=" + canvas.width + "x" + canvas.height +
            " css=" + style.width + "x" + style.height +
            " rect=" + Math.round(rect.left) + "," + Math.round(rect.top) + "," +
            Math.round(rect.width) + "x" + Math.round(rect.height) +
            " opacity=" + style.opacity + " display=" + style.display +
            " z=" + style.zIndex
        );
    }

    function graphicsInfo() {
        var G = window.Graphics;
        if (!G) {
            return "graphics=undefined";
        }
        var type = "?";
        try {
            type = G._app && G._app.renderer ? G._app.renderer.type : "no-app";
        } catch (e) {
            type = "err";
        }
        return (
            "graphics app=" + (G._app ? 1 : 0) +
            " type=" + type +
            " frames=" + (G.frameCount | 0) +
            " realScale=" + (Math.round((G._realScale || 0) * 1000) / 1000) +
            " stretch=" + (G._stretchEnabled ? 1 : 0) +
            " stage=" + (G._app && G._app.stage ? G._app.stage.children.length : -1)
        );
    }

    function viewInfo() {
        var doc = document.documentElement;
        var body = document.body;
        return (
            "view inner=" + window.innerWidth + "x" + window.innerHeight +
            " doc=" + (doc ? doc.clientWidth + "x" + doc.clientHeight : "?") +            "body=" + (body ? body.clientWidth + "x" + body.clientHeight : "?") +
            " dpr=" + (window.devicePixelRatio || 1) +
            " focus=" + (document.hasFocus() ? 1 : 0) +
            " vis=" + document.visibilityState
        );
    }

    function mediaInfo() {
        var videos = document.getElementsByTagName("video");
        if (!videos.length) {
            return "video=none";
        }
        var parts = [];
        for (var i = 0; i < Math.min(videos.length, 3); i++) {
            var v = videos[i];
            parts.push(
                (v.currentSrc || v.src || "?").split("/").pop() +
                " dur=" + (isFinite(v.duration) ? Math.round(v.duration) : "?") +
                " rs=" + v.readyState +
                " paused=" + (v.paused ? 1 : 0) +
                " " + v.videoWidth + "x" + v.videoHeight +
                " vol=" + v.volume + " muted=" + (v.muted ? 1 : 0) +
                " display=" + v.style.display
            );
        }
        return "video " + parts.join(" | ");
    }

    function round(value) {
        if (typeof value !== "number") {
            return String(value);
        }
        return String(Math.round(value * 100) / 100);
    }

    function sceneInfo() {
        try {
            var manager = window.SceneManager;
            if (!manager || !manager._scene) {
                return "scene=none";
            }
            var scene = manager._scene;
            var info = "scene " + scene.constructor.name +
                " children=" + scene.children.length +
                " start=" + (scene.isStarted && scene.isStarted() ? 1 : 0) +
                " active=" + (scene._active ? 1 : 0) +
                " sign=" + (scene._fadeSign | 0) +
                " fadeOp=" + round(scene._fadeOpacity) +
                " fadeDur=" + (scene._fadeDuration | 0) +
                " filter=" + (scene._colorFilter ? 1 : 0) +
                " next=" + (manager._nextScene ? manager._nextScene.constructor.name : "-");
            if (scene._waitTime !== undefined) {
                info += " wait=" + scene._waitTime + " idx=" + scene._splashIndex;
            }
            var splash = scene._originalSplash;
            if (splash) {
                var bitmap = splash.bitmap;
                if (!bitmap) {
                    info += " bmp=none";
                } else {
                    info += " bmp=" + round(bitmap.width) + "x" + round(bitmap.height) +
                        " ready=" + (bitmap.isReady ? (bitmap.isReady() ? 1 : 0) : "?") +
                        " err=" + (bitmap.isError ? (bitmap.isError() ? 1 : 0) : "?") +
                        " op=" + (splash.opacity | 0) +
                        " vis=" + (splash.visible ? 1 : 0);
                }
            }
            return info;
        } catch (e) {
            return "scene=?" + describe(e);
        }
    }

    function errorPrinterInfo() {
        var box = document.getElementById("errorPrinter");
        if (!box) {
            return "errorbox=none";
        }
        var text = (box.innerText || box.textContent || "").replace(/\s+/g, " ").trim();
        return "errorbox=" + (text || "(empty)");
    }

    function audioInfo() {
        try {
            var bits = [];
            if (window.AudioManager) {
                bits.push("bgm=" + (AudioManager._currentBgm ? AudioManager._currentBgm.name : "-"));
                bits.push("me=" + (AudioManager._currentMe ? AudioManager._currentMe.name : "-"));
            }
            if (window.WebAudio) {
                bits.push("ctx=" + (WebAudio._context ? WebAudio._context.state : "?"));
            }
            return "audio " + bits.join(" ");
        } catch (e) {
            return "audio=?" + describe(e);
        }
    }

    function probeInfo() {
        var pct = probe.samples > 0 ? Math.round((probe.lit * 100) / probe.samples) : -1;
        return (
            "paint samples=" + probe.samples +
            " lit=" + pct + "%" +
            (probe.noGl ? " noGl=" + probe.noGl : "") +
            (probe.contextLost ? " CONTEXT_LOST" : "") +
            (probe.error ? " err=" + probe.error : "")
        );
    }

    function errorInfo() {
        var errors = [];
        for (var i = 0; i < lines.length; i++) {
            if (lines[i].indexOf(" jsfail ") > 0 || lines[i].indexOf(" reject ") > 0 ||
                lines[i].indexOf(" resfail ") > 0 || lines[i].indexOf(" glfail ") > 0 ||
                lines[i].indexOf(" error ") > 0 || lines[i].indexOf(" warn ") > 0) {
                errors.push(lines[i]);
            }
        }
        var tail = errors.slice(-6).join("\n             ");
        return "errors " + (errors.length ? "\n             " + tail : "none");
    }

    function padInfo() {
        var count = pad.items ? pad.items.length : 0;
        var selected = pad.selectedId ? findPadItem(pad.selectedId) : null;
        return (
            "pad buttons=" + count +
            " visible=" + (pad.visible ? 1 : 0) +
            " editing=" + (pad.editing ? 1 : 0) +
            " selected=" + (selected ? selected.label + "/" + selected.kc : "-")
        );
    }

    function report() {
        return [
            "url " + String(location.href).split("/").slice(-2).join("/"),
            "ua " + navigator.userAgent,
            viewInfo(),
            canvasInfo(),
            graphicsInfo(),
            errorPrinterInfo(),
            glInfo(),
            probeInfo(),
            sceneInfo(),
            mediaInfo(),
            audioInfo(),
            padInfo(),
            errorInfo(),
            "trace",
            "    " + (traceLines.slice(-10).join("\n    ") || "(empty)"),
            "log",
            "    " + (lines.slice(-10).join("\n    ") || "(empty)")
        ].join("\n");
    }

    // ------------------------------------------------------------------- ui

    function ensureUi() {
        if (button || !document.body) {
            return;
        }

        button = document.createElement("div");
        button.id = "r2aDiagButton";
        button.textContent = "i";
        button.setAttribute("style", [
            "position:fixed", "top:2px", "right:2px", "width:26px", "height:26px",
            "line-height:26px", "text-align:center", "font:bold 15px monospace",
            "color:#9ef", "background:rgba(0,0,0,0.45)", "border:1px solid rgba(158,238,255,0.35)",
            "border-radius:6px", "z-index:2147483646", "opacity:0.55",
            "-webkit-user-select:none", "user-select:none", "touch-action:manipulation"
        ].join(";"));
        button.addEventListener("click", function (event) {
            event.stopPropagation();
            showPanel(!panelVisible);
        });
        button.addEventListener("touchstart", function (event) {
            event.stopPropagation();
        }, { passive: true });
        button.addEventListener("pointerdown", function (event) {
            event.stopPropagation();
        });
        button.addEventListener("mousedown", function (event) {
            event.stopPropagation();
        });

        panel = document.createElement("div");
        panel.id = "r2aDiagPanel";
        panel.setAttribute("style", [
            "position:fixed", "left:0", "right:0", "top:0", "max-height:78vh", "overflow:auto",
            "margin:0", "padding:8px", "box-sizing:border-box",
            "font:10px/1.35 monospace", "color:#b8ffcc", "background:rgba(0,0,0,0.88)",
            "border-bottom:1px solid rgba(184,255,204,0.35)", "white-space:pre-wrap",
            "word-break:break-word", "z-index:2147483647", "display:none",
            "-webkit-user-select:text", "user-select:text"
        ].join(";"));
        panel.addEventListener("click", function (event) {
            event.stopPropagation();
        });
        panel.addEventListener("pointerdown", function (event) {
            event.stopPropagation();
        });
        panel.addEventListener("touchstart", function (event) {
            event.stopPropagation();
        }, { passive: true });
        panel.addEventListener("mousedown", function (event) {
            event.stopPropagation();
        });

        var header = document.createElement("div");
        header.setAttribute("style", [
            "position:sticky", "top:-8px", "display:flex", "align-items:center",
            "justify-content:space-between", "margin:-8px -8px 6px", "padding:5px 8px",
            "background:rgba(0,0,0,0.94)",
            "border-bottom:1px solid rgba(184,255,204,0.25)"
        ].join(";"));

        var title = document.createElement("span");
        title.textContent = "rpg2android diagnostics";
        title.setAttribute("style", "font-weight:bold;letter-spacing:0.5px;color:#b8ffcc");

        var close = document.createElement("div");
        close.id = "r2aDiagClose";
        close.textContent = "\u2715";
        close.setAttribute("style", [
            "width:26px", "height:20px", "line-height:20px", "text-align:center",
            "border-radius:4px", "font:bold 13px/20px monospace", "color:#dff6ff",
            "background:rgba(255,255,255,0.12)",
            "border:1px solid rgba(184,255,204,0.45)", "cursor:pointer"
        ].join(";"));
        close.addEventListener("click", function (event) {
            event.stopPropagation();
            showPanel(false);
        });

        header.appendChild(title);
        header.appendChild(close);

        panelBody = document.createElement("div");
        panel.appendChild(header);
        panel.appendChild(panelBody);

        document.body.appendChild(panel);
        document.body.appendChild(button);
    }

    function renderPanel() {
        if (!panelBody) {
            return;
        }
        panelBody.textContent = report();
    }

    function showPanel(visible) {
        ensureUi();
        if (!panel) {
            return;
        }
        panelVisible = !!visible;
        panel.style.display = panelVisible ? "block" : "none";
        if (button) {
            button.style.opacity = panelVisible ? "0.9" : "0.55";
        }
        if (panelVisible) {
            renderPanel();
            if (!reportTimer) {
                reportTimer = setInterval(function () {
                    hookGameActive();
                    hookRenderProbe();
                    hookSceneTrace();
                    renderPanel();
                }, REPORT_INTERVAL_MS);
            }
        } else if (reportTimer) {
            clearInterval(reportTimer);
            reportTimer = null;
        }
    }

    // --------------------------------------------------------------- keyboard

    var KB_ICON =
        "<svg width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='#9ef' " +
        "stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'>" +
        "<rect x='2' y='6' width='20' height='12' rx='2.2'></rect>" +
        "<path d='M6 10h.01M9 10h.01M12 10h.01M15 10h.01M18 10h.01" +
        "M6 13h.01M9 13h.01M12 13h.01M15 13h.01M18 13h.01M8 16h8'></path></svg>";

    var KB_ROOT_STYLE = [
        "position:fixed", "left:0", "right:0", "bottom:0",
        "height:min(56vh,340px)", "box-sizing:border-box", "padding:4px 6px 10px",
        "display:none", "flex-direction:column", "z-index:2147483645",
        "background:linear-gradient(160deg,rgba(26,52,92,0.62),rgba(74,26,92,0.62) 55%,rgba(18,70,78,0.62))",
        "-webkit-backdrop-filter:blur(8px) saturate(150%)",
        "backdrop-filter:blur(8px) saturate(150%)",
        "border-top:1px solid rgba(150,220,255,0.35)",
        "box-shadow:0 -8px 28px rgba(0,0,0,0.5)",
        "font-family:Roboto,'Segoe UI',system-ui,sans-serif",
        "touch-action:none", "-webkit-user-select:none", "user-select:none"
    ].join(";");

    var KB_KEY_STYLE = [
        "flex:1 1 0", "min-width:0", "position:relative",
        "display:flex", "align-items:center", "justify-content:center",
        "box-sizing:border-box", "margin:0 1px", "padding:0 2px", "border-radius:6px",
        "font-size:clamp(8px,2.1vh,14px)", "font-weight:600", "color:#eaf7ff",
        "background:linear-gradient(180deg,rgba(255,255,255,0.20),rgba(255,255,255,0.06))",
        "border:1px solid rgba(255,255,255,0.28)",
        "box-shadow:inset 0 1px 0 rgba(255,255,255,0.18),0 2px 4px rgba(0,0,0,0.35)",
        "text-shadow:0 1px 2px rgba(0,0,0,0.6)",
        "overflow:hidden", "white-space:nowrap", "touch-action:none"
    ].join(";");

    var KB_KEY_ON =
        ";background:linear-gradient(180deg,rgba(150,235,255,0.70),rgba(70,165,255,0.50));" +
        "color:#04121e;text-shadow:none;border-color:rgba(210,250,255,0.95)";

    function K(label, keyCode, code, key, text, shiftText, grow) {
        return { l: label, kc: keyCode, c: code, k: key || label,
                 t: text, st: shiftText, w: grow || 1 };
    }

    function M(label, keyCode, code, key, mod, grow) {
        return { l: label, kc: keyCode, c: code, k: key || label, mod: mod,
                 w: grow || 1 };
    }

    var KB_ROWS = [
        [K("Esc", 27, "Escape", "Escape", null, null, 1.3),
         K("F1", 112, "F1", "F1", null, null, 0.9),
         K("F2", 113, "F2", "F2", null, null, 0.9),
         K("F3", 114, "F3", "F3", null, null, 0.9),
         K("F4", 115, "F4", "F4", null, null, 0.9),
         K("F5", 116, "F5", "F5", null, null, 0.9),
         K("F6", 117, "F6", "F6", null, null, 0.9),
         K("F7", 118, "F7", "F7", null, null, 0.9),
         K("F8", 119, "F8", "F8", null, null, 0.9),
         K("F9", 120, "F9", "F9", null, null, 0.9),
         K("F10", 121, "F10", "F10", null, null, 0.9),
         K("F11", 122, "F11", "F11", null, null, 0.9),
         K("F12", 123, "F12", "F12", null, null, 0.9),
         K("Del", 46, "Delete", "Delete", null, null, 1.2)],
        [K("`", 192, "Backquote", "`", "`", "~"),
         K("1", 49, "Digit1", "1", "1", "!"),
         K("2", 50, "Digit2", "2", "2", "@"),
         K("3", 51, "Digit3", "3", "3", "#"),
         K("4", 52, "Digit4", "4", "4", "$"),
         K("5", 53, "Digit5", "5", "5", "%"),
         K("6", 54, "Digit6", "6", "6", "^"),
         K("7", 55, "Digit7", "7", "7", "&"),
         K("8", 56, "Digit8", "8", "8", "*"),
         K("9", 57, "Digit9", "9", "9", "("),
         K("0", 48, "Digit0", "0", "0", ")"),
         K("-", 189, "Minus", "-", "-", "_"),
         K("=", 187, "Equal", "=", "=", "+"),
         K("Backspace", 8, "Backspace", "Backspace", null, null, 2.4)],
        [M("Tab", 9, "Tab", "Tab", null, 1.5),
         K("Q", 81, "KeyQ", "q", "q", "Q"),
         K("W", 87, "KeyW", "w", "w", "W"),
         K("E", 69, "KeyE", "e", "e", "E"),
         K("R", 82, "KeyR", "r", "r", "R"),
         K("T", 84, "KeyT", "t", "t", "T"),
         K("Y", 89, "KeyY", "y", "y", "Y"),
         K("U", 85, "KeyU", "u", "u", "U"),
         K("I", 73, "KeyI", "i", "i", "I"),
         K("O", 79, "KeyO", "o", "o", "O"),
         K("P", 80, "KeyP", "p", "p", "P"),
         K("[", 219, "BracketLeft", "[", "[", "{"),
         K("]", 221, "BracketRight", "]", "]", "}"),
         K("\\", 220, "Backslash", "\\", "\\", "|", 1.4)],
        [M("Caps", 20, "CapsLock", "CapsLock", "caps", 1.9),
         K("A", 65, "KeyA", "a", "a", "A"),
         K("S", 83, "KeyS", "s", "s", "S"),
         K("D", 68, "KeyD", "d", "d", "D"),
         K("F", 70, "KeyF", "f", "f", "F"),
         K("G", 71, "KeyG", "g", "g", "G"),
         K("H", 72, "KeyH", "h", "h", "H"),
         K("J", 74, "KeyJ", "j", "j", "J"),
         K("K", 75, "KeyK", "k", "k", "K"),
         K("L", 76, "KeyL", "l", "l", "L"),
         K(";", 186, "Semicolon", ";", ";", ":"),
         K("'", 222, "Quote", "'", "'", "\""),
         M("Enter", 13, "Enter", "Enter", null, 2.3)],
        [M("Shift", 16, "ShiftLeft", "Shift", "shift", 2.5),
         K("Z", 90, "KeyZ", "z", "z", "Z"),
         K("X", 88, "KeyX", "x", "x", "X"),
         K("C", 67, "KeyC", "c", "c", "C"),
         K("V", 86, "KeyV", "v", "v", "V"),
         K("B", 66, "KeyB", "b", "b", "B"),
         K("N", 78, "KeyN", "n", "n", "N"),
         K("M", 77, "KeyM", "m", "m", "M"),
         K(",", 188, "Comma", ",", ",", "<"),
         K(".", 190, "Period", ".", ".", ">"),
         K("/", 191, "Slash", "/", "/", "?"),
         M("Shift", 16, "ShiftRight", "Shift", "shift", 2.5)],
        [M("Ctrl", 17, "ControlLeft", "Control", "ctrl", 1.7),
         M("Alt", 18, "AltLeft", "Alt", "alt", 1.4),
         K("Space", 32, "Space", " ", " ", null, 6),
         M("Alt", 18, "AltRight", "Alt", "alt", 1.4),
         M("Ctrl", 17, "ControlRight", "Control", "ctrl", 1.7),
         K("\u2190", 37, "ArrowLeft", "ArrowLeft"),
         K("\u2191", 38, "ArrowUp", "ArrowUp"),
         K("\u2193", 40, "ArrowDown", "ArrowDown"),
         K("\u2192", 39, "ArrowRight", "ArrowRight")]
    ];

    function defineProp(object, name, value) {
        try {
            Object.defineProperty(object, name, {
                get: function () { return value; },
                configurable: true
            });
        } catch (e) {
            /* not fatal: RPG Maker only reads either keyCode or which */
        }
    }

    function shiftFor(spec) {
        if (kbMods.shift) {
            return true;
        }
        return !!(kbMods.caps && spec.t && /^[a-z]$/.test(spec.t));
    }

    function charFor(spec) {
        if (!spec.t) {
            return spec.k || "";
        }
        var shift = shiftFor(spec);
        if (spec.st) {
            return shift ? spec.st : spec.t;
        }
        if (/^[a-z]$/.test(spec.t)) {
            return shift ? spec.t.toUpperCase() : spec.t;
        }
        return spec.t;
    }

    function keyEvent(type, spec) {
        var event;
        try {
            event = new KeyboardEvent(type, {
                key: charFor(spec),
                code: spec.c || "",
                bubbles: true,
                cancelable: true,
                shiftKey: shiftFor(spec),
                ctrlKey: !!kbMods.ctrl,
                altKey: !!kbMods.alt,
                metaKey: false
            });
        } catch (e) {
            event = document.createEvent("Event");
            event.initEvent(type, true, true);
        }
        defineProp(event, "keyCode", spec.kc);
        defineProp(event, "which", spec.kc);
        return event;
    }

    function focusedEditor() {
        var element = document.activeElement;
        if (!element) {
            return null;
        }
        var tag = (element.tagName || "").toUpperCase();
        if (tag === "INPUT" || tag === "TEXTAREA" || element.isContentEditable) {
            return element;
        }
        return null;
    }

    function fireInput(element, data) {
        var event;
        try {
            event = new InputEvent("input", {
                bubbles: true, cancelable: false, inputType: "insertText",
                data: data || null
            });
        } catch (e) {
            event = document.createEvent("Event");
            event.initEvent("input", true, false);
        }
        try {
            element.dispatchEvent(event);
        } catch (e) {
            /* ignore */
        }
    }

    function editText(element, forward, insert) {
        var tag = (element.tagName || "").toUpperCase();
        var value = element.value;
        if ((tag === "INPUT" || tag === "TEXTAREA") &&
                typeof element.selectionStart === "number") {
            var start = element.selectionStart;
            var end = element.selectionEnd;
            if (insert) {
                element.value = value.slice(0, start) + insert + value.slice(end);
                start += insert.length;
                end = start;
            } else if (start === end) {
                if (forward) {
                    if (end >= value.length) {
                        return;
                    }
                    end += 1;
                } else {
                    if (start === 0) {
                        return;
                    }
                    start -= 1;
                }
                element.value = value.slice(0, start) + value.slice(end);
                end = start;
            } else {
                element.value = value.slice(0, start) + value.slice(end);
                end = start;
            }
            element.selectionStart = start;
            element.selectionEnd = end;
            fireInput(element, insert || "");
            return;
        }
        if (element.isContentEditable && insert) {
            try {
                document.execCommand("insertText", false, insert);
            } catch (e) {
                /* ignore */
            }
            fireInput(element, insert);
        }
    }

    function typeIntoEditor(element, spec) {
        var tag = (element.tagName || "").toUpperCase();
        if (spec.kc === 8) {
            editText(element, false, "");
        } else if (spec.kc === 46) {
            editText(element, true, "");
        } else if (spec.kc === 13) {
            if (tag === "TEXTAREA") {
                editText(element, true, "\n");
            }
        } else if (spec.kc !== 9) {
            var text = charFor(spec);
            if (text && text.length === 1) {
                editText(element, true, text);
                try {
                    element.dispatchEvent(keyEvent("keypress", spec));
                } catch (e) {
                    /* ignore */
                }
            }
        }
    }

    function dispatchModifier(name) {
        var spec;
        if (name === "shift") {
            spec = { kc: 16, c: "ShiftLeft", k: "Shift", l: "Shift", w: 1 };
        } else if (name === "ctrl") {
            spec = { kc: 17, c: "ControlLeft", k: "Control", l: "Ctrl", w: 1 };
        } else {
            spec = { kc: 18, c: "AltLeft", k: "Alt", l: "Alt", w: 1 };
        }
        try {
            document.dispatchEvent(keyEvent(kbMods[name] ? "keydown" : "keyup", spec));
        } catch (e) {
            /* ignore */
        }
    }

    function paintMods() {
        for (var i = 0; i < kbModKeys.length; i++) {
            var entry = kbModKeys[i];
            var on = entry.name === "caps" ? kbMods.caps : kbMods[entry.name];
            var locked = entry.name !== "caps" && kbLock[entry.name];
            entry.el.setAttribute("style", entry.el.__r2aBase +
                (on ? KB_KEY_ON : "") +
                (locked ? ";outline:2px solid rgba(255,214,102,0.95);outline-offset:-2px" : ""));
        }
    }

    function toggleMod(name) {
        if (name === "caps") {
            kbMods.caps = !kbMods.caps;
            paintMods();
            return;
        }
        var now = Date.now();
        if (kbMods[name] && now - kbTapAt[name] < 450) {
            kbLock[name] = !kbLock[name];
            kbMods[name] = true;
        } else {
            kbMods[name] = !kbMods[name];
            kbLock[name] = false;
        }
        kbTapAt[name] = now;
        paintMods();
        dispatchModifier(name);
    }

    function pressKey(spec, element) {
        if (spec.mod) {
            toggleMod(spec.mod);
            return { mod: true };
        }
        var target = focusedEditor() || document;
        var up = keyEvent("keyup", spec);
        try {
            target.dispatchEvent(keyEvent("keydown", spec));
        } catch (e) {
            /* ignore */
        }
        if (target !== document && !kbMods.ctrl && !kbMods.alt) {
            typeIntoEditor(target, spec);
        }
        if (element) {
            element.setAttribute("style", element.__r2aBase + KB_KEY_ON);
        }
        return { up: up, target: target };
    }

    function releaseKey(entry) {
        if (!entry || entry.mod) {
            return;
        }
        if (entry.element) {
            entry.element.setAttribute("style", entry.element.__r2aBase);
        }
        // A one-shot modifier is spent by the key it modified.
        var cleared = false;
        for (var name in kbLock) {
            if (kbMods[name] && !kbLock[name]) {
                kbMods[name] = false;
                dispatchModifier(name);
                cleared = true;
            }
        }
        if (cleared) {
            paintMods();
        }
        // RPG Maker samples input once per frame, so a tap must stay down long
        // enough to be seen by Input.update().
        var delay = Math.max(0, 90 - (Date.now() - entry.at));
        setTimeout(function () {
            try {
                entry.target.dispatchEvent(entry.up);
            } catch (e) {
                /* ignore */
            }
        }, delay);
    }

    function buildKey(spec) {
        var element = document.createElement("div");
        element.__r2aBase = KB_KEY_STYLE + ";flex-grow:" + (spec.w || 1);
        element.setAttribute("style", element.__r2aBase);
        element.textContent = spec.l;
        if (spec.mod) {
            kbModKeys.push({ el: element, name: spec.mod });
        }

        element.addEventListener("pointerdown", function (event) {
            event.preventDefault();
            event.stopPropagation();
            try {
                element.setPointerCapture(event.pointerId);
            } catch (e) {
                /* older WebView */
            }
            var result = pressKey(spec, element);
            kbPointers[event.pointerId] = {
                spec: spec, element: element, up: result.up, target: result.target,
                mod: result.mod, at: Date.now()
            };
        });

        var finish = function (event) {
            event.preventDefault();
            event.stopPropagation();
            var entry = kbPointers[event.pointerId];
            if (!entry || entry.element !== element) {
                return;
            }
            delete kbPointers[event.pointerId];
            releaseKey(entry);
        };
        element.addEventListener("pointerup", finish);
        element.addEventListener("pointercancel", finish);
        element.addEventListener("contextmenu", function (event) {
            event.preventDefault();
        });
        return element;
    }

    function buildKeyboard() {
        var root = document.createElement("div");
        root.id = "r2aKeyboard";
        root.setAttribute("style", KB_ROOT_STYLE);

        var head = document.createElement("div");
        head.setAttribute("style", [
            "flex:0 0 auto", "display:flex", "align-items:center",
            "justify-content:space-between", "height:18px", "padding:0 2px 3px",
            "font:10px/18px Roboto,system-ui,sans-serif",
            "color:rgba(200,240,255,0.85)", "letter-spacing:1px"
        ].join(";"));

        var caption = document.createElement("span");
        caption.textContent = "VIRTUAL KEYBOARD";

        var close = document.createElement("div");
        close.id = "r2aKbClose";
        close.textContent = "\u2715";
        close.setAttribute("style", [
            "width:26px", "height:18px", "line-height:18px", "text-align:center",
            "border-radius:4px", "font:bold 13px/18px Roboto,system-ui,sans-serif",
            "color:#dff6ff", "background:rgba(0,0,0,0.35)",
            "border:1px solid rgba(255,255,255,0.35)"
        ].join(";"));
        close.addEventListener("click", function (event) {
            event.stopPropagation();
            showKeyboard(false);
        });

        head.appendChild(caption);
        head.appendChild(close);
        root.appendChild(head);

        var body = document.createElement("div");
        body.setAttribute("style", "flex:1 1 auto;display:flex;flex-direction:column;min-height:0;gap:3px");
        for (var r = 0; r < KB_ROWS.length; r++) {
            var row = document.createElement("div");
            row.setAttribute("style", "flex:1 1 0;display:flex;min-height:0");
            for (var c = 0; c < KB_ROWS[r].length; c++) {
                row.appendChild(buildKey(KB_ROWS[r][c]));
            }
            body.appendChild(row);
        }
        root.appendChild(body);

        // Taps on the keyboard must never reach the game's touch handlers.
        var swallow = function (event) {
            event.stopPropagation();
        };
        root.addEventListener("touchstart", swallow, { passive: true });
        root.addEventListener("touchmove", swallow, { passive: true });
        root.addEventListener("touchend", swallow, { passive: true });
        root.addEventListener("mousedown", swallow);
        root.addEventListener("pointerdown", function (event) {
            if (event.target === root) {
                event.preventDefault();
            }
            event.stopPropagation();
        });
        root.addEventListener("contextmenu", function (event) {
            event.preventDefault();
        });

        return root;
    }

    function ensureKeyboard() {
        if (kbButton || !document.body) {
            return;
        }
        kbButton = document.createElement("div");
        kbButton.id = "r2aKbButton";
        kbButton.innerHTML = KB_ICON;
        kbButton.setAttribute("style", [
            "position:fixed", "top:2px", "right:34px", "width:28px", "height:26px",
            "display:flex", "align-items:center", "justify-content:center",
            "background:rgba(0,0,0,0.45)", "border:1px solid rgba(158,238,255,0.35)",
            "border-radius:6px", "z-index:2147483646", "opacity:0.55",
            "-webkit-user-select:none", "user-select:none", "touch-action:manipulation"
        ].join(";"));
        // Toggle on pointerdown: preventing the default there suppresses the
        // synthetic click, and it also keeps the game from seeing the tap.
        kbButton.addEventListener("pointerdown", function (event) {
            event.preventDefault();
            event.stopPropagation();
            showKeyboard(!kbVisible);
        });
        document.body.appendChild(kbButton);
    }

    function showKeyboard(visible) {
        ensureKeyboard();
        if (visible && !kb) {
            kb = buildKeyboard();
            document.body.appendChild(kb);
            paintMods();
        }
        kbVisible = !!visible;
        if (kb) {
            kb.style.display = kbVisible ? "flex" : "none";
        }
        if (kbButton) {
            kbButton.style.opacity = kbVisible ? "0.95" : "0.55";
            kbButton.style.background = kbVisible
                ? "rgba(120,220,255,0.28)"
                : "rgba(0,0,0,0.45)";
            kbButton.style.borderColor = kbVisible
                ? "rgba(200,245,255,0.9)"
                : "rgba(158,238,255,0.35)";
        }
    }

    // ------------------------------------------------------------- on-screen pad

    var PAD_STORE = "r2a.controls.v1";

    var PAD_ICON =
        "<svg width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='#9ef' " +
        "stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'>" +
        "<path d='M7 8.5h10a4 4 0 0 1 3.9 3.1l.8 3.9a2.3 2.3 0 0 1-4.1 1.8L16 15.5H8l-1.6 1.8a2.3 2.3 0 0 1-4.1-1.8l.8-3.9A4 4 0 0 1 7 8.5z'></path>" +
        "<path d='M8.6 11.4v2M7.6 12.4h2'></path>" +
        "<circle cx='15.6' cy='11.6' r='.85' fill='#9ef' stroke='none'></circle>" +
        "<circle cx='17.2' cy='13.4' r='.85' fill='#9ef' stroke='none'></circle></svg>";

    var PAD_BASE_STYLE = [
        "position:absolute", "transform:translate(-50%,-50%)", "box-sizing:border-box",
        "display:flex", "align-items:center", "justify-content:center", "pointer-events:auto",
        "color:#eaf7ff", "font-family:Roboto,'Segoe UI',system-ui,sans-serif",
        "font-weight:700", "letter-spacing:0.5px", "text-shadow:0 1px 2px rgba(0,0,0,0.65)",
        "white-space:nowrap", "overflow:hidden", "touch-action:none",
        "-webkit-user-select:none", "user-select:none", "-webkit-tap-highlight-color:transparent",
        "background:linear-gradient(180deg,rgba(150,205,255,0.42),rgba(60,110,190,0.34))",
        "border:1.5px solid rgba(215,240,255,0.6)",
        "box-shadow:inset 0 1px 0 rgba(255,255,255,0.26),0 3px 10px rgba(0,0,0,0.35)",
        "-webkit-backdrop-filter:blur(2px)", "backdrop-filter:blur(2px)"
    ].join(";");

    var PAD_PRESSED_STYLE =
        ";background:linear-gradient(180deg,rgba(165,240,255,0.88),rgba(70,170,255,0.66));" +
        "color:#04121e;text-shadow:none;border-color:rgba(232,252,255,0.95)";

    var PAD_SELECTED_STYLE =
        ";outline:2px dashed rgba(120,235,255,0.95);outline-offset:2px";

    var PAD_GRIP_STYLE = [
        "position:absolute", "right:-9px", "bottom:-9px", "width:20px", "height:20px",
        "border-radius:50%", "background:rgba(130,235,255,0.95)",
        "border:1.5px solid #04202c", "box-shadow:0 1px 5px rgba(0,0,0,0.55)",
        "display:none", "box-sizing:border-box", "touch-action:none"
    ].join(";");

    var pad = {
        items: null,
        visible: true,
        editing: false,
        selectedId: null,
        root: null,
        backdrop: null,
        bar: null,
        panel: null,
        panelBody: null,
        panelTitle: null,
        button: null,
        els: {},
        drag: null,
        presses: {},
        sizeSlider: null,
        seq: 1
    };

    function padViewport() {
        var doc = document.documentElement;
        var w = window.innerWidth || (doc && doc.clientWidth) || 0;
        var h = window.innerHeight || (doc && doc.clientHeight) || 0;
        return { w: w > 0 ? w : 1, h: h > 0 ? h : 1 };
    }

    function padViewportReady() {
        // A WebView that reports 0x0 during boot would turn the default sizes
        // into full-screen buttons, and they would be saved that way.
        var v = padViewport();
        return Math.min(v.w, v.h) >= 64;
    }

    function clamp(value, low, high) {
        return value < low ? low : value > high ? high : value;
    }

    function findPadItem(id) {
        if (!pad.items) {
            return null;
        }
        for (var i = 0; i < pad.items.length; i++) {
            if (pad.items[i].id === id) {
                return pad.items[i];
            }
        }
        return null;
    }

    function padKeys() {
        var rows = [
            ["Esc", 27, "Escape", "Escape"],
            ["Tab", 9, "Tab", "Tab"],
            ["Enter", 13, "Enter", "Enter"],
            ["Space", 32, "Space", " "],
            ["Backspace", 8, "Backspace", "Backspace"],
            ["Delete", 46, "Delete", "Delete"],
            ["Shift", 16, "ShiftLeft", "Shift"],
            ["Ctrl", 17, "ControlLeft", "Control"],
            ["Alt", 18, "AltLeft", "Alt"],
            ["Up", 38, "ArrowUp", "ArrowUp"],
            ["Down", 40, "ArrowDown", "ArrowDown"],
            ["Left", 37, "ArrowLeft", "ArrowLeft"],
            ["Right", 39, "ArrowRight", "ArrowRight"]
        ];
        var keys = [];
        var i;
        for (i = 0; i < rows.length; i++) {
            keys.push({ l: rows[i][0], kc: rows[i][1], c: rows[i][2], k: rows[i][3] });
        }
        for (i = 65; i <= 90; i++) {
            var letter = String.fromCharCode(i);
            keys.push({ l: letter, kc: i, c: "Key" + letter, k: letter.toLowerCase() });
        }
        for (i = 48; i <= 57; i++) {
            keys.push({ l: String(i), kc: i, c: "Digit" + i, k: String(i) });
        }
        for (i = 1; i <= 12; i++) {
            keys.push({ l: "F" + i, kc: 111 + i, c: "F" + i, k: "F" + i });
        }
        return keys;
    }

    function padSpec(item) {
        var spec = { kc: item.kc, c: item.code, k: item.key, l: item.label };
        if (typeof item.key === "string" && item.key.length === 1) {
            spec.t = item.key;
            spec.st = item.key.toUpperCase();
        }
        return spec;
    }

    // ------------------------------------------------------- pad: persistence

    function savePad() {
        try {
            localStorage.setItem(PAD_STORE, JSON.stringify({
                visible: pad.visible,
                items: pad.items || []
            }));
        } catch (e) {
            add("warn", "cannot save the on-screen buttons: " + describe(e));
        }
    }

    function sanitizePadItem(raw) {
        if (!raw || typeof raw !== "object") {
            return null;
        }
        var kc = parseInt(raw.kc, 10);
        if (!isFinite(kc)) {
            return null;
        }
        var item = {
            id: "b" + pad.seq++,
            label: typeof raw.label === "string" && raw.label.length ? raw.label.slice(0, 8) : "?",
            kc: kc,
            code: typeof raw.code === "string" ? raw.code : "",
            key: typeof raw.key === "string" ? raw.key : "",
            x: clamp(parseFloat(raw.x) || 0.5, 0, 1),
            y: clamp(parseFloat(raw.y) || 0.5, 0, 1),
            w: clamp(parseFloat(raw.w) || 0.1, 0.01, 1),
            h: clamp(parseFloat(raw.h) || 0.1, 0.01, 1),
            shape: raw.shape === "round" || raw.shape === "square" || raw.shape === "pill"
                ? raw.shape : "circle",
            op: clamp(parseFloat(raw.op) || 0.62, 0.1, 1)
        };
        return item;
    }

    function loadPad() {
        try {
            var raw = localStorage.getItem(PAD_STORE);
            if (!raw) {
                return null;
            }
            var data = JSON.parse(raw);
            if (!data || !data.items || !data.items.length) {
                return null;
            }
            var items = [];
            for (var i = 0; i < data.items.length; i++) {
                var item = sanitizePadItem(data.items[i]);
                if (item) {
                    items.push(item);
                }
            }
            if (!items.length) {
                return null;
            }
            pad.visible = data.visible !== false;
            return items;
        } catch (e) {
            add("warn", "cannot read the on-screen buttons: " + describe(e));
            return null;
        }
    }

    function padDefaultLayout() {
        var v = padViewport();
        var s = Math.min(v.w, v.h);
        var size = Math.max(44, Math.round(s * 0.16));
        var margin = Math.round(s * 0.05);
        var cx = margin + size * 1.45;
        var cy = v.h - margin - size * 1.45;
        var items = [];

        function push(label, kc, code, key, px, py) {
            items.push({
                id: "b" + pad.seq++,
                label: label, kc: kc, code: code, key: key,
                x: px / v.w, y: py / v.h,
                w: size / v.w, h: size / v.h,
                shape: "circle", op: 0.62
            });
        }

        push("\u25B2", 38, "ArrowUp", "ArrowUp", cx, cy - size * 0.98);
        push("\u25C0", 37, "ArrowLeft", "ArrowLeft", cx - size * 0.98, cy);
        push("\u25B6", 39, "ArrowRight", "ArrowRight", cx + size * 0.98, cy);
        push("\u25BC", 40, "ArrowDown", "ArrowDown", cx, cy + size * 0.98);
        push("OK", 90, "KeyZ", "z", v.w - margin - size * 0.95, v.h - margin - size * 1.45);
        push("X", 88, "KeyX", "x", v.w - margin - size * 2.05, v.h - margin - size * 0.5);
        return items;
    }

    // ------------------------------------------------------------ pad: render

    function padRadius(item) {
        if (item.shape === "circle") {
            return "50%";
        }
        if (item.shape === "square") {
            return "7%";
        }
        if (item.shape === "pill") {
            return "999px";
        }
        return "22%";
    }

    function placePadButton(item, el) {
        if (!el) {
            return;
        }
        var v = padViewport();
        var px = Math.min(item.w * v.w, item.h * v.h);
        el.style.left = (item.x * 100).toFixed(3) + "%";
        el.style.top = (item.y * 100).toFixed(3) + "%";
        el.style.width = (item.w * 100).toFixed(3) + "%";
        el.style.height = (item.h * 100).toFixed(3) + "%";
        el.style.borderRadius = padRadius(item);
        el.style.fontSize = Math.max(9, Math.round(px * 0.3)) + "px";
        el.style.opacity = String(pad.editing ? Math.max(item.op, 0.9) : item.op);
        if (el.__r2aLabel) {
            el.__r2aLabel.textContent = item.label;
        }
        if (el.__r2aGrip) {
            el.__r2aGrip.style.display =
                pad.editing && pad.selectedId === item.id ? "block" : "none";
        }
    }

    function paintPad(item, el, pressed) {
        if (!el) {
            return;
        }
        var style = el.__r2aBase;
        if (pressed) {
            style += PAD_PRESSED_STYLE;
        }
        if (pad.editing && pad.selectedId === item.id) {
            style += PAD_SELECTED_STYLE;
        }
        el.setAttribute("style", style);
        placePadButton(item, el);
    }

    function selectPadItem(id) {
        pad.selectedId = id;
        for (var i = 0; i < pad.items.length; i++) {
            var item = pad.items[i];
            paintPad(item, pad.els[item.id], false);
        }
        renderInspector();
    }

    function startPadPress(item, el, event) {
        var spec = padSpec(item);
        var target = focusedEditor() || document;
        var entry = {
            el: el, item: item, target: target, spec: spec,
            up: keyEvent("keyup", spec), at: Date.now()
        };
        try {
            target.dispatchEvent(keyEvent("keydown", spec));
        } catch (e) {
            /* ignore */
        }
        paintPad(item, el, true);
        pad.presses[event.pointerId] = entry;
        try {
            el.setPointerCapture(event.pointerId);
        } catch (e) {
            /* older WebView */
        }
    }

    function endPadPress(event) {
        var entry = pad.presses[event.pointerId];
        if (!entry) {
            return false;
        }
        delete pad.presses[event.pointerId];
        paintPad(entry.item, entry.el, false);
        // RPG Maker samples the input once per frame, so a quick tap has to
        // stay down long enough for Input.update() to see it.
        var delay = Math.max(0, 90 - (Date.now() - entry.at));
        setTimeout(function () {
            try {
                entry.target.dispatchEvent(entry.up);
            } catch (e) {
                /* ignore */
            }
        }, delay);
        return true;
    }

    function padDragMove(event) {
        var drag = pad.drag;
        if (!drag) {
            return;
        }
        var item = drag.item;
        var v = padViewport();
        var dx = event.clientX - drag.sx;
        var dy = event.clientY - drag.sy;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
            drag.moved = true;
        }
        if (drag.kind === "move") {
            item.x = clamp(drag.x + dx / v.w, 0.02, 0.98);
            item.y = clamp(drag.y + dy / v.h, 0.02, 0.98);
        } else {
            // The button is centred, so the corner handle moves both edges.
            item.w = clamp(drag.w + (dx * 2) / v.w, 34 / v.w, 0.9);
            item.h = clamp(drag.h + (dy * 2) / v.h, 34 / v.h, 0.9);
            if (item.shape === "circle") {
                var size = Math.max(item.w * v.w, item.h * v.h);
                item.w = size / v.w;
                item.h = size / v.h;
            }
        }
        paintPad(item, pad.els[item.id], false);
        syncSizeSlider(item);
    }

    function endPadDrag(event) {
        var drag = pad.drag;
        if (!drag || (event && drag.pointerId !== event.pointerId)) {
            return;
        }
        pad.drag = null;
        if (drag.moved) {
            savePad();
        }
    }

    function buildPadButton(item) {
        var el = document.createElement("div");
        el.className = "r2aPadButton";
        el.setAttribute("data-r2a-id", item.id);
        el.__r2aBase = PAD_BASE_STYLE;
        el.setAttribute("style", el.__r2aBase);

        var label = document.createElement("span");
        label.setAttribute("style", "pointer-events:none");
        el.__r2aLabel = label;
        el.appendChild(label);

        var grip = document.createElement("div");
        grip.setAttribute("style", PAD_GRIP_STYLE);
        el.__r2aGrip = grip;
        el.appendChild(grip);

        grip.addEventListener("pointerdown", function (event) {
            if (!pad.editing) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            pad.drag = {
                kind: "resize", id: item.id, item: item, el: el,
                sx: event.clientX, sy: event.clientY,
                x: item.x, y: item.y, w: item.w, h: item.h,
                pointerId: event.pointerId, moved: false
            };
            try {
                el.setPointerCapture(event.pointerId);
            } catch (e) {
                /* older WebView */
            }
        });

        el.addEventListener("pointerdown", function (event) {
            event.preventDefault();
            event.stopPropagation();
            if (!pad.editing) {
                startPadPress(item, el, event);
                return;
            }
            selectPadItem(item.id);
            pad.drag = {
                kind: "move", id: item.id, item: item, el: el,
                sx: event.clientX, sy: event.clientY,
                x: item.x, y: item.y, w: item.w, h: item.h,
                pointerId: event.pointerId, moved: false
            };
            try {
                el.setPointerCapture(event.pointerId);
            } catch (e) {
                /* older WebView */
            }
        });

        el.addEventListener("pointermove", function (event) {
            if (!pad.drag || pad.drag.pointerId !== event.pointerId) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            padDragMove(event);
        });

        var finish = function (event) {
            if (!pad.editing) {
                if (endPadPress(event)) {
                    event.preventDefault();
                    event.stopPropagation();
                }
                return;
            }
            endPadDrag(event);
        };
        el.addEventListener("pointerup", finish);
        el.addEventListener("pointercancel", finish);
        el.addEventListener("contextmenu", function (event) {
            event.preventDefault();
        });
        return el;
    }

    function renderPad() {
        ensurePad();
        if (!pad.root || !pad.items) {
            return;
        }
        renderPadNow();
    }

    function renderPadNow() {
        while (pad.root.firstChild) {
            pad.root.removeChild(pad.root.firstChild);
        }
        pad.els = {};
        for (var i = 0; i < pad.items.length; i++) {
            var item = pad.items[i];
            var el = buildPadButton(item);
            pad.els[item.id] = el;
            pad.root.appendChild(el);
            paintPad(item, el, false);
        }
        pad.root.style.display = pad.visible ? "block" : "none";
        if (pad.button) {
            paintPadButtonState();
        }
    }

    function ensurePad() {
        if (pad.root || !document.body || !padViewportReady()) {
            return;
        }
        var root = document.createElement("div");
        root.id = "r2aPad";
        root.setAttribute("style", [
            "position:fixed", "left:0", "top:0", "right:0", "bottom:0",
            "z-index:2147483643", "pointer-events:none"
        ].join(";"));
        // The game must never see a tap that belongs to an on-screen button.
        var swallow = function (event) {
            event.stopPropagation();
        };
        root.addEventListener("touchstart", swallow, { passive: true });
        root.addEventListener("touchmove", swallow, { passive: true });
        root.addEventListener("touchend", swallow, { passive: true });
        root.addEventListener("mousedown", swallow);
        document.body.appendChild(root);
        pad.root = root;

        if (!pad.items) {
            pad.items = loadPad();
            if (!pad.items) {
                pad.items = padDefaultLayout();
                savePad();
            }
        }
        renderPadNow();
    }

    // ------------------------------------------------------------ pad: editor

    function chromeButton(text, onClick, accent) {
        var el = document.createElement("div");
        el.textContent = text;
        el.setAttribute("style", [
            "height:28px", "padding:0 11px", "display:flex", "align-items:center",
            "border-radius:6px", "box-sizing:border-box",
            "font:600 11px/26px Roboto,system-ui,sans-serif", "letter-spacing:0.5px",
            "color:" + (accent ? "#04121e" : "#dff6ff"),
            "background:" + (accent ? "rgba(130,225,255,0.92)" : "rgba(120,200,255,0.16)"),
            "border:1px solid rgba(170,230,255,0.6)",
            "-webkit-user-select:none", "user-select:none", "touch-action:none"
        ].join(";"));
        el.addEventListener("pointerdown", function (event) {
            event.preventDefault();
            event.stopPropagation();
            onClick(event);
        });
        return el;
    }

    function ensureMapperChrome() {
        if (!document.body) {
            return;
        }
        if (!pad.backdrop) {
            var backdrop = document.createElement("div");
            backdrop.id = "r2aPadBackdrop";
            backdrop.setAttribute("style", [
                "position:fixed", "left:0", "top:0", "right:0", "bottom:0",
                "z-index:2147483642", "display:none",
                "background-color:rgba(6,12,22,0.55)",
                "background-image:linear-gradient(rgba(120,200,255,0.16) 1px,transparent 1px)," +
                    "linear-gradient(90deg,rgba(120,200,255,0.16) 1px,transparent 1px)",
                "background-size:32px 32px,32px 32px",
                "touch-action:none"
            ].join(";"));
            backdrop.addEventListener("pointerdown", function (event) {
                event.preventDefault();
                event.stopPropagation();
                selectPadItem(null);
            });
            backdrop.addEventListener("touchstart", function (event) {
                event.stopPropagation();
            }, { passive: true });
            document.body.appendChild(backdrop);
            pad.backdrop = backdrop;
        }

        if (!pad.bar) {
            var bar = document.createElement("div");
            bar.id = "r2aPadBar";
            bar.setAttribute("style", [
                "position:fixed", "left:0", "right:0", "top:0", "height:46px",
                "display:none", "align-items:center", "justify-content:space-between",
                "gap:8px", "padding:0 8px", "box-sizing:border-box",
                "background:rgba(8,14,26,0.95)",
                "border-bottom:1px solid rgba(120,215,255,0.45)",
                "box-shadow:0 4px 14px rgba(0,0,0,0.5)",
                "z-index:2147483646", "font-family:Roboto,system-ui,sans-serif",
                "color:#dff6ff", "touch-action:none"
            ].join(";"));
            bar.addEventListener("pointerdown", function (event) {
                event.stopPropagation();
            });
            bar.addEventListener("touchstart", function (event) {
                event.stopPropagation();
            }, { passive: true });

            var titles = document.createElement("div");
            titles.setAttribute("style", "display:flex;flex-direction:column;min-width:0");
            var heading = document.createElement("span");
            heading.textContent = "ON-SCREEN BUTTONS";
            heading.setAttribute("style", "font:700 11px/1.2 Roboto,system-ui,sans-serif;letter-spacing:1px");
            var hint = document.createElement("span");
            hint.id = "r2aPadHint";
            hint.textContent = "drag to move \u00b7 corner to resize \u00b7 tap to edit";
            hint.setAttribute("style", "font:9px/1.2 Roboto,system-ui,sans-serif;color:rgba(180,215,245,0.7);white-space:nowrap;overflow:hidden;text-overflow:ellipsis");
            titles.appendChild(heading);
            titles.appendChild(hint);

            var actions = document.createElement("div");
            actions.setAttribute("style", "display:flex;align-items:center;gap:6px;flex:0 0 auto");
            actions.appendChild(chromeButton("+ ADD", function () {
                addPadItem();
            }));
            actions.appendChild(chromeButton("DONE", function () {
                closeMapper();
            }, true));

            bar.appendChild(titles);
            bar.appendChild(actions);
            document.body.appendChild(bar);
            pad.bar = bar;
        }

        if (!pad.panel) {
            var panel = document.createElement("div");
            panel.id = "r2aPadPanel";
            panel.setAttribute("style", [
                "position:fixed", "left:0", "right:0", "bottom:0", "max-height:52vh",
                "display:none", "box-sizing:border-box", "padding:0 10px 12px",
                "overflow:auto", "background:rgba(8,14,26,0.96)",
                "border-top:1px solid rgba(120,215,255,0.45)",
                "box-shadow:0 -6px 20px rgba(0,0,0,0.55)",
                "z-index:2147483646", "font-family:Roboto,system-ui,sans-serif",
                "color:#dff6ff"
            ].join(";"));
            panel.addEventListener("pointerdown", function (event) {
                event.stopPropagation();
            });
            panel.addEventListener("touchstart", function (event) {
                event.stopPropagation();
            }, { passive: true });

            var head = document.createElement("div");
            head.setAttribute("style", [
                "position:sticky", "top:0", "display:flex", "align-items:center",
                "justify-content:space-between", "margin:0 -10px 8px", "padding:6px 10px",
                "background:rgba(8,14,26,0.98)",
                "border-bottom:1px solid rgba(120,215,255,0.25)"
            ].join(";"));
            var panelTitle = document.createElement("span");
            panelTitle.textContent = "BUTTON";
            panelTitle.setAttribute("style", "font:700 10px/1.2 Roboto,system-ui,sans-serif;letter-spacing:1px;color:rgba(200,235,255,0.9)");
            pad.panelTitle = panelTitle;
            var collapse = chromeButton("\u2715", function () {
                selectPadItem(null);
            });
            collapse.id = "r2aPadPanelClose";
            collapse.setAttribute("style", collapse.getAttribute("style") + ";padding:0 9px");
            head.appendChild(panelTitle);
            head.appendChild(collapse);

            var body = document.createElement("div");
            pad.panelBody = body;

            panel.appendChild(head);
            panel.appendChild(body);
            document.body.appendChild(panel);
            pad.panel = panel;
        }
    }

    function panelRow(labelText, control) {
        var row = document.createElement("div");
        row.setAttribute("style", "display:flex;align-items:center;gap:8px;margin:0 0 9px");
        var label = document.createElement("div");
        label.textContent = labelText;
        label.setAttribute("style", [
            "flex:0 0 58px", "font:600 9px/1.2 Roboto,system-ui,sans-serif",
            "letter-spacing:0.7px", "text-transform:uppercase",
            "color:rgba(180,220,250,0.75)"
        ].join(";"));
        row.appendChild(label);
        row.appendChild(control);
        return row;
    }

    function fieldStyle() {
        return [
            "flex:1 1 auto", "min-width:0", "height:30px", "box-sizing:border-box",
            "padding:0 8px", "border-radius:6px",
            "border:1px solid rgba(170,230,255,0.45)",
            "background:rgba(255,255,255,0.09)", "color:#eaf7ff",
            "font:600 13px/28px Roboto,system-ui,sans-serif"
        ].join(";");
    }

    function chipStyle(active) {
        return [
            "flex:1 1 0", "height:30px", "display:flex", "align-items:center",
            "justify-content:center", "border-radius:6px", "box-sizing:border-box",
            "font:600 9.5px/1 Roboto,system-ui,sans-serif", "letter-spacing:0.5px",
            "color:" + (active ? "#04121e" : "#dff6ff"),
            "background:" + (active ? "rgba(130,225,255,0.92)" : "rgba(255,255,255,0.07)"),
            "border:1px solid " + (active ? "rgba(220,250,255,0.95)" : "rgba(170,230,255,0.4)"),
            "-webkit-user-select:none", "user-select:none"
        ].join(";");
    }

    function syncSizeSlider(item) {
        if (!pad.sizeSlider || !item) {
            return;
        }
        var v = padViewport();
        var px = Math.round(item.w * v.w);
        pad.sizeSlider.value = String(px);
        pad.sizeSlider.__r2aValue.textContent = px + "px";
    }

    function renderInspector() {
        ensureMapperChrome();
        if (!pad.panel) {
            return;
        }
        var item = pad.selectedId ? findPadItem(pad.selectedId) : null;
        pad.panelBody.textContent = "";
        pad.sizeSlider = null;
        if (!item) {
            pad.panel.style.display = "none";
            return;
        }
        pad.panel.style.display = "block";
        pad.panelTitle.textContent = "BUTTON \u00b7 " + item.label;

        var labelInput = document.createElement("input");
        labelInput.id = "r2aPadLabel";
        labelInput.type = "text";
        labelInput.maxLength = 8;
        labelInput.value = item.label;
        labelInput.setAttribute("style", fieldStyle());
        labelInput.addEventListener("input", function () {
            item.label = (labelInput.value || "?").slice(0, 8);
            placePadButton(item, pad.els[item.id]);
            pad.panelTitle.textContent = "BUTTON \u00b7 " + item.label;
            savePad();
        });
        pad.panelBody.appendChild(panelRow("Label", labelInput));

        var keySelect = document.createElement("select");
        keySelect.id = "r2aPadKey";
        keySelect.setAttribute("style", fieldStyle() + ";padding:0 4px");
        var keys = padKeys();
        for (var i = 0; i < keys.length; i++) {
            var option = document.createElement("option");
            option.value = String(keys[i].kc);
            option.textContent = keys[i].l;
            keySelect.appendChild(option);
        }
        keySelect.value = String(item.kc);
        keySelect.addEventListener("change", function () {
            var table = padKeys();
            for (var k = 0; k < table.length; k++) {
                if (String(table[k].kc) === keySelect.value) {
                    item.kc = table[k].kc;
                    item.code = table[k].c;
                    item.key = table[k].k;
                    break;
                }
            }
            savePad();
        });
        pad.panelBody.appendChild(panelRow("Key", keySelect));

        var bolts = document.createElement("div");
        bolts.setAttribute("style", "display:flex;gap:6px;flex:1 1 auto");
        var shapes = [
            { id: "circle", label: "CIRCLE" },
            { id: "round", label: "ROUND" },
            { id: "square", label: "SQUARE" },
            { id: "pill", label: "PILL" }
        ];
        for (var s = 0; s < shapes.length; s++) {
            (function (shape) {
                var chip = document.createElement("div");
                chip.setAttribute("data-r2a-shape", shape.id);
                chip.textContent = shape.label;
                chip.setAttribute("style", chipStyle(item.shape === shape.id));
                chip.addEventListener("pointerdown", function (event) {
                    event.preventDefault();
                    event.stopPropagation();
                    item.shape = shape.id;
                    if (shape.id === "circle") {
                        var v = padViewport();
                        var size = Math.max(item.w * v.w, item.h * v.h);
                        item.w = size / v.w;
                        item.h = size / v.h;
                    }
                    for (var c = 0; c < bolts.children.length; c++) {
                        var other = bolts.children[c];
                        other.setAttribute("style",
                            chipStyle(other.getAttribute("data-r2a-shape") === item.shape));
                    }
                    paintPad(item, pad.els[item.id], false);
                    savePad();
                });
                bolts.appendChild(chip);
            })(shapes[s]);
        }
        pad.panelBody.appendChild(panelRow("Shape", bolts));

        var size = document.createElement("input");
        size.id = "r2aPadSize";
        size.type = "range";
        size.min = "28";
        size.max = "300";
        size.step = "2";
        var viewport = padViewport();
        var sizeValue = document.createElement("span");
        sizeValue.setAttribute("style", "flex:0 0 42px;text-align:right;font:600 11px/1 Roboto,system-ui,sans-serif;color:rgba(190,225,255,0.85)");
        size.setAttribute("style", "flex:1 1 auto;min-width:0;accent-color:#7fdcff");
        size.value = String(Math.round(item.w * viewport.w));
        sizeValue.textContent = Math.round(item.w * viewport.w) + "px";
        size.__r2aValue = sizeValue;
        size.addEventListener("input", function () {
            var v = padViewport();
            var target = Math.max(28, parseInt(size.value, 10) || 28);
            var factor = target / Math.max(1, item.w * v.w);
            item.w = clamp(item.w * factor, 28 / v.w, 0.9);
            item.h = clamp(item.h * factor, 28 / v.h, 0.9);
            placePadButton(item, pad.els[item.id]);
            sizeValue.textContent = target + "px";
            savePad();
        });
        pad.sizeSlider = size;
        var sizeWrap = document.createElement("div");
        sizeWrap.setAttribute("style", "display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0");
        sizeWrap.appendChild(size);
        sizeWrap.appendChild(sizeValue);
        pad.panelBody.appendChild(panelRow("Size", sizeWrap));

        var opacity = document.createElement("input");
        opacity.id = "r2aPadOpacity";
        opacity.type = "range";
        opacity.min = "15";
        opacity.max = "100";
        opacity.step = "5";
        opacity.value = String(Math.round(item.op * 100));
        opacity.setAttribute("style", "flex:1 1 auto;min-width:0;accent-color:#7fdcff");
        var opacityValue = document.createElement("span");
        opacityValue.setAttribute("style", "flex:0 0 42px;text-align:right;font:600 11px/1 Roboto,system-ui,sans-serif;color:rgba(190,225,255,0.85)");
        opacityValue.textContent = Math.round(item.op * 100) + "%";
        opacity.addEventListener("input", function () {
            item.op = clamp((parseInt(opacity.value, 10) || 60) / 100, 0.1, 1);
            opacityValue.textContent = Math.round(item.op * 100) + "%";
            placePadButton(item, pad.els[item.id]);
            savePad();
        });
        var opacityWrap = document.createElement("div");
        opacityWrap.setAttribute("style", "display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0");
        opacityWrap.appendChild(opacity);
        opacityWrap.appendChild(opacityValue);
        pad.panelBody.appendChild(panelRow("Opacity", opacityWrap));

        var remove = chromeButton("DELETE", function () {
            deletePadItem(item.id);
        });
        remove.id = "r2aPadDelete";
        remove.setAttribute("style", [
            "flex:1 1 auto", "height:32px", "justify-content:center",
            "color:#ffd9d9", "background:rgba(255,90,90,0.16)",
            "border:1px solid rgba(255,140,140,0.55)", "border-radius:6px",
            "font:600 10px/30px Roboto,system-ui,sans-serif", "letter-spacing:0.6px",
            "display:flex", "align-items:center", "-webkit-user-select:none",
            "user-select:none"
        ].join(";"));
        pad.panelBody.appendChild(remove);
    }

    function addPadItem() {
        ensurePad();
        if (!pad.items) {
            pad.items = padDefaultLayout();
        }
        var v = padViewport();
        var size = Math.max(48, Math.round(Math.min(v.w, v.h) * 0.16));
        var item = {
            id: "b" + pad.seq++,
            label: "Z",
            kc: 90, code: "KeyZ", key: "z",
            x: 0.5, y: 0.42,
            w: size / v.w, h: size / v.h,
            shape: "circle", op: 0.62
        };
        pad.items.push(item);
        if (!pad.editing) {
            pad.visible = true;
        }
        renderPad();
        savePad();
        if (pad.editing) {
            selectPadItem(item.id);
        }
    }

    function deletePadItem(id) {
        var kept = [];
        for (var i = 0; i < pad.items.length; i++) {
            if (pad.items[i].id !== id) {
                kept.push(pad.items[i]);
            }
        }
        pad.items = kept;
        pad.selectedId = null;
        renderPad();
        savePad();
        renderInspector();
    }

    function setToolbarVisible(visible) {
        // The editor bar owns the top of the screen; the small corner icons
        // would sit on top of its DONE button.
        if (button) {
            button.style.display = visible ? "" : "none";
        }
        var icons = [kbButton, pad.button];
        for (var i = 0; i < icons.length; i++) {
            if (icons[i]) {
                icons[i].style.display = visible ? "flex" : "none";
            }
        }
    }

    function openMapper() {
        ensurePad();
        if (!pad.root) {
            return;
        }
        ensureMapperChrome();
        if (!pad.items || !pad.items.length) {
            pad.items = padDefaultLayout();
            renderPad();
            savePad();
        }
        pad.editing = true;
        pad.visible = true;
        showKeyboard(false);
        showPanel(false);
        renderPad();
        pad.backdrop.style.display = "block";
        pad.bar.style.display = "flex";
        setToolbarVisible(false);
        if (!pad.selectedId && pad.items.length) {
            selectPadItem(pad.items[0].id);
        } else {
            renderInspector();
        }
        forward("info", "button editor opened (" + pad.items.length + " buttons)");
    }

    function closeMapper() {
        if (!pad.editing) {
            return;
        }
        releaseAllPadPresses();
        pad.editing = false;
        pad.selectedId = null;
        pad.drag = null;
        if (pad.backdrop) {
            pad.backdrop.style.display = "none";
        }
        if (pad.bar) {
            pad.bar.style.display = "none";
        }
        if (pad.panel) {
            pad.panel.style.display = "none";
        }
        setToolbarVisible(true);
        for (var i = 0; i < pad.items.length; i++) {
            paintPad(pad.items[i], pad.els[pad.items[i].id], false);
        }
        savePad();
    }

    function releaseAllPadPresses() {
        for (var id in pad.presses) {
            var entry = pad.presses[id];
            delete pad.presses[id];
            paintPad(entry.item, entry.el, false);
            try {
                entry.target.dispatchEvent(entry.up);
            } catch (e) {
                /* ignore */
            }
        }
        pad.drag = null;
    }

    function setPadVisible(visible) {
        ensurePad();
        releaseAllPadPresses();
        pad.visible = !!visible;
        if (pad.root) {
            pad.root.style.display = pad.visible ? "block" : "none";
        }
        paintPadButtonState();
        savePad();
    }

    function paintPadButtonState() {
        if (!pad.button) {
            return;
        }
        var on = pad.visible && !pad.editing;
        pad.button.style.opacity = on ? "0.9" : "0.5";
        pad.button.style.background = on
            ? "rgba(120,220,255,0.25)"
            : "rgba(0,0,0,0.45)";
        pad.button.style.borderColor = on
            ? "rgba(200,245,255,0.9)"
            : "rgba(158,238,255,0.35)";
    }

    function ensurePadButton() {
        if (pad.button || !document.body) {
            return;
        }
        var el = document.createElement("div");
        el.id = "r2aPadButton";
        el.innerHTML = PAD_ICON;
        el.setAttribute("style", [
            "position:fixed", "top:2px", "right:66px", "width:28px", "height:26px",
            "display:flex", "align-items:center", "justify-content:center",
            "background:rgba(0,0,0,0.45)", "border:1px solid rgba(158,238,255,0.35)",
            "border-radius:6px", "z-index:2147483646", "opacity:0.55",
            "-webkit-user-select:none", "user-select:none", "touch-action:manipulation"
        ].join(";"));

        var timer = null;
        var longPressed = false;
        var cancel = function () {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        };
        el.addEventListener("pointerdown", function (event) {
            event.preventDefault();
            event.stopPropagation();
            longPressed = false;
            cancel();
            timer = setTimeout(function () {
                timer = null;
                longPressed = true;
                openMapper();
            }, 450);
        });
        el.addEventListener("pointerup", function (event) {
            event.preventDefault();
            event.stopPropagation();
            cancel();
            if (!longPressed) {
                if (pad.editing) {
                    closeMapper();
                } else {
                    setPadVisible(!pad.visible);
                }
            }
            longPressed = false;
        });
        el.addEventListener("pointercancel", function (event) {
            event.stopPropagation();
            cancel();
            longPressed = false;
        });
        el.addEventListener("contextmenu", function (event) {
            event.preventDefault();
        });
        document.body.appendChild(el);
        pad.button = el;
        paintPadButtonState();
    }

    // A finger that slides off a button (or a lost pointer capture) must not
    // leave a key held down for the rest of the session.
    window.addEventListener("pointerup", function (event) {
        endPadPress(event);
        endPadDrag(event);
    }, true);
    window.addEventListener("pointercancel", function (event) {
        endPadPress(event);
        endPadDrag(event);
    }, true);

    // --------------------------------------------------------------- upkeep

    function nudgeLayout() {
        // MZ only recomputes the canvas size on resize. If the WebView reports a
        // 0x0 (or absurdly small) viewport during boot the canvas ends up with a
        // 0px CSS size and the screen stays black even though the game is
        // running. Re-running the layout once the viewport is sane fixes it.
        try {
            var G = window.Graphics;
            if (!G || !G._canvas || typeof G._updateAllElements !== "function") {
                return false;
            }
            var rect = G._canvas.getBoundingClientRect();
            var broken = rect.width < 8 || rect.height < 8 ||
                !window.innerWidth || !window.innerHeight;
            if (broken) {
                G._updateAllElements();
                add("info", "layout nudge: canvas " + Math.round(rect.width) + "x" + Math.round(rect.height));
                return true;
            }
        } catch (e) {
            add("warn", "layout nudge failed: " + describe(e));
        }
        return false;
    }

    function tick() {
        ensureUi();
        ensureKeyboard();
        ensurePadButton();
        ensurePad();
        hookGameActive();
        hookRenderProbe();
        hookSceneTrace();
        runWatchdog();
        nudgeLayout();
        if (!autoOpened && probe.samples >= 8 && probe.lit === 0 && !probe.contextLost) {
            autoOpened = true;
            add("warn", "canvas has been black for " + probe.samples + " samples");
            showPanel(true);
        }
        if (probe.contextLost && !autoOpened) {
            autoOpened = true;
            showPanel(true);
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", function () {
            ensureUi();
            ensureKeyboard();
        });
    } else {
        ensureUi();
        ensureKeyboard();
    }

    add("info", "host ready");
    setInterval(tick, 500);

    window.addEventListener("resize", function () {
        // Sizes and positions are stored as viewport fractions, so only the
        // font size (which depends on pixels) and the editor chrome need work.
        if (!pad.root || !pad.items) {
            return;
        }
        for (var i = 0; i < pad.items.length; i++) {
            placePadButton(pad.items[i], pad.els[pad.items[i].id]);
        }
    });

    window.RPG2Android = {
        __hostLoaded: true,
        report: report,
        show: function () {
            showPanel(true);
        },
        hide: function () {
            showPanel(false);
        },
        keyboard: function (visible) {
            showKeyboard(visible !== false);
        },
        pad: function (visible) {
            setPadVisible(visible !== false);
        },
        mapper: function (open) {
            if (open === false) {
                closeMapper();
            } else {
                openMapper();
            }
        },
        // Called by MainActivity on the hardware back button: closes an open
        // overlay instead of sending Esc / leaving the app.
        handleBack: function () {
            if (pad.editing) {
                closeMapper();
                return true;
            }
            if (kbVisible) {
                showKeyboard(false);
                return true;
            }
            if (panelVisible) {
                showPanel(false);
                return true;
            }
            return false;
        }
    };
})();
