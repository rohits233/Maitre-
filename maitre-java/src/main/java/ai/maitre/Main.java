package ai.maitre;

import org.eclipse.jetty.server.Server;
import org.eclipse.jetty.servlet.ServletContextHandler;
import org.eclipse.jetty.websocket.server.config.JettyWebSocketServletContainerInitializer;

/**
 * Maître — entry point.
 * Starts an embedded Jetty server with:
 *   POST /voice/inbound  — Twilio webhook, returns TwiML to open a Media Stream
 *   WS   /media-stream   — Twilio streams call audio here over WebSocket
 *   GET  /health         — health check
 */
public class Main {

    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(Config.get("PORT", "8080"));

        Server server = new Server(port);

        ServletContextHandler context = new ServletContextHandler(ServletContextHandler.SESSIONS);
        context.setContextPath("/");

        // HTTP servlets
        context.addServlet(VoiceWebhookServlet.class, "/voice/inbound");
        context.addServlet(HealthServlet.class, "/health");

        // WebSocket endpoint at /media-stream
        JettyWebSocketServletContainerInitializer.configure(context, (servletContext, wsContainer) -> {
            wsContainer.setMaxTextMessageSize(64 * 1024);
            wsContainer.addMapping("/media-stream", MediaStreamEndpoint.class);
        });

        server.setHandler(context);
        server.start();

        System.out.printf("Maître listening on port %d%n", port);
        System.out.println("Webhook:      POST /voice/inbound");
        System.out.println("Media Stream: WS   /media-stream");
        System.out.println("Health:       GET  /health");

        server.join();
    }
}
