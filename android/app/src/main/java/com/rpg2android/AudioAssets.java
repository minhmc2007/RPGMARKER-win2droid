package com.rpg2android;

import java.util.List;

/**
 * Decides which audio extension a game ships, based on its file names. RPG Maker
 * guesses from the user agent instead, which is wrong on Android. No Android
 * imports, so the rules are unit tested on the JVM.
 */
final class AudioAssets {

    /** Containers RPG Maker games are published with, most common first. */
    private static final String[] EXTENSIONS = {".ogg", ".m4a", ".mp3", ".wav", ".aac"};

    private AudioAssets() {
    }

    /**
     * Returns the single extension used by a folder, with the dot. Returns ""
     * for an empty folder, mixed extensions, or no audio.
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
