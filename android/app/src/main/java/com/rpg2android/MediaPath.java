package com.rpg2android;

/**
 * Path rules for movie files copied out of the APK. No Android imports, so the
 * rules are unit tested on the JVM.
 */
final class MediaPath {

    /** Directories whose files RPG Maker hands to a media element. */
    private static final String[] MEDIA_DIRS = {"movies/", "videos/"};

    /** Container extensions a media element can be pointed at. */
    private static final String[] MEDIA_EXTENSIONS = {".webm", ".mp4", ".m4v", ".ogv", ".ogg"};

    private MediaPath() {
    }

    /**
     * Normalises a game relative path such as movies/feather.webm. Returns null
     * when this is not a plain file inside a media directory.
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
        // No empty, "." or ".." segments: the path must stay below the media dir.
        for (String segment : cleaned.split("/", -1)) {
            if (segment.isEmpty() || segment.equals(".") || segment.equals("..")) {
                return null;
            }
        }
        return cleaned;
    }
}
