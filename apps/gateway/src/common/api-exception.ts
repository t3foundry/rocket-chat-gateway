import type { ErrorCode } from '@t3foundry/open-rocket-chat-api-contract';
import { HttpException, HttpStatus } from '@nestjs/common';

import {
  DEFAULT_GATEWAY_LOCALE,
  translateGatewayMessage,
  type GatewayLocale,
  type GatewayMessageKey,
  type MessageVariables,
} from '../i18n/i18n';

const STATUS_BY_CODE: Record<ErrorCode, HttpStatus> = {
  bad_request: HttpStatus.BAD_REQUEST,
  unauthorized: HttpStatus.UNAUTHORIZED,
  forbidden: HttpStatus.FORBIDDEN,
  not_found: HttpStatus.NOT_FOUND,
  conflict: HttpStatus.CONFLICT,
  payload_too_large: HttpStatus.PAYLOAD_TOO_LARGE,
  rate_limited: HttpStatus.TOO_MANY_REQUESTS,
  totp_required: HttpStatus.UNAUTHORIZED,
  upstream_unavailable: HttpStatus.SERVICE_UNAVAILABLE,
  upstream_error: HttpStatus.BAD_GATEWAY,
  unsupported_by_server: HttpStatus.NOT_IMPLEMENTED,
  internal_error: HttpStatus.INTERNAL_SERVER_ERROR,
};

/**
 * The single error type the gateway throws. Carrying the contract's `ErrorCode`
 * rather than a bare HTTP status means clients can branch on a stable value —
 * `totp_required` and a plain bad password are both 401 over the wire.
 */
export class ApiException extends HttpException {
  constructor(
    readonly code: ErrorCode,
    message: string,
    /** Upstream Rocket.Chat error identifier; logged and echoed for debugging, never localised. */
    readonly upstream?: string,
    readonly details?: Record<string, unknown>,
    readonly messageKey?: GatewayMessageKey,
    readonly messageVariables?: MessageVariables,
  ) {
    super(
      {
        error: {
          code,
          message,
          ...(upstream ? { upstream } : {}),
          ...(details ? { details } : {}),
        },
      },
      STATUS_BY_CODE[code],
    );
  }

  /** Builds the same contract envelope with its human-readable text localised. */
  getLocalizedResponse(locale: GatewayLocale): ReturnType<ApiException['getResponse']> {
    if (!this.messageKey) return this.getResponse();

    return {
      error: {
        code: this.code,
        message: translateGatewayMessage(this.messageKey, locale, this.messageVariables),
        ...(this.upstream ? { upstream: this.upstream } : {}),
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }

  static localized(
    code: ErrorCode,
    messageKey: GatewayMessageKey,
    options: {
      variables?: MessageVariables;
      upstream?: string;
      details?: Record<string, unknown>;
    } = {},
  ): ApiException {
    return new ApiException(
      code,
      translateGatewayMessage(messageKey, DEFAULT_GATEWAY_LOCALE, options.variables),
      options.upstream,
      options.details,
      messageKey,
      options.variables,
    );
  }

  static unauthorized(message?: string): ApiException {
    return message
      ? new ApiException('unauthorized', message)
      : ApiException.localized('unauthorized', 'authenticationRequired');
  }

  static notFound(message = 'Not found'): ApiException {
    return new ApiException('not_found', message);
  }

  static badRequest(message: string, details?: Record<string, unknown>): ApiException {
    return new ApiException('bad_request', message, undefined, details);
  }
}
