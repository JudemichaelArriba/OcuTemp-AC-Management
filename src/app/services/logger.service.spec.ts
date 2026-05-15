import * as Sentry from '@sentry/angular';
import { environment } from '../../environments/environment';
import { LoggerService } from './logger.service';

vi.mock('@sentry/angular', () => ({
  captureException: vi.fn(),
  isInitialized: vi.fn(() => true),
}));

describe('LoggerService', () => {
  const originalProduction = environment.production;
  const originalDsn = environment.sentryDsn;

  let logger: LoggerService;

  beforeEach(() => {
    environment.production = true;
    environment.sentryDsn = 'https://examplePublicKey@sentry.example/1';
    vi.mocked(Sentry.isInitialized).mockReturnValue(true);
    vi.mocked(Sentry.captureException).mockClear();
    logger = new LoggerService();
  });

  afterEach(() => {
    environment.production = originalProduction;
    environment.sentryDsn = originalDsn;
  });

  it('reports important Firebase/database failures in production', () => {
    const error = { code: 'permission_denied', message: 'Permission denied' };

    logger.error('Failed to fetch rooms', error, {
      service: 'RoomService',
      action: 'streamRooms',
    });

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        level: 'error',
        extra: expect.objectContaining({
          message: 'Failed to fetch rooms',
          code: 'permission_denied',
        }),
      }),
    );
  });

  it('ignores expected auth, duplicate, and validation failures in production', () => {
    logger.error('Login system error', { code: 'auth/wrong-password' });
    logger.error('Signup failed', { code: 'auth/email-already-in-use' });
    logger.error('Room create failed', new Error('Room name already exists'));
    logger.error('Validation Error', new Error('Validation Error'));

    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('captures the real error object and sanitizes context metadata', () => {
    const error = new Error('Network request failed');

    logger.error('Failed to load dashboard', error, {
      component: 'Dashboard',
      email: 'staff@example.com',
      nested: {
        password: 'super-secret',
        deviceId: 'ESP-001',
      },
    });

    const [capturedError, captureContext] = vi.mocked(Sentry.captureException).mock.calls[0];
    const extra = captureContext as {
      extra: {
        message: string;
        context: Record<string, unknown>;
      };
    };

    expect(capturedError).toBe(error);
    expect(extra.extra.message).toBe('Failed to load dashboard');
    expect(extra.extra.context['email']).toBe('[REDACTED]');
    expect(extra.extra.context['nested']).toEqual({
      password: '[REDACTED]',
      deviceId: 'ESP-001',
    });
  });

  it('does not send production events when Sentry is not configured', () => {
    environment.sentryDsn = '';

    logger.error('Failed to load rooms', new Error('Network request failed'));

    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});
