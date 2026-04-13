package ai.maitre;

import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import java.io.IOException;

/**
 * Handles POST /voice/inbound — called by Twilio when someone dials your number.
 *
 * Returns TwiML that tells Twilio to open a bidirectional Media Stream WebSocket.
 * Credentials are loaded from .env file via Config.
 */
public class VoiceWebhookServlet extends HttpServlet {

    private static final String ACCOUNT_SID = Config.get("TWILIO_ACCOUNT_SID", "");
    private static final String AUTH_TOKEN  = Config.get("TWILIO_AUTH_TOKEN", "");

    @Override
    protected void doPost(HttpServletRequest req, HttpServletResponse resp)
            throws IOException {

        String host = req.getHeader("Host");
        String streamUrl = "wss://" + host + "/media-stream";

        String twiml = """
                <?xml version="1.0" encoding="UTF-8"?>
                <Response>
                    <Connect>
                        <Stream url="%s">
                            <Parameter name="greeting" value="Hello from Maitre"/>
                        </Stream>
                    </Connect>
                </Response>
                """.formatted(streamUrl);

        resp.setContentType("text/xml");
        resp.setCharacterEncoding("UTF-8");
        resp.getWriter().write(twiml);

        System.out.println("[Webhook] Inbound call from: " + req.getParameter("From"));
        System.out.println("[Webhook] AccountSID configured: " + (!ACCOUNT_SID.isBlank() ? "yes" : "NO - check .env"));
        System.out.println("[Webhook] AuthToken configured:  " + (!AUTH_TOKEN.isBlank()  ? "yes" : "NO - check .env"));
        System.out.println("[Webhook] Media Stream URL: " + streamUrl);
    }
}
