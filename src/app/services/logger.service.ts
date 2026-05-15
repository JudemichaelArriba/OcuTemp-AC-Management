import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';
import * as Sentry from '@sentry/angular';

export type LoggerContext = Record<string, unknown>;

interface NormalizedLog {
  message: string;
  exception: unknown;
  context: LoggerContext;
  code?: string;
}

const EXPECTED_ERROR_CODES = new Set([
  'auth/user-not-found',
  'auth/wrong-password',
  'auth/invalid-credential',
  'auth/invalid-login-credentials',
  'auth/email-already-in-use',
  'auth/invalid-email',
  'auth/weak-password',
  'auth/requires-recent-login',
  'auth/too-many-requests',
  'invalid_password',
  'invalid_login_credentials',
]);

const EXPECTED_MESSAGE_FRAGMENTS = [
  'not-approved',
  'wrong password',
  'incorrect password',
  'invalid credential',
  'invalid credentials',
  'invalid email',
  'weak password',
  'email already in use',
  'email address is already registered',
  'room name already exists',
  'floorplan cell is already assigned',
  'room not found',
  'device id is required',
  'device id contains invalid characters',
  'user not authenticated',
  'too many attempts',
  'too many failed attempts',
  'rate limit',
  'validation error',
];

const SENSITIVE_KEY_PATTERN = /(password|token|secret|credential|authorization|api[-_]?key|apikey|email|dsn)/i;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

@Injectable({ providedIn: 'root' })
export class LoggerService {

  private readonly reportedObjects = new WeakSet<object>();

  error(messageOrError: unknown, errorOrContext?: unknown, context?: LoggerContext): void {
    const args = [messageOrError, errorOrContext, context].filter(arg => arg !== undefined);
    const log = this.normalize(args);

    if (!environment.production) {
      console.error(...args);
      return;
    }

    if (!this.shouldReport(log) || !environment.sentryDsn || !Sentry.isInitialized()) {
      return;
    }

    Sentry.captureException(log.exception, {
      level: 'error',
      tags: {
        source: 'web',
        logger: 'manual',
      },
      extra: {
        message: this.redactString(log.message),
        code: log.code ?? 'unknown',
        context: this.sanitizeValue(log.context),
      },
    });

    this.markReported(log.exception);
  }

  warn(...args: unknown[]): void {
    if (!environment.production) {
      console.warn(...args);
    }
  }

  private normalize(args: unknown[]): NormalizedLog {
    const exception = this.findException(args);
    const message = this.resolveMessage(args, exception);
    const context = this.resolveContext(args);
    const code = this.extractErrorCode(exception) ?? this.extractErrorCodeFromArgs(args);

    return {
      message,
      exception: exception ?? new Error(message),
      context,
      code,
    };
  }

  private shouldReport(log: NormalizedLog): boolean {
    if (this.wasReported(log.exception)) return false;

    const code = log.code?.toLowerCase();
    if (code && EXPECTED_ERROR_CODES.has(code)) return false;

    const messageCandidates = [
      log.message,
      this.getErrorMessage(log.exception),
      log.code,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);

    return !messageCandidates.some(message => this.isExpectedMessage(message));
  }

  private findException(args: unknown[]): unknown {
    return args.find(arg => this.isErrorLike(arg));
  }

  private resolveMessage(args: unknown[], exception: unknown): string {
    const first = args[0];
    if (typeof first === 'string' && first.trim()) return first.trim();

    const errorMessage = this.getErrorMessage(exception);
    if (errorMessage) return errorMessage;

    return 'Application error';
  }

  private resolveContext(args: unknown[]): LoggerContext {
    const context: LoggerContext = {};

    for (const arg of args) {
      if (this.isPlainContext(arg)) {
        Object.assign(context, arg);
      }
    }

    if (typeof window !== 'undefined') {
      context['path'] = window.location.pathname;
    }

    return context;
  }

  private extractErrorCodeFromArgs(args: unknown[]): string | undefined {
    for (const arg of args) {
      const code = this.extractErrorCode(arg);
      if (code) return code;
    }
    return undefined;
  }

  private extractErrorCode(value: unknown): string | undefined {
    if (!this.isRecord(value)) return undefined;

    const code = value['code'];
    if (typeof code === 'string' && code.trim()) return code.trim();

    const customData = value['customData'];
    if (this.isRecord(customData)) {
      const tokenResponse = customData['_tokenResponse'];
      if (this.isRecord(tokenResponse)) {
        const tokenError = tokenResponse['error'];
        const tokenMessage = this.isRecord(tokenError) ? tokenError['message'] : undefined;
        if (typeof tokenMessage === 'string' && tokenMessage.trim()) return tokenMessage.trim();
      }
    }

    return undefined;
  }

  private getErrorMessage(value: unknown): string | undefined {
    if (value instanceof Error && value.message) return value.message;
    if (!this.isRecord(value)) return undefined;

    const message = value['message'];
    return typeof message === 'string' && message.trim() ? message.trim() : undefined;
  }

  private isErrorLike(value: unknown): boolean {
    if (value instanceof Error) return true;
    if (!this.isRecord(value)) return false;
    return (
      typeof value['code'] === 'string' ||
      typeof value['stack'] === 'string' ||
      (typeof value['name'] === 'string' && typeof value['message'] === 'string')
    );
  }

  private isPlainContext(value: unknown): value is LoggerContext {
    if (!this.isRecord(value) || Array.isArray(value) || value instanceof Error) return false;
    return !this.isErrorLike(value);
  }

  private isExpectedMessage(message: string): boolean {
    const normalized = message.toLowerCase();
    return EXPECTED_MESSAGE_FRAGMENTS.some(fragment => normalized.includes(fragment));
  }

  private wasReported(exception: unknown): boolean {
    return this.isObject(exception) && this.reportedObjects.has(exception);
  }

  private markReported(exception: unknown): void {
    if (this.isObject(exception)) {
      this.reportedObjects.add(exception);
    }
  }

  private sanitizeValue(value: unknown, depth = 0, key = ''): unknown {
    if (key && SENSITIVE_KEY_PATTERN.test(key)) return '[REDACTED]';

    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return this.redactString(value);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (value instanceof Date) return value.toISOString();

    if (value instanceof Error) {
      return {
        name: value.name,
        message: this.redactString(value.message),
        code: this.extractErrorCode(value),
      };
    }

    if (Array.isArray(value)) {
      if (depth >= 2) return `[Array(${value.length})]`;
      return value.slice(0, 10).map(item => this.sanitizeValue(item, depth + 1));
    }

    if (this.isRecord(value)) {
      if (depth >= 2) return '[Object]';

      const result: LoggerContext = {};
      for (const [entryKey, entryValue] of Object.entries(value).slice(0, 20)) {
        result[entryKey] = this.sanitizeValue(entryValue, depth + 1, entryKey);
      }
      return result;
    }

    return String(value);
  }

  private redactString(value: string): string {
    const redacted = value.replace(EMAIL_PATTERN, '[REDACTED_EMAIL]');
    return redacted.length > 500 ? `${redacted.slice(0, 500)}...` : redacted;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return this.isObject(value);
  }

  private isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}
