import type { HttpRequest, HttpResponse } from '../ports/http-transport.js';

export type RetryPredicate = (info: {
  readonly error?: unknown;
  readonly response?: HttpResponse;
  readonly attempt: number;
}) => boolean;

export interface RetryConfig {
  readonly attempts: number;
  readonly backoff?: 'fixed' | 'exponential';
  readonly baseMs?: number;
  readonly maxDelayMs?: number;
  readonly jitter?: number;
  readonly isRetryable?: RetryPredicate;
  readonly delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export type AuthConfig =
  | { readonly type: 'bearer'; readonly token: string }
  | { readonly type: 'basic'; readonly username: string; readonly password: string }
  | {
      readonly type: 'custom';
      readonly header: (req: HttpRequest) => string | Promise<string>;
    };

export type LogEvent =
  | {
      readonly kind: 'request';
      readonly method: 'GET' | 'POST';
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly bodyBytes: number;
    }
  | {
      readonly kind: 'response';
      readonly statusCode: number;
      readonly url: string;
      readonly elapsedMs: number;
      readonly headers: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: 'error';
      readonly url: string;
      readonly elapsedMs: number;
      readonly errorMessage: string;
    };

export interface Logger {
  readonly log: (event: LogEvent) => void;
}

export interface LoggingConfig {
  readonly logger: Logger;
  readonly now?: () => number;
  readonly redactHeaders?: ReadonlyArray<string>;
}
