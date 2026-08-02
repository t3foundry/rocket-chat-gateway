# Open Rocket.Chat Gateway

[English](README.md) · **Tiếng Việt** · [日本語](README.ja.md)

Một lớp backend dành riêng cho frontend, đặt giữa ứng dụng và máy chủ [Rocket.Chat](https://rocket.chat). Gateway cung cấp một API gọn nhẹ, ổn định giữa các phiên bản, cùng bộ SDK TypeScript được dùng để xây dựng chính gateway.

> **Không trực thuộc, không được bảo trợ hay hỗ trợ bởi Rocket.Chat Technologies Corp.**
> Đây là một dự án độc lập, do cộng đồng phát triển. "Rocket.Chat" là thương hiệu của chủ sở hữu tương ứng và chỉ được dùng ở đây để mô tả tính tương thích.

Frontend đi kèm nằm ở [open-rocket-chat-client](https://github.com/zscontributor/open-rocket-chat-client).

## Vì sao cần một gateway

Trình duyệt có thể kết nối trực tiếp với Rocket.Chat, nhưng khi đó mỗi client phải tự giải quyết ba vấn đề sau:

**Token xác thực phải nằm trong trình duyệt.** REST API của Rocket.Chat dùng các header `X-Auth-Token` và `X-User-Id`, vì vậy client chạy trực tiếp trong trình duyệt phải lưu một token có thời hạn dài và có toàn quyền truy cập tài khoản. Chỉ cần một lỗ hổng XSS là token có thể bị đánh cắp. Gateway giữ token ở phía máy chủ; trình duyệt chỉ nhận một cookie phiên `HttpOnly` mà JavaScript không thể đọc.

**API thay đổi theo phiên bản.** Các endpoint có thể được đổi tên hoặc thay thế qua từng bản phát hành. Chẳng hạn, quy trình tải tệp đã chuyển từ `rooms.upload/:rid` sang hai bước `rooms.media` và `rooms.mediaConfirm`, nhưng trên thực tế vẫn có máy chủ dùng mỗi kiểu. Gateway tự phát hiện kiểu mà máy chủ hỗ trợ và che đi khác biệt đó với client.

**Mô hình dữ liệu mang theo nhiều chi tiết của Meteor.** Loại phòng được biểu diễn bằng một ký tự cùng hai cờ riêng; trạng thái đã đọc nằm trong bản ghi `subscription`, tách khỏi bản ghi phòng; thời gian là chuỗi ISO khi đi qua REST nhưng lại có dạng `{ $date }` qua WebSocket. Nếu kết nối trực tiếp, client nào cũng phải tự chuẩn hoá những khác biệt này. Gateway xử lý một lần để tất cả client cùng sử dụng.

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

Hỗ trợ nhiều máy chủ Rocket.Chat trong một phiên là một phần cốt lõi của kiến trúc. Đăng nhập thêm bằng cùng cookie sẽ bổ sung một máy chủ vào phiên; `X-Server-Id` xác định mỗi request sẽ gửi tới đâu; còn một WebSocket duy nhất nhận sự kiện từ tất cả máy chủ. Các máy chủ Rocket.Chat vẫn là những bản triển khai bình thường, không cần sửa đổi và không biết gì về nhau. Vì id phòng chỉ duy nhất trong phạm vi một máy chủ, mọi request đều phải xác định máy chủ đích. Trình duyệt trong sơ đồ là [open-rocket-chat-client](https://github.com/zscontributor/open-rocket-chat-client), nhưng API không phụ thuộc riêng vào client đó.

## Bạn nhận được gì

| Package                                | Mục đích                                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `@open-rocket-chat/api-contract`       | Mô hình dữ liệu, giao kèo HTTP và sự kiện thời gian thực dưới dạng schema Zod. Gateway và các client dùng chung. |
| `@open-rocket-chat/rc-rest-client`     | Client có đầy đủ kiểu dữ liệu cho REST API của Rocket.Chat, không phụ thuộc thư viện ngoài.                      |
| `@open-rocket-chat/rc-realtime-client` | Client DDP qua WebSocket, hỗ trợ kết nối lại và khôi phục đăng ký sự kiện.                                       |
| `@open-rocket-chat/rc-adapter`         | Chuẩn hoá dữ liệu Rocket.Chat thành mô hình dùng chung.                                                          |
| `apps/gateway`                         | Dịch vụ NestJS + Fastify kết nối các thành phần trên.                                                            |

Bạn cũng có thể dùng riêng từng package. Nếu chỉ cần một SDK Rocket.Chat có kiểu dữ liệu đầy đủ mà không cần gateway, hãy dùng
`rc-rest-client` và `rc-realtime-client` cho script, bot hoặc một dịch vụ phía máy chủ khác.

Không nên dùng chúng trong trình duyệt với tài khoản thật, vì như vậy token Rocket.Chat có toàn quyền sẽ nằm ngay trên trang web.
Đó chính là rủi ro mà gateway được thiết kế để tránh. Xem [SECURITY.md](SECURITY.md).

## Bắt đầu nhanh

```bash
pnpm install
pnpm run build

# Rocket.Chat + MongoDB ở localhost:3000, admin/admin-password-123
pnpm run rc:up

cp apps/gateway/.env.example apps/gateway/.env
pnpm --filter @open-rocket-chat/gateway dev
```

Gateway chạy tại `http://localhost:4000`, cung cấp HTTP API dưới `/api/v1` và kết nối thời gian thực tại `/ws`.

```bash
curl -c jar -X POST http://localhost:4000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"user":"admin","password":"admin-password-123"}'

curl -b jar http://localhost:4000/api/v1/rooms

# Đăng nhập lần nữa với cùng cookie sẽ thêm một server thứ hai vào phiên,
# và `X-Server-Id` khi đó chọn request tác động lên server nào.
curl -b jar -c jar -X POST http://localhost:4000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"serverId":"contoso","user":"admin","password":"admin-password-123"}'

curl -b jar -H 'x-server-id: contoso' http://localhost:4000/api/v1/rooms
```

## API

Mọi route đều nằm dưới `/api/v1`. Ngoại trừ `auth/login`, `auth/login/oauth`, `auth/servers` và `health`, tất cả route đều yêu cầu cookie phiên.

Một phiên có thể đăng nhập vào nhiều máy chủ Rocket.Chat cùng lúc. Mỗi request dùng header **`X-Server-Id`** để chọn máy chủ đích; nếu bỏ qua, gateway dùng máy chủ mặc định của phiên. Với hệ thống chỉ có một máy chủ, bạn không cần làm gì thêm. Nếu phiên chưa đăng nhập vào máy chủ được yêu cầu, gateway trả về `401` thay vì `404`: tài nguyên có thể vẫn tồn tại nhưng người gọi hiện không có quyền truy cập. Các route media nhận `?serverId=` thay cho header vì trình duyệt không thể gắn header tuỳ chỉnh vào thẻ `<img>`.

| Method           | Đường dẫn                                            | Mục đích                                                                   |
| ---------------- | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| `GET`            | `auth/servers`                                       | Các server đã cấu hình, kèm phương thức đăng nhập mà mỗi server hỗ trợ     |
| `POST`           | `auth/login`                                         | Đăng nhập; nếu đã có cookie thì thêm một server vào phiên                  |
| `POST`           | `auth/login/oauth`                                   | Hoàn tất đăng nhập OAuth bằng cặp credential của Rocket.Chat               |
| `GET`            | `auth/session`                                       | Mọi kết nối server, và server nào là mặc định                              |
| `POST`           | `auth/logout`                                        | Ngắt một server, hoặc toàn bộ                                              |
| `GET`            | `server/capabilities`                                | Server này hỗ trợ những gì, thăm dò một lần rồi nhớ lại                    |
| `GET`            | `rooms`                                              | Dữ liệu sidebar: phòng đã tham gia, trạng thái đăng ký và đồng bộ thay đổi |
| `POST`           | `rooms`                                              | Tạo một kênh hoặc nhóm riêng tư                                            |
| `GET`/`PATCH`    | `rooms/:roomId`                                      | Một phòng; đổi tên, chủ đề, thông báo, mô tả                               |
| `POST`           | `rooms/direct`                                       | Mở hoặc tạo một tin nhắn trực tiếp                                         |
| `POST`           | `rooms/:roomId/read` \| `/unread`                    | Xoá badge chưa đọc, hoặc đánh dấu phòng chưa đọc trở lại                   |
| `PATCH`          | `rooms/:roomId/state`                                | Yêu thích / ẩn                                                             |
| `POST`           | `rooms/:roomId/leave`                                | Rời phòng                                                                  |
| `GET`/`POST`     | `rooms/:roomId/members`                              | Thành viên (phân trang); thêm một người                                    |
| `PATCH`/`DELETE` | `rooms/:roomId/members/:userId`                      | Đổi vai trò của một thành viên; loại họ khỏi phòng                         |
| `GET`            | `rooms/:roomId/roles`                                | Phân công vai trò trong phòng                                              |
| `GET`            | `rooms/:roomId/files`                                | Tệp đã chia sẻ trong phòng, lọc được theo tên và loại                      |
| `GET`/`PATCH`    | `rooms/:roomId/notifications`                        | Tuỳ chọn thông báo riêng của phòng                                         |
| `POST`           | `rooms/:roomId/prune`                                | Xoá một khoảng tin nhắn                                                    |
| `GET`            | `rooms/:roomId/messages`                             | Lịch sử, neo theo `before` / `after`                                       |
| `POST`           | `rooms/:roomId/messages`                             | Gửi, tuỳ chọn `clientMessageId` và `threadId`                              |
| `PATCH`          | `rooms/:roomId/messages/:messageId`                  | Sửa                                                                        |
| `DELETE`         | `rooms/:roomId/messages/:messageId`                  | Xoá                                                                        |
| `PUT`/`DELETE`   | `rooms/:roomId/messages/:messageId/reactions/:emoji` | Thả cảm xúc                                                                |
| `POST`/`DELETE`  | `rooms/:roomId/messages/:messageId/pin` \| `/star`   | Đánh dấu                                                                   |
| `GET`            | `rooms/:roomId/threads`                              | Các tin nhắn gốc của luồng                                                 |
| `GET`            | `rooms/:roomId/pinned` · `/starred` · `/mentions`    | Ba danh sách tin nhắn, phân trang                                          |
| `GET`            | `rooms/:roomId/messages/search`                      | Tìm kiếm trong một phòng                                                   |
| `POST`           | `rooms/:roomId/files`                                | Upload (`multipart/form-data`, phần `file`)                                |
| `GET`            | `files/*` · `avatars/:username`                      | Media, proxy bằng credential phía server                                   |
| `GET`            | `emoji/custom`                                       | Emoji tuỳ chỉnh của máy chủ, kèm URL để client hiển thị                    |
| `GET`/`POST`     | `commands` \| `commands/run`                         | Các slash command server cung cấp, và chạy một lệnh                        |
| `GET`            | `users/:userIdOrUsername` · `users/search`           | Hồ sơ và gợi ý tên                                                         |
| `PATCH`          | `users/me/status`                                    | Trạng thái hiện diện và câu trạng thái của chính mình                      |
| `GET`            | `health` · `health/upstream`                         | Liveness và readiness                                                      |

Mọi lỗi đều tuân theo `ApiErrorSchema` và có `code` ổn định như `unauthorized`, `totp_required` hoặc `unsupported_by_server`, thay vì trả thẳng chuỗi lỗi của Rocket.Chat. Thông báo dành cho người dùng được chọn theo `Accept-Language`, hiện hỗ trợ tiếng Anh và tiếng Nhật. Các trường `code`, định danh `upstream` và `details` có cấu trúc không thay đổi theo ngôn ngữ, vì vậy client có thể dựa vào chúng để xử lý logic. Xem [docs/i18n.md](docs/i18n.md).

### Đăng nhập OAuth

Với mỗi máy chủ, `auth/servers` cho biết có cho phép đăng nhập bằng mật khẩu hay không (`passwordLoginEnabled`) và những nhà cung cấp OAuth nào đang bật (`loginServices`). Mỗi dịch vụ đi kèm một `authorizeUrl` có thể mở ngay. Gateway tự tìm endpoint của nhà cung cấp từ cấu hình Rocket.Chat, nên client chỉ cần hiển thị nút đăng nhập mà không phải biết chi tiết riêng của Google hay GitLab. Những dịch vụ không tương thích với luồng này, gồm OAuth 1.0a của Twitter, SAML, CAS, LDAP và Apple, sẽ không được trả về.

Quá trình xác thực OAuth không đi qua gateway, vì Rocket.Chat mới là nơi giữ client secret của nhà cung cấp. Trình duyệt mở `authorizeUrl` với `state` bằng `base64({loginStyle: 'popup', credentialToken, isCordova: false})`; sau đó nhà cung cấp chuyển hướng về callback `/_oauth/<service>` của Rocket.Chat. Callback lưu một credential secret trong bộ nhớ thuộc origin Rocket.Chat. Client đọc giá trị đó rồi gửi `{credentialToken, credentialSecret}` tới `auth/login/oauth` để tạo phiên.

**Vì vậy, client trên trình duyệt phải được phục vụ cùng origin với Rocket.Chat** để đọc kết quả xác thực. Bạn cần đặt gateway và client phía sau cùng một host với máy chủ Rocket.Chat; nếu không, hãy tắt OAuth và dùng đăng nhập bằng mật khẩu. URL chuyển hướng được tạo từ `Site_Url` của Rocket.Chat, nên giá trị này phải đúng với địa chỉ mà người dùng thực sự truy cập.

### Realtime

Kết nối WebSocket tới `/ws` với cùng session cookie. Gateway gửi các sự kiện JSON (`connection.ready`, `message.created`, `message.updated`, `message.deleted`, `room.updated`, `room.removed`, `typing.changed`, `presence.changed`, `room.read`, `notification`) và nhận các lệnh (`room.subscribe`, `room.unsubscribe`, `typing.set`, `ping`).

Gateway chỉ gửi sự kiện của phòng sau khi client gọi `room.subscribe`. Kết nối từ gateway tới Rocket.Chat được dùng chung cho mọi WebSocket thuộc cùng một phiên. Vì vậy, mở năm tab vẫn chỉ tạo một kết nối tới mỗi máy chủ Rocket.Chat, thay vì năm. Kết nối dùng chung này cũng giúp số tin chưa đọc luôn được cập nhật trên cả những máy chủ chưa có tab nào đang mở.

Một WebSocket nhận sự kiện từ tất cả máy chủ mà phiên đã đăng nhập. Mỗi sự kiện và lệnh đều có `serverId` để xác định máy chủ tương ứng; riêng `ping` thuộc về kết nối WebSocket nên không cần trường này. Client nhận một sự kiện `connection.ready` cho từng máy chủ đã kết nối. Vì id phòng chỉ duy nhất trong phạm vi một máy chủ Rocket.Chat, gateway sẽ bỏ qua lệnh gửi tới máy chủ chưa gắn với WebSocket thay vì tự suy đoán.

Ba hành vi đáng biết:

- **`connection.degraded`** cho biết gateway đã mất kết nối với Rocket.Chat. Các sự kiện phát sinh trong thời gian gián đoạn _không_ được gửi lại; khi nhận `connection.ready` tiếp theo, client nên tải lại dữ liệu.
- **`gapBefore`** trong một trang tin nhắn cho biết kết quả truy vấn `after` không nối liền với dữ liệu hiện có. Rocket.Chat chỉ trả về các tin _mới nhất_ trong một khoảng thời gian, nên sau một lần mất kết nối quá lâu có thể xuất hiện khoảng trống. Khi đó, hãy tải lại phòng thay vì nối kết quả mới vào danh sách cũ.
- **`notification`** được gửi cho mọi phòng mà người dùng tham gia, không cần đăng ký trước. Rocket.Chat đã cân nhắc thiết lập thông báo, lượt nhắc tên, trạng thái hiện diện và mặc định của workspace để quyết định có nên thông báo hay không. Client nên dùng trực tiếp sự kiện này thay vì tự suy ra từ `message.created`, vì sự kiện đó chỉ được gửi cho các phòng đang được theo dõi.

## Cấu hình

Xem [`apps/gateway/.env.example`](apps/gateway/.env.example). Hai biến quan trọng nhất:

- **`ROCKETCHAT_SERVERS`** — URL trực tiếp nếu chỉ có một máy chủ, hoặc mảng JSON `{id, name, url, publicUrl}` nếu có nhiều máy chủ.
- **`SESSION_SECRET`** — chuỗi ít nhất 32 ký tự và phải giữ nguyên qua các lần khởi động lại; nếu thay đổi, tất cả phiên hiện có sẽ hết hiệu lực sau mỗi lần triển khai.

Phiên mặc định nằm trong bộ nhớ. Đặt `REDIS_URL` nếu chạy nhiều instance.

Nếu frontend nằm khác site, đặt `SESSION_COOKIE_SAMESITE=none` (kéo theo bắt buộc `Secure`, tức là cần HTTPS) và liệt kê origin của nó trong `CORS_ORIGINS`.

## Tương thích

Đã kiểm thử end-to-end với Rocket.Chat 8.6.1. Lớp adapter nhắm tới 6.x trở lên; ở chỗ hai bên khác nhau, gateway thăm dò lúc chạy và nhớ câu trả lời theo từng server. Khi một server thực sự không làm được điều gì đó, mã lỗi là `unsupported_by_server` chứ không phải một 404 gây khó hiểu.

### Chưa bao phủ Omnichannel

Không có phần nào của API `/v1/livechat/*` của Rocket.Chat được bọc ở đây — không hàng đợi, không định tuyến, không phòng ban, không chuyển tiếp, không câu trả lời mẫu, không bản ghi hội thoại hay hồ sơ khách. Thứ đang có chỉ là những gì cơ chế xử lý phòng thông thường mang theo: một phòng có `t: 'l'` được chuẩn hoá thành room type `omnichannel`, nên các phòng Omnichannel của chính agent vẫn liệt kê, đọc và gửi như mọi phòng khác, và system message của Livechat vẫn đi qua dưới dạng sự kiện có kiểu.

Đóng góp cho Omnichannel rất được hoan nghênh và nên bắt đầu từ repository này, vì [client](https://github.com/zscontributor/open-rocket-chat-client) cần có route để gọi trước. Đặt schema trong `packages/api-contract`, phần chuẩn hoá trong `packages/rc-adapter` và route trong `apps/gateway`. Các endpoint Livechat của Rocket.Chat thay đổi nhiều hơn những khu vực khác, vì vậy nên phát hiện khả năng hỗ trợ khi chạy thay vì rẽ nhánh theo chuỗi phiên bản. Xem [CONTRIBUTING.md](CONTRIBUTING.md); nếu thay đổi giao kèo API, bạn cũng cần gửi một pull request tương ứng ở repository client.

## Phát triển

```bash
pnpm run build          # toàn bộ package và gateway
pnpm run typecheck
pnpm run test           # unit test
pnpm run test:e2e       # điều khiển một Rocket.Chat thật; cần `pnpm run rc:up`
pnpm run rc:down
```

`pnpm run test:e2e` chạy trên một máy chủ Rocket.Chat thật, không phải môi trường giả lập. Bộ test đăng nhập, gửi và sửa tin nhắn, thả cảm xúc, tải tệp, xoá dữ liệu và kiểm tra việc phân phối sự kiện thời gian thực. Nếu chỉ dùng mock, các bài test sẽ lặp lại chính những giả định của chúng ta về Rocket.Chat, trong khi nhiệm vụ của gateway là xử lý đúng các khác biệt ngoài thực tế.

## Dependencies và giấy phép

Toàn bộ dependency runtime trực tiếp, kèm lý do chúng có mặt. Phiên bản nằm trong `package.json`.

| Package                                                   | Dùng để làm gì                                | Giấy phép  |
| --------------------------------------------------------- | --------------------------------------------- | ---------- |
| `@nestjs/core` · `common` · `config` · `platform-fastify` | Framework của ứng dụng                        | MIT        |
| `fastify`                                                 | HTTP server bên dưới                          | MIT        |
| `@fastify/cookie` · `cors` · `helmet` · `multipart`       | Session cookie, CORS, header bảo mật, upload  | MIT        |
| `ws`                                                      | Máy chủ `/ws` và kết nối DDP tới Rocket.Chat  | MIT        |
| `ioredis`                                                 | Kho phiên dùng chung khi chạy nhiều instance  | MIT        |
| `pino` · `pino-http` · `nestjs-pino`                      | Log có cấu trúc                               | MIT        |
| `zod`                                                     | Schema của giao kèo, dùng để kiểm tra đầu vào | MIT        |
| `rxjs`                                                    | Pipeline interceptor và pipe của Nest         | Apache-2.0 |
| `reflect-metadata`                                        | Metadata cho decorator mà Nest phụ thuộc      | Apache-2.0 |

Chỉ dùng khi build và test:

| Package                           | Dùng để làm gì               | Giấy phép  |
| --------------------------------- | ---------------------------- | ---------- |
| `typescript`                      | Kiểu tĩnh                    | Apache-2.0 |
| `vitest`                          | Unit test và test end-to-end | MIT        |
| `tsup`                            | Build các package            | MIT        |
| `@nestjs/cli` · `@nestjs/testing` | Scaffolding và bộ khung test | MIT        |
| `pino-pretty`                     | Log dễ đọc khi phát triển    | MIT        |
| `eslint` · `prettier` · `turbo`   | Lint, format, build          | MIT        |

**Toàn bộ cây production là 92 package**: 76 MIT, năm ISC, bốn Apache-2.0 (`rxjs`, `reflect-metadata`, `cluster-key-slot`, `denque`), bốn BSD-3-Clause (`fast-uri`, `ieee754`, `light-my-request`, `secure-json-parse`), hai BSD-2-Clause (`dotenv`, `dotenv-expand`) và một 0BSD (`tslib`). Không có giấy phép copyleft nào xuất hiện trong thứ bạn đem triển khai.

Tính cả công cụ build và test thì cây phụ thuộc là 462 package, vẫn chủ yếu là MIT, kèm hai mục MPL-2.0 (`lightningcss`) và một tập dữ liệu CC-BY-4.0 (`caniuse-lite`) chỉ tồn tại lúc build.

Nếu giấy phép là chuyện quan trọng với bạn, hãy tự sinh lại danh sách thay vì tin bảng này:

```bash
pnpm licenses list --prod          # thứ bạn triển khai
pnpm licenses list                 # tất cả, kể cả tooling
```

Bản thân dự án này dùng MIT. Đóng góp cũng được nhận theo cùng điều khoản.

## Đóng góp

Pull request luôn được chào đón. Repository dùng Git Flow: tạo nhánh từ `develop`, mở pull request trở lại `develop` và để reviewer thực hiện việc merge. Nhánh `main` chỉ chứa các phiên bản đã phát hành. [CONTRIBUTING.md](CONTRIBUTING.md) mô tả mô hình nhánh, quy tắc phân lớp và các lệnh cần chạy trước khi gửi; [docs/branch-protection.md](docs/branch-protection.md) giải thích cách GitHub thực thi các quy tắc đó. Nếu thay đổi `packages/api-contract`, bạn cần có một pull request tương ứng ở repository client và nên ghi rõ trong phần mô tả.

Lỗ hổng bảo mật gửi theo [SECURITY.md](SECURITY.md), không mở issue hay pull request công khai.

## Giấy phép

MIT © [Z-SOFT Co., Ltd.](https://z-soft.com.vn) Xem [LICENSE](LICENSE).
