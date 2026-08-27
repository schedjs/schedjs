import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;

/**
 * sched HTTP worker example — pure JDK (com.sun.net.httpserver), no build deps.
 *
 * Implements the sched runner protocol (docs/content/docs/05.protocol.md):
 *   - POST /            dispatch envelope { task: { name, config }, data }
 *   - GET /status/:id   async poll endpoint (same outbound auth)
 *
 * Tasks:
 *   - "ping"  sync:  200 { status: "succeeded"|"failed", ... }
 *   - "long"  async: 202 { status: "accepted", statusUrl, pollIntervalMs } ->
 *                    GET statusUrl -> running with progress -> terminal envelope
 *
 * Auth (G1): when SCHED_API_KEY is set, every endpoint requires `x-sched-api-key`
 * to match (else 401). Unset -> validation skipped.
 * Idempotency: results are stored by `x-sched-run-id`; a redelivery of the same
 * run id answers with the saved outcome instead of re-executing.
 *
 * Run: javac Worker.java && java Worker   (port: SCHED_PORT, default 8083)
 */
public class Worker {

    private static final Map<String, Map<String, Object>> RUNS = new ConcurrentHashMap<>();

    private static final String API_KEY = env("SCHED_API_KEY");
    private static final String BASE_URL = env("SCHED_BASE_URL").replaceAll("/+$", "");

    private static String env(String name) {
        String v = System.getenv(name);
        return v == null ? "" : v;
    }

    public static void main(String[] args) throws IOException {
        int port = 8083;
        if (!env("SCHED_PORT").isEmpty()) {
            try {
                port = Integer.parseInt(env("SCHED_PORT"));
            } catch (NumberFormatException ignored) {
            }
        }
        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
        server.createContext("/", Worker::dispatch);
        server.createContext("/status/", Worker::status);
        server.setExecutor(Executors.newCachedThreadPool());
        server.start();
        System.out.println("[worker] sched example worker (Java) listening on :" + port);
    }

    // ---- endpoints ---------------------------------------------------------

    private static void dispatch(HttpExchange ex) throws IOException {
        if (!"POST".equals(ex.getRequestMethod())) {
            json(ex, 404, "{\"error\":\"not found\"}");
            return;
        }
        if (!authOk(ex)) {
            json(ex, 401, "{\"error\":\"unauthorized\"}");
            return;
        }
        Map<String, Object> env = readJson(ex);
        if (env == null) {
            json(ex, 400, "{\"error\":\"invalid JSON envelope\"}");
            return;
        }
        Map<String, Object> task = castMap(env.get("task"));
        String name = task == null ? "" : String.valueOf(task.get("name"));
        Map<String, Object> data = castMap(env.get("data"));
        if (data == null) {
            data = new HashMap<>();
        }
        String runId = ex.getRequestHeaders().getFirst("x-sched-run-id");
        if (runId == null || runId.isEmpty()) {
            runId = "anon-" + System.nanoTime();
        }
        if ("long".equals(name)) {
            async(ex, runId, name, data);
        } else {
            sync(ex, runId, name, data);
        }
    }

    private static void status(HttpExchange ex) throws IOException {
        if (!"GET".equals(ex.getRequestMethod())) {
            json(ex, 404, "{\"error\":\"not found\"}");
            return;
        }
        if (!authOk(ex)) {
            json(ex, 401, "{\"error\":\"unauthorized\"}");
            return;
        }
        String runId = ex.getRequestURI().getPath().substring("/status/".length());
        Map<String, Object> state = RUNS.get(runId);
        if (state == null) {
            json(ex, 404, "{\"error\":\"unknown run id\"}");
            return;
        }
        json(ex, 200, toJson(state));
    }

    // ---- task handlers -----------------------------------------------------

    private static void sync(HttpExchange ex, String runId, String taskName, Map<String, Object> data) throws IOException {
        Map<String, Object> existing = RUNS.get(runId); // redelivery -> saved outcome
        if (existing != null) {
            json(ex, 200, toJson(existing));
            return;
        }
        try {
            Thread.sleep(workMs(data, 100));
        } catch (InterruptedException ignored) {
        }
        Map<String, Object> state = new HashMap<>();
        state.put("progress", 100);
        if (shouldFail(data)) {
            state.put("status", "failed");
            state.put("error", "worker failed on purpose (data.fail=true)");
            state.put("log", "ping failed as requested");
        } else {
            Map<String, Object> result = new HashMap<>();
            result.put("task", taskName);
            result.put("data", data);
            result.put("echo", "pong");
            state.put("status", "succeeded");
            state.put("result", result);
            state.put("log", "ping ok");
        }
        RUNS.put(runId, state);
        json(ex, 200, toJson(state));
    }

    private static void async(HttpExchange ex, String runId, String taskName, Map<String, Object> data) throws IOException {
        Map<String, Object> existing = RUNS.get(runId); // redelivery of in-flight/finished run
        if (existing != null) {
            String st = String.valueOf(existing.get("status"));
            if ("queued".equals(st) || "running".equals(st)) {
                json(ex, 202, acceptedBody(ex, runId));
            } else {
                json(ex, 200, toJson(existing));
            }
            return;
        }
        final Map<String, Object> state = new HashMap<>();
        state.put("status", "queued");
        state.put("progress", 0);
        state.put("log", "accepted");
        RUNS.put(runId, state);
        final int ms = workMs(data, 150);
        final boolean fail = shouldFail(data);
        new Thread(() -> {
            try {
                for (int p = 20; p <= 100; p += 20) {
                    Thread.sleep(ms);
                    state.put("status", "running");
                    state.put("progress", p);
                    state.put("log", "working… " + p + "%");
                }
                state.put("progress", 100);
                if (fail) {
                    state.put("status", "failed");
                    state.put("error", "worker failed on purpose (data.fail=true)");
                    state.put("log", "long task failed as requested");
                } else {
                    Map<String, Object> result = new HashMap<>();
                    result.put("task", taskName);
                    result.put("workMs", ms);
                    result.put("ok", Boolean.TRUE);
                    state.put("status", "succeeded");
                    state.put("result", result);
                    state.put("log", "long task completed");
                }
            } catch (InterruptedException ignored) {
            }
        }).start();
        json(ex, 202, acceptedBody(ex, runId));
    }

    private static String acceptedBody(HttpExchange ex, String runId) {
        return "{\"status\":\"accepted\",\"statusUrl\":\"" + baseUrl(ex) + "/status/" + runId + "\",\"pollIntervalMs\":500}";
    }

    // ---- helpers -------------------------------------------------------------

    private static boolean authOk(HttpExchange ex) {
        return API_KEY.isEmpty() || API_KEY.equals(ex.getRequestHeaders().getFirst("x-sched-api-key"));
    }

    private static String baseUrl(HttpExchange ex) {
        if (!BASE_URL.isEmpty()) {
            return BASE_URL;
        }
        String host = ex.getRequestHeaders().getFirst("Host");
        if (host == null || host.isEmpty()) {
            host = "localhost:" + (env("SCHED_PORT").isEmpty() ? "8083" : env("SCHED_PORT"));
        }
        return "http://" + host;
    }

    private static int workMs(Map<String, Object> data, int def) {
        Object v = data.get("workMs");
        if (v instanceof Number) {
            int ms = ((Number) v).intValue();
            if (ms > 0) {
                return ms;
            }
        }
        return def;
    }

    private static boolean shouldFail(Map<String, Object> data) {
        return Boolean.TRUE.equals(data.get("fail"));
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object o) {
        return o instanceof Map ? (Map<String, Object>) o : null;
    }

    private static Map<String, Object> readJson(HttpExchange ex) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[4096];
        int n;
        InputStream in = ex.getRequestBody();
        while ((n = in.read(chunk)) > 0) {
            buf.write(chunk, 0, n);
        }
        String text = new String(buf.toByteArray(), StandardCharsets.UTF_8);
        return parseJson(text);
    }

    private static void json(HttpExchange ex, int code, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("content-type", "application/json");
        ex.sendResponseHeaders(code, bytes.length);
        OutputStream os = ex.getResponseBody();
        os.write(bytes);
        os.close();
    }

    // ---- minimal JSON (JDK 8 has none in stdlib; tiny hand-rolled parser/serializer) ----

    private static String toJson(Object value) {
        StringBuilder sb = new StringBuilder();
        writeJson(sb, value);
        return sb.toString();
    }

    private static void writeJson(StringBuilder sb, Object v) {
        if (v == null) {
            sb.append("null");
        } else if (v instanceof String) {
            writeJsonString(sb, (String) v);
        } else if (v instanceof Boolean || v instanceof Number) {
            sb.append(v);
        } else if (v instanceof Map) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                writeJsonString(sb, String.valueOf(e.getKey()));
                sb.append(':');
                writeJson(sb, e.getValue());
            }
            sb.append('}');
        } else if (v instanceof Iterable) {
            sb.append('[');
            boolean first = true;
            for (Object o : (Iterable<?>) v) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                writeJson(sb, o);
            }
            sb.append(']');
        } else {
            writeJsonString(sb, String.valueOf(v));
        }
    }

    private static void writeJsonString(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':
                    sb.append("\\\"");
                    break;
                case '\\':
                    sb.append("\\\\");
                    break;
                case '\n':
                    sb.append("\\n");
                    break;
                case '\r':
                    sb.append("\\r");
                    break;
                case '\t':
                    sb.append("\\t");
                    break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
    }

    private static Map<String, Object> parseJson(String text) {
        Parser p = new Parser(text);
        Object v = p.parseValue();
        // strict: full consumption + no parse error + top-level object
        if (!p.ok || p.i < p.s.length()) {
            return null;
        }
        return v instanceof Map ? castMap(v) : null;
    }

    private static final class Parser {
        private final String s;
        private int i;
        private boolean ok = true;

        Parser(String s) {
            this.s = s;
        }

        Object parseValue() {
            skipWs();
            if (i >= s.length()) {
                ok = false; // empty / trailing input
                return null;
            }
            char c = s.charAt(i);
            if (c == '{') {
                return parseObject();
            }
            if (c == '[') {
                return parseArray();
            }
            if (c == '"') {
                return parseString();
            }
            if (c == 't') {
                expect("true");
                return Boolean.TRUE;
            }
            if (c == 'f') {
                expect("false");
                return Boolean.FALSE;
            }
            if (c == 'n') {
                expect("null");
                return null;
            }
            return parseNumber();
        }

        private void skipWs() {
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) {
                i++;
            }
        }

        private Map<String, Object> parseObject() {
            Map<String, Object> m = new HashMap<>();
            i++; // {
            skipWs();
            if (i < s.length() && s.charAt(i) == '}') {
                i++;
                return m;
            }
            while (ok) {
                skipWs();
                if (i >= s.length() || s.charAt(i) != '"') {
                    ok = false;
                    return null;
                }
                String key = parseString();
                if (!ok) {
                    return null;
                }
                skipWs();
                if (i >= s.length() || s.charAt(i) != ':') {
                    ok = false;
                    return null;
                }
                i++;
                Object val = parseValue();
                if (!ok) {
                    return null;
                }
                m.put(key, val);
                skipWs();
                if (i >= s.length()) {
                    ok = false;
                    return null;
                }
                char c = s.charAt(i++);
                if (c == '}') {
                    return m;
                }
                if (c != ',') {
                    ok = false;
                    return null;
                }
            }
            return null;
        }

        private List<Object> parseArray() {
            List<Object> l = new ArrayList<>();
            i++; // [
            skipWs();
            if (i < s.length() && s.charAt(i) == ']') {
                i++;
                return l;
            }
            while (ok) {
                Object val = parseValue();
                if (!ok) {
                    return null;
                }
                l.add(val);
                skipWs();
                if (i >= s.length()) {
                    ok = false;
                    return null;
                }
                char c = s.charAt(i++);
                if (c == ']') {
                    return l;
                }
                if (c != ',') {
                    ok = false;
                    return null;
                }
            }
            return null;
        }

        private String parseString() {
            StringBuilder sb = new StringBuilder();
            i++; // opening quote
            while (i < s.length()) {
                char c = s.charAt(i++);
                if (c == '"') {
                    return sb.toString();
                }
                if (c == '\\' && i < s.length()) {
                    char e = s.charAt(i++);
                    switch (e) {
                        case '"':
                            sb.append('"');
                            break;
                        case '\\':
                            sb.append('\\');
                            break;
                        case '/':
                            sb.append('/');
                            break;
                        case 'n':
                            sb.append('\n');
                            break;
                        case 't':
                            sb.append('\t');
                            break;
                        case 'r':
                            sb.append('\r');
                            break;
                        case 'b':
                            sb.append('\b');
                            break;
                        case 'f':
                            sb.append('\f');
                            break;
                        case 'u':
                            if (i + 4 <= s.length()) {
                                sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                                i += 4;
                            } else {
                                ok = false; // truncated unicode escape
                            }
                            break;
                        default:
                            sb.append(e);
                    }
                } else if (c == '\\') {
                    ok = false; // trailing backslash
                } else {
                    sb.append(c);
                }
            }
            ok = false; // unterminated string
            return null;
        }

        private Number parseNumber() {
            int start = i;
            while (i < s.length() && "-+0123456789.eE".indexOf(s.charAt(i)) >= 0) {
                i++;
            }
            String num = s.substring(start, i);
            try {
                return Long.parseLong(num);
            } catch (NumberFormatException ignored) {
            }
            try {
                return Double.parseDouble(num);
            } catch (NumberFormatException e) {
                ok = false;
                return null;
            }
        }

        private void expect(String word) {
            if (s.startsWith(word, i)) {
                i += word.length();
            } else {
                ok = false;
            }
        }
    }
}
