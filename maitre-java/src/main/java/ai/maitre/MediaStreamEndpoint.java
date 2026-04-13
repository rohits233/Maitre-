package ai.maitre;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.eclipse.jetty.websocket.api.Session;
import org.eclipse.jetty.websocket.api.WebSocketAdapter;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Base64;

/**
 * Handles the Twilio Media Stream WebSocket at /media-stream.
 *
 * Twilio sends JSON messages with these event types:
 *   connected  — WebSocket handshake complete
 *   start      — stream started, contains call metadata
 *   media      — audio chunk (base64-encoded mulaw 8kHz)
 *   stop       — call ended
 *
 * On stream start, we send back a synthesized mulaw greeting so you
 * can hear it on your phone — proving bidirectional audio works.
 */
public class MediaStreamEndpoint extends WebSocketAdapter {

    private static final ObjectMapper JSON = new ObjectMapper();
    private String callSid   = "unknown";
    private String streamSid = "unknown";

    @Override
    public void onWebSocketConnect(Session session) {
        super.onWebSocketConnect(session);
        System.out.println("[MediaStream] WebSocket connected from: " + session.getRemoteAddress());
    }

    @Override
    public void onWebSocketText(String message) {
        try {
            JsonNode node  = JSON.readTree(message);
            String   event = node.path("event").asText();

            switch (event) {
                case "connected" -> {
                    System.out.println("[MediaStream] ✓ Connected — Twilio Media Stream established");
                }
                case "start" -> {
                    callSid   = node.path("start").path("callSid").asText("unknown");
                    streamSid = node.path("start").path("streamSid").asText("unknown");
                    System.out.printf("[MediaStream] ✓ Stream started | callSid=%s | streamSid=%s%n",
                            callSid, streamSid);
                    System.out.println("[MediaStream]   Audio format: mulaw 8kHz mono");
                    System.out.println("[MediaStream]   Voice is now flowing through Maître!");

                    // Send greeting audio back to the caller
                    sendGreeting();
                }
                case "media" -> {
                    String seq   = node.path("sequenceNumber").asText();
                    String track = node.path("media").path("track").asText();
                    if (Integer.parseInt(seq) % 50 == 0) {
                        System.out.printf("[MediaStream]   Audio chunk #%s | track=%s | callSid=%s%n",
                                seq, track, callSid);
                    }
                }
                case "stop" -> {
                    System.out.printf("[MediaStream] ✓ Stream stopped | callSid=%s%n", callSid);
                }
                default -> {
                    System.out.println("[MediaStream] Unknown event: " + event);
                }
            }
        } catch (Exception e) {
            System.err.println("[MediaStream] Error parsing message: " + e.getMessage());
        }
    }

    @Override
    public void onWebSocketClose(int statusCode, String reason) {
        System.out.printf("[MediaStream] WebSocket closed | code=%d | reason=%s%n", statusCode, reason);
    }

    @Override
    public void onWebSocketError(Throwable cause) {
        System.err.println("[MediaStream] WebSocket error: " + cause.getMessage());
    }

    /**
     * Sends the greeting.wav file back to Twilio.
     * The WAV must be mulaw 8kHz mono — converted via ffmpeg before use.
     */
    private void sendGreeting() {
        try {
            // WAV files have a 44-byte header — skip it to get raw mulaw audio
            byte[] wavBytes   = Files.readAllBytes(Paths.get("greeting.wav"));
            byte[] mulawAudio = new byte[wavBytes.length - 44];
            System.arraycopy(wavBytes, 44, mulawAudio, 0, mulawAudio.length);

            sendMulawAudio(mulawAudio);
            System.out.println("[MediaStream] ✓ Greeting sent to caller from greeting.wav");
        } catch (IOException e) {
            System.err.println("[MediaStream] Failed to send greeting: " + e.getMessage());
        }
    }

    /**
     * Sends raw mulaw bytes to Twilio in 160-byte chunks (20ms each at 8kHz).
     * Chunking is required — Twilio expects small incremental packets.
     */
    private void sendMulawAudio(byte[] mulawBytes) throws IOException {
        int chunkSize = 160; // 20ms at 8kHz
        for (int offset = 0; offset < mulawBytes.length; offset += chunkSize) {
            int    end   = Math.min(offset + chunkSize, mulawBytes.length);
            byte[] chunk = new byte[end - offset];
            System.arraycopy(mulawBytes, offset, chunk, 0, chunk.length);

            String payload = Base64.getEncoder().encodeToString(chunk);
            String msg = String.format(
                "{\"event\":\"media\",\"streamSid\":\"%s\",\"media\":{\"track\":\"outbound\",\"payload\":\"%s\"}}",
                streamSid, payload
            );
            getSession().getRemote().sendString(msg);
        }
    }
}
