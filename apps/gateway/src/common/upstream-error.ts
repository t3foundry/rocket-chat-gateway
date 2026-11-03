import type { ErrorCode } from '@t3foundry/open-rocket-chat-api-contract';
import { RocketChatApiError, RocketChatTransportError } from '@t3foundry/open-rocket-chat-rc-rest-client';
import { DdpConnectionError, DdpMethodError } from '@t3foundry/open-rocket-chat-rc-realtime-client';

import { ApiException } from './api-exception';

/**
 * Rocket.Chat error identifiers that carry more meaning than their HTTP status.
 * Everything else falls back to a status-based mapping.
 */
const CODE_BY_ERROR_TYPE: Record<string, ErrorCode> = {
  'totp-required': 'totp_required',
  'error-totp-required': 'totp_required',
  'error-invalid-user': 'unauthorized',
  'error-invalid-password': 'unauthorized',
  unauthorized: 'forbidden',
  'error-not-allowed': 'forbidden',
  'error-room-not-found': 'not_found',
  'error-invalid-room': 'not_found',
  'error-invalid-message': 'not_found',
  'error-duplicate-channel-name': 'conflict',
  'error-file-too-large': 'payload_too_large',
  'error-message-size-exceeded': 'payload_too_large',
  'unknown-endpoint': 'unsupported_by_server',
};

const codeForStatus = (status: number): ErrorCode => {
  if (status === 400) return 'bad_request';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 413) return 'payload_too_large';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream_error';
  return 'upstream_error';
};

/**
 * Translates any failure from the Rocket.Chat SDKs into the gateway's own error
 * contract. Upstream messages are preserved in `upstream` but never become the
 * client-facing message: they are inconsistent across versions and sometimes
 * leak internal detail.
 */
export const toApiException = (error: unknown): ApiException => {
  if (error instanceof ApiException) return error;

  if (error instanceof RocketChatApiError) {
    // `errorType` can be an empty string on some Rocket.Chat routes, so the
    // lookup is guarded on `undefined` rather than on truthiness.
    const mapped = error.errorType ? CODE_BY_ERROR_TYPE[error.errorType] : undefined;
    const code = mapped ?? codeForStatus(error.status);
    if (code === 'bad_request') return new ApiException(code, error.message, error.errorType);
    return ApiException.localized(code, messageKeyForCode(code), { upstream: error.errorType });
  }

  if (error instanceof RocketChatTransportError) {
    return ApiException.localized('upstream_unavailable', error.timedOut ? 'upstreamTimeout' : 'upstreamUnavailable');
  }

  if (error instanceof DdpMethodError) {
    // Being blocked for too many login attempts is neither a bad credential nor
    // a broken server, and telling the user to check their password would send
    // them straight back into the block.
    if (error.isLoginRateLimited) {
      return ApiException.localized('rate_limited', 'rateLimited', { upstream: String(error.ddpError.error) });
    }

    return ApiException.localized(
      error.isInvalidToken ? 'unauthorized' : 'upstream_error',
      error.isInvalidToken ? 'upstreamSessionInvalid' : 'upstreamRejected',
      { upstream: String(error.ddpError.error) },
    );
  }

  if (error instanceof DdpConnectionError) {
    return ApiException.localized('upstream_unavailable', 'realtimeUnavailable');
  }

  return ApiException.localized('internal_error', 'unexpectedGatewayError');
};

/**
 * Client-facing wording. `upstream_error` deliberately hides the original text,
 * which is often an internal Meteor stack detail.
 */
const messageKeyForCode = (code: Exclude<ErrorCode, 'bad_request'>) => {
  switch (code) {
    case 'totp_required':
      return 'twoFactorRequired' as const;
    case 'unauthorized':
      return 'invalidCredentialsOrSession' as const;
    case 'forbidden':
      return 'permissionDenied' as const;
    case 'not_found':
      return 'resourceNotFound' as const;
    case 'rate_limited':
      return 'rateLimited' as const;
    case 'payload_too_large':
      return 'payloadTooLarge' as const;
    case 'unsupported_by_server':
      return 'unsupportedByServer' as const;
    default:
      return 'upstreamError' as const;
  }
};
