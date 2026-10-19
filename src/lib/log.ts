// Scoped logger with an in-memory ring buffer (the UI shows recent entries).

import type { Clock } from './clock';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  scope: string;
  msg: string;
}

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export class LogSink {
  private entries: LogEntry[] = [];
  private listeners = new Set<(e: LogEntry) => void>();

  constructor(
    private readonly clock: Clock,
    public minLevel: LogLevel = 'info',
    public echo = false,
    private readonly capacity = 500,
  ) {}

  write(level: LogLevel, scope: string, msg: string): void {
    if (ORDER[level] < ORDER[this.minLevel]) return;
    const entry: LogEntry = { ts: this.clock.now(), level, scope, msg };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    if (this.echo) {
      const line = `[${scope}] ${msg}`;
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    }
    for (const fn of this.listeners) fn(entry);
  }

  recent(limit = 200): LogEntry[] {
    return this.entries.slice(-limit);
  }

  subscribe(fn: (e: LogEntry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export class Logger {
  constructor(
    private readonly sink: LogSink,
    readonly scope: string,
  ) {}

  child(scope: string): Logger {
    return new Logger(this.sink, `${this.scope}:${scope}`);
  }

  debug(msg: string): void {
    this.sink.write('debug', this.scope, msg);
  }
  info(msg: string): void {
    this.sink.write('info', this.scope, msg);
  }
  warn(msg: string): void {
    this.sink.write('warn', this.scope, msg);
  }
  error(msg: string): void {
    this.sink.write('error', this.scope, msg);
  }
}

/** A logger that drops everything. Handy in unit tests. */
export function nullLogger(clock: Clock): Logger {
  return new Logger(new LogSink(clock, 'error'), 'null');
}
