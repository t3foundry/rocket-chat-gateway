export const GATEWAY_LOCALES = ['en', 'ja'] as const;
export type GatewayLocale = (typeof GATEWAY_LOCALES)[number];

export const DEFAULT_GATEWAY_LOCALE: GatewayLocale = 'en';

const en = {
  authenticationRequired: 'Authentication required',
  noValidSessionCookie: 'No valid session cookie',
  sessionExpired: 'Session expired',
  notSignedInToServer: 'Not signed in to server `{{serverId}}`',
  noUsableServerConnection: 'Session has no usable server connection',
  unknownServer: 'Unknown server `{{serverId}}`',
  multipartFileRequired: 'Expected a multipart request with a `file` part',
  multipartImageRequired: 'Expected a multipart request with an `image` part',
  uploadAbandoned: 'The upload was cancelled before it finished',
  avatarMustBeImage: 'An avatar must be an image the Rocket.Chat server can render back',
  directMessageCannotInvite: 'A direct message cannot be invited to',
  directMessageCannotRemove: 'Nobody can be removed from a direct message',
  userNotFound: 'User not found',
  roomNotFound: 'Room not found',
  invalidRequestPart: 'Invalid {{type}}',
  endpointNotFound: 'No such endpoint',
  requestTooLarge: 'Request body is too large',
  tooManyRequests: 'Too many requests',
  unexpectedGatewayError: 'Unexpected gateway error',
  twoFactorRequired: 'A two-factor authentication code is required',
  invalidCredentialsOrSession: 'Invalid credentials or expired session',
  permissionDenied: 'You do not have permission to perform this action',
  resourceNotFound: 'The requested resource does not exist or is not visible to you',
  rateLimited: 'Too many requests; slow down and try again',
  payloadTooLarge: 'The payload exceeds the limit configured on the Rocket.Chat server',
  unsupportedByServer: 'The connected Rocket.Chat server does not support this operation',
  upstreamError: 'The Rocket.Chat server returned an error',
  upstreamTimeout: 'The Rocket.Chat server did not respond in time',
  upstreamUnavailable: 'Cannot reach the Rocket.Chat server',
  upstreamSessionInvalid: 'The Rocket.Chat session is no longer valid',
  upstreamRejected: 'The Rocket.Chat server rejected the request',
  realtimeUnavailable: 'The realtime connection to Rocket.Chat is unavailable',
  tasraIssuerNotConfigured: 'Credential issuing is not configured on this gateway',
  tasraNotConfigured: 'Tasra key registry is not configured on this gateway',
  tasraRuleUnavailable: "The slot's access rule could not be read from the verifier",
} as const;

export type GatewayMessageKey = keyof typeof en;
export type MessageVariables = Readonly<Record<string, string | number>>;

const ja: Record<GatewayMessageKey, string> = {
  authenticationRequired: '認証が必要です',
  noValidSessionCookie: '有効なセッション Cookie がありません',
  sessionExpired: 'セッションの有効期限が切れました',
  notSignedInToServer: 'サーバー `{{serverId}}` にサインインしていません',
  noUsableServerConnection: 'セッションに利用可能なサーバー接続がありません',
  unknownServer: '不明なサーバー `{{serverId}}`',
  multipartFileRequired: 'リクエストは `file` パートを含む multipart 形式である必要があります',
  multipartImageRequired: 'リクエストは `image` パートを含む multipart 形式である必要があります',
  uploadAbandoned: 'アップロードは完了する前にキャンセルされました',
  avatarMustBeImage: 'アバターには Rocket.Chat サーバーが表示できる画像を指定してください',
  directMessageCannotInvite: 'ダイレクトメッセージにはメンバーを招待できません',
  directMessageCannotRemove: 'ダイレクトメッセージからメンバーを削除できません',
  userNotFound: 'ユーザーが見つかりません',
  roomNotFound: 'ルームが見つかりません',
  invalidRequestPart: '{{type}} が無効です',
  endpointNotFound: 'エンドポイントが見つかりません',
  requestTooLarge: 'リクエスト本文が大きすぎます',
  tooManyRequests: 'リクエストが多すぎます',
  unexpectedGatewayError: 'ゲートウェイで予期しないエラーが発生しました',
  twoFactorRequired: '2要素認証コードが必要です',
  invalidCredentialsOrSession: '認証情報が無効か、セッションの有効期限が切れています',
  permissionDenied: 'この操作を行う権限がありません',
  resourceNotFound: '要求されたリソースが存在しないか、表示する権限がありません',
  rateLimited: 'リクエストが多すぎます。しばらく待ってから、もう一度お試しください',
  payloadTooLarge: 'Rocket.Chat サーバーで設定されたサイズ上限を超えています',
  unsupportedByServer: '接続先の Rocket.Chat サーバーはこの操作に対応していません',
  upstreamError: 'Rocket.Chat サーバーからエラーが返されました',
  upstreamTimeout: 'Rocket.Chat サーバーが時間内に応答しませんでした',
  upstreamUnavailable: 'Rocket.Chat サーバーに接続できません',
  upstreamSessionInvalid: 'Rocket.Chat セッションは無効になりました',
  upstreamRejected: 'Rocket.Chat サーバーがリクエストを拒否しました',
  realtimeUnavailable: 'Rocket.Chat へのリアルタイム接続を利用できません',
  tasraIssuerNotConfigured: 'このゲートウェイでは資格証明の発行が設定されていません',
  tasraNotConfigured: 'このゲートウェイではTasraキーレジストリが設定されていません',
  tasraRuleUnavailable: 'スロットのアクセスルールをベリファイアから取得できませんでした',
};

const messages: Record<GatewayLocale, Record<GatewayMessageKey, string>> = { en, ja };

/** Selects the best supported language from an RFC 9110 Accept-Language value. */
export const resolveGatewayLocale = (header: string | string[] | undefined): GatewayLocale => {
  const value = Array.isArray(header) ? header.join(',') : header;
  if (!value) return DEFAULT_GATEWAY_LOCALE;

  const preferences = value
    .split(',')
    .map((entry, index) => {
      const [rawRange = '', ...parameters] = entry.trim().split(';');
      const qualityParameter = parameters.find((parameter) => parameter.trim().startsWith('q='));
      const quality = qualityParameter ? Number(qualityParameter.trim().slice(2)) : 1;
      return { range: rawRange.toLowerCase(), quality: Number.isFinite(quality) ? quality : 0, index };
    })
    .filter(({ range, quality }) => range.length > 0 && quality > 0)
    .sort((left, right) => right.quality - left.quality || left.index - right.index);

  for (const { range } of preferences) {
    if (range === '*') return DEFAULT_GATEWAY_LOCALE;
    const base = range.split('-')[0];
    if (base === 'ja' || base === 'en') return base;
  }

  return DEFAULT_GATEWAY_LOCALE;
};

export const translateGatewayMessage = (
  key: GatewayMessageKey,
  locale: GatewayLocale,
  variables: MessageVariables = {},
): string =>
  messages[locale][key].replace(/\{\{(\w+)\}\}/g, (placeholder, name: string) =>
    variables[name] === undefined ? placeholder : String(variables[name]),
  );
