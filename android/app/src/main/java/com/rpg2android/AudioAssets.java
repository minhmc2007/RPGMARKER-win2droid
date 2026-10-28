package com.rpg2android;

import java.util.List;

/**
 * Decides which audio extension a game actually ships.
 *
 * RPG Maker picks the audio extension from the user agent, not from the files:
 * {@code AudioManager.audioFileExt} returns ".ogg" only on a desktop browser and
 * falls back to ".m4a" on any mobile device, because iOS Safari cannot decode
 * ogg. A game authored on Windows ships ogg only, so every BGM/SE/BGS request on
 * an Android WebView asks for a file that does not exist in the APK.
 *
 * Android's WebView is Chromium and does decode ogg, so the shell offers the
 * game the extension its own asset folder really contains. This class only reads
 * file names; it has no Android imports and is unit tested on the JVM.
 */
final class AudioAssets {

    /** Containers RPG Maker games are published with, most common first. */
    private static final String[] EXTENSIONS = {".ogg", ".m4a", ".mp3", ".wav", ".aac"};

    private AudioAssets() {
    }

    /**
     * Returns the single audio extension used by a folder.
     *
     * @param names file names in one audio folder (as {@code AssetManager.list}
     *              returns them)
     * @return the extension including the dot, or "" when the folder is empty,
     *         mixes extensions, or holds no audio at all — in which case the
     *         game's own choice is left alone
     */
    static String fileExt(List<String> names) {
        if (names == null) {
            return "";
        }
        String found = "";
        for (String name : names) {
            String ext = extensionOf(name);
            if (ext.isEmpty()) {
                continue;
            }
            if (found.isEmpty()) {
                found = ext;
            } else if (!found.equals(ext)) {
                return "";
            }
        }
        return found;
    }

    /** The audio extension of one file name, or "" when it is not audio. */
    static String extensionOf(String name) {
        if (name == null) {
            return "";
        }
        String lower = name.toLowerCase();
        for (String ext : EXTENSIONS) {
            if (lower.endsWith(ext)) {
                return ext;
            }
        }
        return "";
    }
}
