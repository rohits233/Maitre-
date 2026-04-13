package ai.maitre;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.Map;

/**
 * Loads configuration from a .env file in the project root,
 * falling back to actual environment variables.
 *
 * Priority: .env file > system environment variables > defaults
 */
public class Config {

    private static final Map<String, String> values = new HashMap<>();

    static {
        // Load .env file if it exists
        Path envFile = Paths.get(System.getProperty("user.dir"), ".env");
        if (Files.exists(envFile)) {
            try {
                Files.lines(envFile)
                    .map(String::trim)
                    .filter(line -> !line.isEmpty() && !line.startsWith("#"))
                    .filter(line -> line.contains("="))
                    .forEach(line -> {
                        int idx = line.indexOf('=');
                        String key = line.substring(0, idx).trim();
                        String val = line.substring(idx + 1).trim();
                        values.put(key, val);
                    });
                System.out.println("[Config] Loaded .env file from: " + envFile);
            } catch (IOException e) {
                System.err.println("[Config] Failed to read .env file: " + e.getMessage());
            }
        } else {
            System.out.println("[Config] No .env file found, using system environment variables");
        }
    }

    public static String get(String key) {
        // .env file takes priority, then system env
        return values.getOrDefault(key, System.getenv(key));
    }

    public static String get(String key, String defaultValue) {
        String val = get(key);
        return val != null ? val : defaultValue;
    }

    public static String require(String key) {
        String val = get(key);
        if (val == null || val.isBlank()) {
            throw new IllegalStateException("Required config missing: " + key +
                " — add it to your .env file");
        }
        return val;
    }
}
