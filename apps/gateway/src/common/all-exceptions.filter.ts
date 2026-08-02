import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PinoLogger } from 'nestjs-pino';

import { ApiException } from './api-exception';
import { toApiException } from './upstream-error';
import { DEFAULT_GATEWAY_LOCALE, resolveGatewayLocale } from '../i18n/i18n';

/**
 * Guarantees every error leaving the gateway matches `ApiErrorSchema`, whether
 * it came from a controller, an upstream Rocket.Chat call or an unhandled bug.
 * Without this, clients would have to cope with three different error shapes.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(AllExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const request = host.switchToHttp().getRequest<FastifyRequest>();

    // A Nest HttpException raised outside our own code (404 route, payload
    // limits) already has a sensible status but not our body shape.
    const apiException =
      exception instanceof HttpException && !(exception instanceof ApiException)
        ? this.fromNestException(exception)
        : toApiException(exception);

    const status = apiException.getStatus();

    if (status >= 500) {
      this.logger.error({ err: exception, code: apiException.code, upstream: apiException.upstream }, 'request failed');
    } else {
      this.logger.debug({ code: apiException.code, status, upstream: apiException.upstream }, 'request rejected');
    }

    const locale = resolveGatewayLocale(request.headers['accept-language']);
    // Raw Rocket.Chat messages have no gateway translation key and remain in
    // their original language; do not claim that fallback prose is Japanese.
    const contentLanguage = apiException.messageKey ? locale : DEFAULT_GATEWAY_LOCALE;
    void reply
      .header('content-language', contentLanguage)
      .header('vary', 'accept-language')
      .status(status)
      .send(apiException.getLocalizedResponse(locale));
  }

  private fromNestException(exception: HttpException): ApiException {
    const status = exception.getStatus();
    const response = exception.getResponse();
    const message =
      typeof response === 'string' ? response : ((response as { message?: string }).message ?? exception.message);

    if (status === 404) return ApiException.localized('not_found', 'endpointNotFound');
    if (status === 413) return ApiException.localized('payload_too_large', 'requestTooLarge');
    if (status === 429) return ApiException.localized('rate_limited', 'tooManyRequests');
    if (status >= 500) return ApiException.localized('internal_error', 'unexpectedGatewayError');

    return new ApiException('bad_request', message);
  }
}
