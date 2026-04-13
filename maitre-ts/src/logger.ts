/**
 * Structured logger with optional correlation ID.
 *
 * Wraps console.log/error/warn and emits JSON log lines so that
 * CloudWatch Logs Insights can query them by field.
 *
 * Requirements: 8.1, 8.3, 8.4
 */

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  correlationId?: string;
  [key: string]: unknown;
}

export class Logger {
  private correlationId?: string;

  constructor(correlationId?: string) {
    this.correlationId = correlationId;
  }

  /** Return a child logger bound to a specific correlation ID */
  withCorrelationId(correlationId: string): Logger {
    return new Logger(correlationId);
  }

  info(message: string, extra?: Record<string, unknown>): void {
    this._log('info', message, extra);
  }

  warn(message: string, extra?: Record<string, unknown>): void {
    this._log('warn', message, extra);
  }

  error(message: string, extra?: Record<string, unknown>): void {
    this._log('error', message, extra);
  }

  private _log(
    level: 'info' | 'warn' | 'error',
    message: string,
    extra?: Record<string, unknown>
  ): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(this.correlationId ? { correlationId: this.correlationId } : {}),
      ...extra,
    };

    const line = JSON.stringify(entry);

    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }
}

/** Default application-level logger (no correlation ID) */
export const logger = new Logger();
