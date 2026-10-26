/*
 * rpg2android host script.
 *
 * Loaded before the game's own scripts. It never changes game behaviour; it
 * only observes. Everything it sees is kept in a ring buffer, forwarded to
 * logcat through the RPG2Host bridge (when present) and can be shown on screen:
 *
 *   - tap the small "i" button in the top-right corner, or
 *   - it opens by itself after a JS error, or
 *   - it opens by itself when the WebGL canvas has been painting nothing but
 *     black for a while.
 *
 * The on-screen report is the only way to read this on a phone without adb,
 * so it is deliberately plain text that can be screenshotted.
 */
(function () {
    "use strict";

    var MAX_LINES = 60;
    var PROBE_INTERVAL_MS = 700;
    var REPORT_INTERVAL_MS = 1000;

    var lines = [];
    var panel = null;
    var button = null;
    var panelVisible = false;
    var reportTimer = null;
    var autoOpened = false;

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
            " doc=" + (doc ? doc.clientWidth + "x" + doc.clientHeight : "?") +
            " body=" + (body ? body.clientWidth + "x" + body.clientHeight : "?") +
            " dpr=" + (window.devicePixelRatio || 1)
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

    function sceneInfo() {
        try {
            var manager = window.SceneManager;
            if (!manager || !manager._scene) {
                return "scene=none";
            }
            return (
                "scene " + manager._scene.constructor.name +
                " children=" + manager._scene.children.length +
                " fade=" + (Math.round((manager._scene._fadeSign || 0) * 100) / 100)
            );
        } catch (e) {
            return "scene=?" + describe(e);
        }
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

    function report() {
        return [
            "rpg2android diagnostics",
            "url " + String(location.href).split("/").slice(-2).join("/"),
            "ua " + navigator.userAgent,
            viewInfo(),
            canvasInfo(),
            graphicsInfo(),
            glInfo(),
            probeInfo(),
            sceneInfo(),
            mediaInfo(),
            audioInfo(),
            errorInfo(),
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

        document.body.appendChild(panel);
        document.body.appendChild(button);
    }

    function renderPanel() {
        if (!panel) {
            return;
        }
        panel.textContent = report();
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
                    hookRenderProbe();
                    renderPanel();
                }, REPORT_INTERVAL_MS);
            }
        } else if (reportTimer) {
            clearInterval(reportTimer);
            reportTimer = null;
        }
    }

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
        hookRenderProbe();
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
        });
    } else {
        ensureUi();
    }

    add("info", "host ready");
    setInterval(tick, 500);

    window.RPG2Android = {
        report: report,
        show: function () {
            showPanel(true);
        }
    };
})();
