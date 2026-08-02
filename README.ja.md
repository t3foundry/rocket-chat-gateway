# Open Rocket.Chat Gateway

[English](README.md) · [Tiếng Việt](README.vi.md) · **日本語**

[Rocket.Chat](https://rocket.chat) サーバーとフロントエンドの間に置く Backend for Frontend（BFF）です。Rocket.Chat のバージョン差を吸収する、シンプルで安定した API と、その基盤となる TypeScript SDK を提供します。

> **Rocket.Chat Technologies Corp. とは無関係であり、同社による承認もサポートも受けていません。**
> これは独立したコミュニティ主導のプロジェクトです。「Rocket.Chat」は各権利者の商標であり、ここでは互換性を説明する目的でのみ使用しています。

対になるフロントエンドは [open-rocket-chat-client](https://github.com/zscontributor/open-rocket-chat-client) にあります。

## なぜゲートウェイが必要か

ブラウザから Rocket.Chat へ直接接続することもできますが、その場合は各クライアントが次の 3 つの問題に対処しなければなりません。

**認証トークンをブラウザに保存する必要がある。** Rocket.Chat の REST API は `X-Auth-Token` と `X-User-Id` ヘッダーで認証します。直接接続するクライアントは、アカウント全体を操作できる有効期間の長いトークンをブラウザ内に保持しなければなりません。XSS 脆弱性がひとつでもあれば、トークンを盗まれるおそれがあります。ゲートウェイを使うとトークンはサーバー側に残り、ブラウザが受け取るのは JavaScript から読み取れない `HttpOnly` セッションクッキーだけです。

**API がバージョンごとに変わる。** エンドポイントはリリースによって名前や方式が変わります。たとえばファイルアップロードは `rooms.upload/:rid` から、`rooms.media` と `rooms.mediaConfirm` を使う 2 段階の方式へ移行しましたが、実際にはどちらの方式のサーバーも稼働しています。ゲートウェイは対応方式を自動で判定し、クライアントからその違いを隠します。

**データモデルに Meteor 固有の事情が表れる。** ルーム種別は 1 文字と 2 つの独立したフラグで表され、既読状態はルーム本体ではなく別の `subscription` レコードに保存されます。タイムスタンプも REST では ISO 文字列、WebSocket では `{ $date }` と形式が異なります。直接接続すると、すべてのクライアントが同じ正規化処理を実装することになります。ゲートウェイなら、その処理を一度にまとめられます。

```
┌────────────────────────────────────────────────────────────────┐
│  Browser · apps/web                                            │
│  React 19 static bundle. Holds one opaque HttpOnly session     │
│  cookie — never a Rocket.Chat token.                           │
│                                                                │
│   ┌───┐  server rail     query cache            one WebSocket  │
│   │ A │◀── active        ['server', <id>, …]    for every      │
│   │ B │                                         server         │
│   └───┘                                                        │
└──────────────────────┬───────────────────────┬─────────────────┘
                       │                       │
             HTTPS /api/v1                 WSS /ws
      session cookie + X-Server-Id      session cookie
                       │                       │
                       ▼                       ▼
┌────────────────────────────────────────────────────────────────┐
│  Gateway · apps/gateway                                        │
│  NestJS + Fastify, a single Node process                       │
│                                                                │
│  session store — in memory, or Redis for more than one         │
│  instance:   cookie ──▶ { A: X-Auth-Token, B: X-Auth-Token }   │
│                                                                │
│  one upstream connection per session per server, shared by     │
│  every tab that session has open                               │
└────────┬───────────────────────┬───────────────────────┬───────┘
         │                       │                       │
   REST + DDP              REST + DDP              REST + DDP
  X-Auth-Token            X-Auth-Token            X-Auth-Token
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Rocket.Chat A  │     │  Rocket.Chat B  │     │  Rocket.Chat …  │
│    + MongoDB    │     │    + MongoDB    │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

ひとつのセッションで複数の Rocket.Chat サーバーに接続できることは、このアーキテクチャの基本機能です。同じクッキーで再度サインインするとサーバーが追加され、`X-Server-Id` でリクエスト先を選びます。クライアントはひとつの WebSocket ですべてのサーバーのイベントを受信します。Rocket.Chat サーバー自体には変更を加える必要がなく、互いの存在やこの構成を意識しません。ルーム id はサーバー内でしか一意でないため、すべてのリクエストで対象サーバーを指定します。図では [open-rocket-chat-client](https://github.com/zscontributor/open-rocket-chat-client) を例にしていますが、この API はほかのクライアントからも利用できます。

## 提供されるもの

| パッケージ                             | 役割                                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `@open-rocket-chat/api-contract`       | データモデル、HTTP API、リアルタイムイベントを Zod スキーマで定義。ゲートウェイとクライアントで共有。 |
| `@open-rocket-chat/rc-rest-client`     | Rocket.Chat REST API 向けの、型付きで依存関係のないクライアント。                                     |
| `@open-rocket-chat/rc-realtime-client` | 再接続とサブスクリプション復旧に対応した DDP-over-WebSocket クライアント。                            |
| `@open-rocket-chat/rc-adapter`         | Rocket.Chat のレコードをドメインモデルへ正規化。                                                      |
| `apps/gateway`                         | それらを束ねる NestJS + Fastify サービス。                                                            |

各パッケージは単体でも使えます。ゲートウェイは不要で型付きの Rocket.Chat SDK だけが欲しい場合は、
スクリプト・ボット・別のサーバーサイドサービス向けに `rc-rest-client` と `rc-realtime-client` を使ってください。

ただし、実際の認証情報を使ってブラウザ内で動かすことは想定していません。アカウント全体を操作できる
Rocket.Chat トークンがページ上に置かれ、ゲートウェイが避けようとしているリスクが再び生じるためです。[SECURITY.md](SECURITY.md) を参照してください。

## クイックスタート

```bash
pnpm install
pnpm run build

# localhost:3000 に Rocket.Chat + MongoDB、admin/admin-password-123
pnpm run rc:up

cp apps/gateway/.env.example apps/gateway/.env
pnpm --filter @open-rocket-chat/gateway dev
```

ゲートウェイは `http://localhost:4000` で待ち受け、HTTP を `/api/v1` 配下、リアルタイムを `/ws` で提供します。

```bash
curl -c jar -X POST http://localhost:4000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"user":"admin","password":"admin-password-123"}'

curl -b jar http://localhost:4000/api/v1/rooms

# 同じクッキーで再度サインインするとセッションに 2 台目のサーバーが追加され、
# 以後 `X-Server-Id` がリクエストの対象サーバーを選びます。
curl -b jar -c jar -X POST http://localhost:4000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"serverId":"contoso","user":"admin","password":"admin-password-123"}'

curl -b jar -H 'x-server-id: contoso' http://localhost:4000/api/v1/rooms
```

## API

すべてのルートは `/api/v1` 配下です。`auth/login`、`auth/login/oauth`、`auth/servers`、`health` を除き、セッションクッキーが必要です。

ひとつのセッションで複数の Rocket.Chat サーバーに同時にサインインできます。各リクエストは **`X-Server-Id`** ヘッダーで対象サーバーを選びます。省略するとセッションの既定サーバーが使われるため、単一サーバー構成では追加の指定は不要です。まだサインインしていないサーバーを指定した場合は `404` ではなく `401` を返します。リソースがないのではなく、現在のセッションにアクセス権がないためです。メディア系ルートでは、`<img>` タグに任意のヘッダーを付けられないため、代わりに `?serverId=` を使います。

| メソッド         | パス                                                 | 用途                                                       |
| ---------------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| `GET`            | `auth/servers`                                       | 設定済みサーバーと、各サーバーが提供するサインイン方式     |
| `POST`           | `auth/login`                                         | サインイン。クッキーがある場合はセッションにサーバーを追加 |
| `POST`           | `auth/login/oauth`                                   | Rocket.Chat のクレデンシャル対で OAuth サインインを完了    |
| `GET`            | `auth/session`                                       | 全サーバー接続と、どれが既定か                             |
| `POST`           | `auth/logout`                                        | 1 サーバー、または全サーバーを切断                         |
| `GET`            | `server/capabilities`                                | このサーバーが何をサポートするか。一度探査してキャッシュ   |
| `GET`            | `rooms`                                              | サイドバー用。参加中のルームと購読状態、差分同期つき       |
| `POST`           | `rooms`                                              | チャンネルまたはプライベートグループを作成                 |
| `GET`/`PATCH`    | `rooms/:roomId`                                      | 単一ルーム。名前・トピック・アナウンス・説明の変更         |
| `POST`           | `rooms/direct`                                       | ダイレクトメッセージを開く / 作成                          |
| `POST`           | `rooms/:roomId/read` \| `/unread`                    | 未読バッジをクリア、または再び未読にする                   |
| `PATCH`          | `rooms/:roomId/state`                                | お気に入り / 非表示                                        |
| `POST`           | `rooms/:roomId/leave`                                | ルームから退出                                             |
| `GET`/`POST`     | `rooms/:roomId/members`                              | メンバー（ページング）／メンバーの追加                     |
| `PATCH`/`DELETE` | `rooms/:roomId/members/:userId`                      | メンバーのロール変更／メンバーの削除                       |
| `GET`            | `rooms/:roomId/roles`                                | ルーム内のロール割り当て                                   |
| `GET`            | `rooms/:roomId/files`                                | ルームで共有されたファイル。名前と種別で絞り込み可         |
| `GET`/`PATCH`    | `rooms/:roomId/notifications`                        | ルームごとの通知設定                                       |
| `POST`           | `rooms/:roomId/prune`                                | 指定範囲のメッセージを削除                                 |
| `GET`            | `rooms/:roomId/messages`                             | 履歴。`before` / `after` を基点に取得                      |
| `POST`           | `rooms/:roomId/messages`                             | 送信。`clientMessageId` と `threadId` は任意               |
| `PATCH`          | `rooms/:roomId/messages/:messageId`                  | 編集                                                       |
| `DELETE`         | `rooms/:roomId/messages/:messageId`                  | 削除                                                       |
| `PUT`/`DELETE`   | `rooms/:roomId/messages/:messageId/reactions/:emoji` | リアクション                                               |
| `POST`/`DELETE`  | `rooms/:roomId/messages/:messageId/pin` \| `/star`   | ピン留め / スター                                          |
| `GET`            | `rooms/:roomId/threads`                              | スレッドの親メッセージ                                     |
| `GET`            | `rooms/:roomId/pinned` · `/starred` · `/mentions`    | 3 種のメッセージ一覧（ページング）                         |
| `GET`            | `rooms/:roomId/messages/search`                      | ルーム内検索                                               |
| `POST`           | `rooms/:roomId/files`                                | アップロード（`multipart/form-data`、`file` パート）       |
| `GET`            | `files/*` · `avatars/:username`                      | メディア。サーバー側の認証情報でプロキシ                   |
| `GET`            | `emoji/custom`                                       | サーバーのカスタム絵文字と、描画用の URL                   |
| `GET`/`POST`     | `commands` \| `commands/run`                         | サーバーが提供するスラッシュコマンドと、その実行           |
| `GET`            | `users/:userIdOrUsername` · `users/search`           | プロフィールと入力補完                                     |
| `PATCH`          | `users/me/status`                                    | 自分のプレゼンスとステータスメッセージ                     |
| `GET`            | `health` · `health/upstream`                         | 死活監視とレディネス                                       |

エラーは常に `ApiErrorSchema` に一致し、Rocket.Chat のエラー文字列ではなく安定した `code`（`unauthorized`、`totp_required`、`unsupported_by_server` など）を返します。人間が読む文面は `Accept-Language` で交渉され、現在は英語と日本語に対応します。`code`、`upstream` 識別子、構造化された `details` は言語によらず変わらないため、クライアントはそれらで分岐できます。[docs/i18n.md](docs/i18n.md) を参照してください。

### OAuth サインイン

`auth/servers` は、サーバーごとにパスワードフォームが有効かどうか（`passwordLoginEnabled`）と、どの OAuth プロバイダーが有効か（`loginServices`）を返します。各サービスにはそのまま開ける `authorizeUrl` が含まれます。ゲートウェイが Rocket.Chat のサービスレコードと設定からプロバイダーのエンドポイントを解決するため、クライアントは Google や GitLab がどこにあるかを知らずにボタンを描画するだけで済みます。このフローで扱えないサービス（Twitter の OAuth 1.0a、SAML、CAS、LDAP、Apple）は除外されます。

ハンドシェイク自体にゲートウェイは関与しません。プロバイダーのクライアントシークレットを持っているのは Rocket.Chat なので、ブラウザは `state` に `base64({loginStyle: 'popup', credentialToken, isCordova: false})` を載せて `authorizeUrl` を開き、プロバイダーは Rocket.Chat 自身の `/_oauth/<service>` コールバックへ戻します。そのコールバックは Rocket.Chat のオリジンのストレージにクレデンシャルシークレットを残し、クライアントはそれを `{credentialToken, credentialSecret}` として `auth/login/oauth` に送り、セッションと引き換えます。

**そのため、ブラウザ上のクライアントは Rocket.Chat と同一オリジンから配信する必要があります。** OAuth の結果を読み取るためです。ゲートウェイとクライアントを Rocket.Chat サーバーと同じホストの背後に配置できない場合は、OAuth を無効にしてパスワードログインを使用してください。リダイレクト URL は Rocket.Chat の `Site_Url` を基に生成されるため、ユーザーが実際にアクセスするアドレスと一致させる必要があります。

### リアルタイム

同じセッションクッキーで `/ws` へ WebSocket を接続します。ゲートウェイは JSON イベント（`connection.ready`、`message.created`、`message.updated`、`message.deleted`、`room.updated`、`room.removed`、`typing.changed`、`presence.changed`、`room.read`、`notification`）を送り、コマンド（`room.subscribe`、`room.unsubscribe`、`typing.set`、`ping`）を受け付けます。

ルームのイベントは、クライアントが `room.subscribe` を送った後に配信されます。ゲートウェイから Rocket.Chat への接続は、同じセッションのすべての WebSocket で共有されます。そのため、タブを 5 枚開いても Rocket.Chat への接続はサーバーごとに 1 本だけです。この共有接続により、現在開いていないサーバーの未読数も更新されます。

ひとつの WebSocket で、そのセッションがサインインしているすべてのサーバーを扱います。各イベントとコマンドには対象を示す `serverId` が含まれます。例外は `ping` で、これは特定のサーバーではなく WebSocket 接続自体に対するコマンドです。接続済みのサーバーごとに `connection.ready` が 1 件届きます。ルーム id は Rocket.Chat サーバー内でしか一意でないため、WebSocket に接続されていないサーバー宛てのコマンドは処理されません。

知っておく価値のある挙動が 3 つあります。

- **`connection.degraded`** は、ゲートウェイと Rocket.Chat の接続が切れたことを示します。切断中に発生したイベントは再送 _されません_。次の `connection.ready` を受け取ったら、データを取得し直してください。
- メッセージページの **`gapBefore`** は、`after` クエリを連続させられなかったことを意味します。Rocket.Chat は期間内の _最新_ メッセージしか返せないため、非常に長い切断からの追いつきでは穴が残ることがあります。追記ではなくルームの再読み込みを行ってください。
- **`notification`** は事前のサブスクリプションなしで、ユーザーが参加しているすべてのルームについて届きます。Rocket.Chat は通知設定、メンション、プレゼンス、ワークスペースの既定値を基に、通知が必要かどうかをすでに判断しています。クライアントは `message.created` から同じ判断をやり直さず、このイベントをそのまま利用してください。`message.created` は購読中のルームについてしか届きません。

## 設定

[`apps/gateway/.env.example`](apps/gateway/.env.example) を参照してください。重要なのは次の 2 つです。

- **`ROCKETCHAT_SERVERS`** — 1 台なら URL をそのまま、複数なら `{id, name, url, publicUrl}` の JSON 配列。
- **`SESSION_SECRET`** — 32 文字以上で、再起動をまたいで不変であること。さもないとデプロイのたびに全セッションが失われます。

セッションは既定でメモリ上に保持されます。複数インスタンスで動かす場合は `REDIS_URL` を設定してください。

フロントエンドが別サイトにある場合は `SESSION_COOKIE_SAMESITE=none`（`Secure` が強制されるため HTTPS が必須になります）を設定し、そのオリジンを `CORS_ORIGINS` に列挙してください。

## 互換性

Rocket.Chat 8.6.1 に対して end-to-end で検証しています。アダプター層は 6.x 以降を対象とし、両者が食い違う箇所ではゲートウェイが実行時に探査し、その結果をサーバーごとにキャッシュします。サーバーが本当にその機能を持たない場合は、紛らわしい 404 ではなく `unsupported_by_server` というエラーコードを返します。

### Omnichannel は対象外です

Rocket.Chat の `/v1/livechat/*` API はひとつもラップしていません。キュー、振り分け、部門、転送、定型応答、会話履歴、訪問者レコードのいずれもありません。存在するのは通常のルーム処理に付随する範囲だけです。`t: 'l'` のルームは `omnichannel` というルーム種別に正規化されるため、エージェント自身の Omnichannel ルームは他と同じように一覧・閲覧・送信でき、Livechat のシステムメッセージも型付きイベントとして流れてきます。

Omnichannel へのコントリビューションを歓迎します。作業はこのリポジトリから始めてください。API ルートがなければ、[クライアント](https://github.com/zscontributor/open-rocket-chat-client) から機能を利用できないためです。スキーマは `packages/api-contract`、正規化は `packages/rc-adapter`、ルートは `apps/gateway` に追加します。Rocket.Chat の Livechat エンドポイントはほかの領域より変更が多いため、バージョン文字列で分岐せず、実行時に対応状況を確認してください。詳しくは [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。API の定義を変更する場合は、クライアント側にも対応するプルリクエストが必要です。

## 開発

```bash
pnpm run build          # 全パッケージとゲートウェイ
pnpm run typecheck
pnpm run test           # ユニットテスト
pnpm run test:e2e       # 実物の Rocket.Chat を動かす。`pnpm run rc:up` が必要
pnpm run rc:down
```

`pnpm run test:e2e` はモックではなく、実際の Rocket.Chat サーバーを使います。サインイン、メッセージの送信・編集、リアクション、ファイルのアップロード、削除、リアルタイム配信まで確認します。モックだけでは、Rocket.Chat に対するこちらの想定をそのままテストすることになり、実際のバージョン差や挙動の違いを検出できないためです。

## 依存パッケージとライセンス

直接依存しているランタイムパッケージと、その用途です。バージョンは `package.json` にあります。

| パッケージ                                                | 用途                                                         | ライセンス |
| --------------------------------------------------------- | ------------------------------------------------------------ | ---------- |
| `@nestjs/core` · `common` · `config` · `platform-fastify` | アプリケーションフレームワーク                               | MIT        |
| `fastify`                                                 | その下で動く HTTP サーバー                                   | MIT        |
| `@fastify/cookie` · `cors` · `helmet` · `multipart`       | セッションクッキー、CORS、セキュリティヘッダー、アップロード | MIT        |
| `ws`                                                      | `/ws` サーバーと、上流への DDP 接続                          | MIT        |
| `ioredis`                                                 | 複数インスタンス時の共有セッションストア                     | MIT        |
| `pino` · `pino-http` · `nestjs-pino`                      | 構造化ログ                                                   | MIT        |
| `zod`                                                     | 契約スキーマ。境界で検証します                               | MIT        |
| `rxjs`                                                    | Nest のインターセプターとパイプの処理系                      | Apache-2.0 |
| `reflect-metadata`                                        | Nest が依存するデコレーターのメタデータ                      | Apache-2.0 |

ビルドとテストのみで使うもの:

| パッケージ                        | 用途                        | ライセンス |
| --------------------------------- | --------------------------- | ---------- |
| `typescript`                      | 型                          | Apache-2.0 |
| `vitest`                          | ユニットテストと E2E テスト | MIT        |
| `tsup`                            | パッケージのビルド          | MIT        |
| `@nestjs/cli` · `@nestjs/testing` | 雛形生成とテストハーネス    | MIT        |
| `pino-pretty`                     | 開発時の読みやすいログ      | MIT        |
| `eslint` · `prettier` · `turbo`   | Lint・整形・ビルド          | MIT        |

**本番ツリー全体は 92 パッケージ**です。内訳は MIT が 76、ISC が 5、Apache-2.0 が 4（`rxjs`、`reflect-metadata`、`cluster-key-slot`、`denque`）、BSD-3-Clause が 4（`fast-uri`、`ieee754`、`light-my-request`、`secure-json-parse`）、BSD-2-Clause が 2（`dotenv`、`dotenv-expand`）、0BSD が 1（`tslib`）。デプロイするものにコピーレフトのライセンスはひとつも含まれません。

ビルドとテストのツールを含めると 462 パッケージになりますが、依然として大半が MIT です。MPL-2.0 が 2 件（`lightningcss`）と CC-BY-4.0 のデータセットが 1 件（`caniuse-lite`）ありますが、いずれもビルド時にのみ存在します。

ライセンスが重要な判断材料になる場合は、この表を信じるのではなく手元で生成し直してください。

```bash
pnpm licenses list --prod          # デプロイされるもの
pnpm licenses list                 # ツールを含めたすべて
```

本プロジェクト自体は MIT です。コントリビューションも同じ条件で受け入れます。

## コントリビューション

パッチを歓迎します。本リポジトリは Git Flow に従います。`develop` からブランチを切り、`develop` に向けてプルリクエストを開き、マージはレビュアーに任せてください。`main` にはリリース済みバージョンだけが載ります。ブランチモデル、レイヤリングの規則、事前に実行するチェックは [CONTRIBUTING.md](CONTRIBUTING.md) に、それらのルールを GitHub 上でどう強制しているかは [docs/branch-protection.md](docs/branch-protection.md) にあります。`packages/api-contract` の変更にはクライアント側リポジトリの対応するプルリクエストが必要なので、説明にその旨を書いてください。

脆弱性は公開の issue やプルリクエストではなく、[SECURITY.md](SECURITY.md) の手順に従って報告してください。

## ライセンス

MIT © [Z-SOFT Co., Ltd.](https://z-soft.com.vn) — [LICENSE](LICENSE) を参照してください。
