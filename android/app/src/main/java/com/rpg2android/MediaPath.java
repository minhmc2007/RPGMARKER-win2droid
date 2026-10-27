package com.rpg2android;

/**
 * Path rules for the movie files the shell copies out of the APK.
 *
 * Android's media stack opens media files itself and cannot read a path that
 * only exists inside an APK, so a &lt;video&gt; element fed
 * {@code file:///android_asset/www/movies/...} never plays. The shell therefore
 * extracts the requested movie into its own files directory first; this class
 * decides which requests are allowed to trigger that copy.
 *
 * Kept free of Android imports on purpose: the rules are plain string handling
 * and are unit tested on the JVM.
 */
final class MediaPath {

    /** Directories whose files RPG Maker hands to a media element. */
    private static final String[] MEDIA_DIRS = {"movies/", "videos/"};

    /** Container extensions a media element can be pointed at. */
    private static final String[] MEDIA_EXTENSIONS = {".webm", ".mp4", ".m4v", ".ogv", ".ogg"};

    private MediaPath() {
    }

    /**
     * Normalises a game relative media path such as {@code movies/feather.webm}.
     *
     * @param path path as the game wrote it (leading {@code ./} and Windows
     *             separators are tolerated)
     * @return the path to use relative to the game root, or null when this is
     *         not a plain file inside a media directory
     */
    static String normalize(String path) {
        if (path == null) {
            return null;
        }
        String cleaned = path.trim().replace('\\', '/');
        while (cleaned.startsWith("./")) {
            cleaned = cleaned.substring(2);
        }
        if (cleaned.isEmpty() || cleaned.startsWith("/") || cleaned.indexOf(':') >= 0) {
            return null;
        }
        boolean inMediaDir = false;
        for (String dir : MEDIA_DIRS) {
            if (cleaned.startsWith(dir)) {
                inMediaDir = true;
                break;
            }
        }
        if (!inMediaDir) {
            return null;
        }
        String lower = cleaned.toLowerCase();
        boolean knownExtension = false;
        for (String extension : MEDIA_EXTENSIONS) {
            if (lower.endsWith(extension)) {
                knownExtension = true;
                break;
            }
        }
        if (!knownExtension) {
            return null;
        }
        // No empty, current or parent segments: the result is used as a file
        // name below the media directory and must not escape it.
        for (String segment : cleaned.split("/", -1)) {
            if (segment.isEmpty() || segment.equals(".") || segment.equals("..")) {
                return null;
            }
        }
        return cleaned;
    }
}
