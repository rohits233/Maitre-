/**
 * CloudWatch EMF metrics helpers.
 *
 * Uses aws-embedded-metrics to publish metrics as structured log lines.
 * CloudWatch extracts the metrics automatically — no direct PutMetricData calls.
 *
 * Requirements: 8.2
 */

import { createMetricsLogger, Unit } from 'aws-embedded-metrics';
import { SessionManager } from './types/index';

const NAMESPACE = 'VoiceGateway';
const ACTIVE_CONNECTIONS_INTERVAL_MS = 30_000;

/**
 * Publish a one-off CallSessionDuration metric when a session ends.
 */
export async function publishSessionDuration(
  durationSeconds: number,
  correlationId: string
): Promise<void> {
  const metrics = createMetricsLogger();
  metrics.setNamespace(NAMESPACE);
  metrics.setProperty('correlationId', correlationId);
  metrics.putMetric('CallSessionDuration', durationSeconds, Unit.Seconds);
  await metrics.flush();
}

/**
 * Start a recurring timer that publishes the ActiveConnections count every 30 s.
 * Returns a handle that can be cleared on shutdown.
 */
export function startActiveConnectionsReporter(
  sessionManager: SessionManager
): NodeJS.Timeout {
  const timer = setInterval(() => {
    const count = sessionManager.getActiveSessions().length;
    const metrics = createMetricsLogger();
    metrics.setNamespace(NAMESPACE);
    metrics.putMetric('ActiveConnections', count, Unit.Count);
    metrics.flush().catch(() => {
      // metric flush failures are non-fatal
    });
  }, ACTIVE_CONNECTIONS_INTERVAL_MS);

  // Allow the process to exit even if this timer is still pending
  timer.unref();
  return timer;
}
