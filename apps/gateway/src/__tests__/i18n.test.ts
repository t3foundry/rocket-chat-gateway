import { describe, expect, it } from 'vitest';

import { ApiException } from '../common/api-exception';
import { resolveGatewayLocale, translateGatewayMessage } from '../i18n/i18n';

describe('gateway i18n', () => {
  it('matches Japanese regional language tags', () => {
    expect(resolveGatewayLocale('ja-JP,ja;q=0.9,en;q=0.8')).toBe('ja');
  });

  it('uses the highest-priority supported language', () => {
    expect(resolveGatewayLocale('vi-VN, ja;q=0.8, en;q=0.5')).toBe('ja');
    expect(resolveGatewayLocale('ja;q=0.4, en;q=0.9')).toBe('en');
  });

  it('falls back to English for missing and unsupported languages', () => {
    expect(resolveGatewayLocale(undefined)).toBe('en');
    expect(resolveGatewayLocale('vi-VN')).toBe('en');
    expect(resolveGatewayLocale('*')).toBe('en');
  });

  it('interpolates variables without changing identifiers', () => {
    expect(translateGatewayMessage('unknownServer', 'ja', { serverId: 'tokyo' })).toBe('不明なサーバー `tokyo`');
  });

  it('localises only the human-readable field in the API error envelope', () => {
    const exception = ApiException.localized('forbidden', 'permissionDenied', {
      upstream: 'error-not-allowed',
      details: { permission: 'create-c' },
    });

    expect(exception.getLocalizedResponse('ja')).toEqual({
      error: {
        code: 'forbidden',
        message: 'この操作を行う権限がありません',
        upstream: 'error-not-allowed',
        details: { permission: 'create-c' },
      },
    });
  });

  it('keeps raw upstream messages unchanged', () => {
    const exception = new ApiException('bad_request', 'Rocket.Chat upstream detail', 'error-new');

    expect(exception.getLocalizedResponse('ja')).toEqual(exception.getResponse());
  });
});
