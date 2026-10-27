# realtime-chat

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Socket.IO](https://img.shields.io/badge/socket.io-4.x-010101?logo=socket.io)](https://socket.io)
[![Express](https://img.shields.io/badge/express-4.x-000000?logo=express)](https://expressjs.com)
[![Tests](https://img.shields.io/badge/tests-34%20passing-4cd28a)](#running-tests)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Ứng dụng trò chuyện thời gian thực theo phòng, xây dựng bằng **Express**, **Socket.IO** và **MySQL**, với
client HTML/CSS/JS thuần, không cần thư viện giao diện bổ sung. Người dùng đã đăng ký có thể vào phòng,
xem ai đang trực tuyến, theo dõi trạng thái đang nhập, nhận lịch sử gần đây khi vào phòng và gửi tin riêng
bằng lệnh `/pm`. Máy chủ lưu mật khẩu dưới dạng hash bcrypt, dùng session lưu trong MySQL với cookie HttpOnly,
escape HTML, giới hạn độ dài tin và kiểm soát tốc độ gửi tin cũng như yêu cầu xác thực.

📄 Xem [PROJECT.md](PROJECT.md) để đọc bài toán, thiết kế và phần phân tích quá trình triển khai.

## Tính năng

- **Phòng chat** – người dùng vào phòng theo tên; phòng được tạo khi cần và không còn trong danh sách trực tuyến khi rỗng
- **Tài khoản và xác thực** – username, tên phòng dài 2–20 ký tự (`A-Z a-z 0-9 _ -`); username duy nhất trên toàn hệ thống, không phân biệt chữ hoa/thường
- **Đăng ký, đăng nhập và đăng xuất** – mật khẩu hash bằng bcryptjs; session lưu trong MySQL và được dùng để xác thực HTTP lẫn Socket.IO
- **Danh sách phòng trực tuyến** – `GET /api/rooms` và sự kiện `rooms:update` gửi số người trong từng phòng
- **Phát tin nhắn** – tin nhóm có ID cơ sở dữ liệu, người gửi, phòng và thời gian do máy chủ ghi nhận
- **Tin hệ thống** – thông báo thành viên vào hoặc rời phòng
- **Trạng thái đang nhập** – trạng thái của người dùng được chuyển tiếp đến các thành viên khác trong phòng
- **Danh sách người trực tuyến** – cập nhật bằng `users:update`
- **Lịch sử tin nhắn** – khi vào phòng, client nhận tối đa 100 tin nhóm gần nhất từ MySQL; tin riêng cũng được lưu trong MySQL nhưng không nằm trong lịch sử phòng chung
- **Tin nhắn riêng** – `/pm <user> <message>` gửi tin đến một người nhận và phản hồi cho người gửi
- **Đồng bộ sau reconnect** – client tham gia lại phòng, lấy các tin nhóm còn thiếu theo ID và tránh hiển thị trùng
- **Offline Message Queue** – tin nhóm Pending được lưu trước trong IndexedDB và hiển thị trạng thái Pending/Sent/Failed; sau khi đồng bộ lịch sử, client gửi tuần tự với `clientMessageId` ổn định để server chống lưu trùng
- **Truyền tệp** – hỗ trợ PNG/JPEG/GIF/WebP, PDF, TXT và DOCX tối đa 10 MB; metadata lưu trong MySQL, tải tệp qua endpoint cần xác thực
- **An toàn nội dung và giới hạn tốc độ** – máy chủ escape HTML, giới hạn tin nhắn 500 ký tự, giới hạn tốc độ gửi tin và kiểm soát yêu cầu xác thực
- **Trạng thái kết nối** – hiển thị online, mất kết nối và đang kết nối lại
- **Giao diện tối tương thích màn hình nhỏ** – sidebar thu gọn được; tin của mình căn phải và tin riêng được làm nổi bật

## Giao diện tổng quan

```
┌──────────────────────────────────────────────────────────────────────────┐
│ realtime-chat          ×  │ ☰  #general                         ● online │
│───────────────────────────│──────────────────────────────────────────────│
│ ROOMS                     │            · bob joined the room ·           │
│  #general             (3) │  alice  10:42                                │
│  #random              (1) │  ┌─────────────────────────┐                 │
│                           │  │ hey everyone            │                 │
│ ONLINE IN general         │  └─────────────────────────┘                 │
│  ● alice                  │                          you  10:43          │
│  ● bob                    │                 ┌──────────────────────────┐ │
│  ● carol                  │                 │ hi alice!                │ │
│                           │                 └──────────────────────────┘ │
│                           │  carol -> you  10:44                         │
│                           │  ╭─────────────────────────╮  (private)      │
│                           │  │ can you review my PR?   │                 │
│                           │  ╰─────────────────────────╯                 │
│───────────────────────────│  alice is typing...                          │
│ bob             [ Leave ] │ [ Message the room, or /pm user msg ] [Send] │
└──────────────────────────────────────────────────────────────────────────┘
```

Màn hình chọn phòng là một thẻ căn giữa, có ô nhập phòng, lỗi xác thực hiển thị ngay trên giao diện, các nút
phòng đang hoạt động và nút Logout. Màn hình đăng nhập/đăng ký được hiển thị trước khi người dùng vào phòng.

## Cài đặt

```powershell
git clone https://github.com/gunjit-web/realtime-chat.git
cd realtime-chat
npm install
Copy-Item .env.example .env
```

### Thiết lập MySQL trên Windows

1. Cài đặt và khởi động MySQL Server. Nếu đã cài, mở **Services** của Windows và khởi động dịch vụ MySQL khi cần.
2. Mở MySQL Workbench và kết nối đến MySQL Server trên máy. Trước khi đổi schema, chọn **Server → Data Export**, chọn `realtime_chat`, chọn **Dump Structure and Data** và **Export to Self-Contained File**, sau đó nhấn **Start Export**. Lưu bản sao lưu bên ngoài project.
3. Nếu database hoặc bảng `messages` ban đầu chưa tồn tại, mở `sql/init.sql` trong Workbench và chạy file này.
4. Đọc và chạy thủ công các migration theo thứ tự trong Workbench: `001_accounts_sessions.sql`, `002_files.sql`, rồi `003_message_idempotency.sql`. Các file này bổ sung bảng tài khoản/session/tệp và cột/index idempotency nullable; không xóa hay ghi lại các dòng `messages` cũ. Ứng dụng chỉ kiểm tra schema ở chế độ đọc và không tự chạy migration khi khởi động.
5. Sao chép `.env.example` thành `.env`, rồi nhập host, port, username, password MySQL và một session secret mới. Không commit `.env`.

Ví dụ `.env` khi chạy máy chủ cục bộ:

```dotenv
PORT=3000
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_actual_mysql_password
DB_NAME=realtime_chat
SESSION_SECRET=
```

Tạo session secret trong PowerShell bằng `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"` rồi dán kết quả vào `.env`. Không ghi giá trị này vào source code hoặc commit. Khi dùng HTTP trên localhost, cookie session có HttpOnly và SameSite=Lax, không có Secure; khi dùng HTTPS, cookie được đánh dấu Secure.

Trên PowerShell, chạy `npm start` để khởi động ứng dụng. Ứng dụng kiểm tra MySQL và các bảng `users`/`sessions`/`files` trước khi lắng nghe cổng 3000. Nếu migration cần thiết chưa được chạy, ứng dụng dừng mà không thay đổi database. Nếu đọc lịch sử thất bại, người dùng không thể vào phòng; nếu lưu tin nhắn thất bại, tin không được broadcast và máy khách nhận lỗi. `npm test` dùng store giả lập và không cần kết nối MySQL.

### Chia sẻ tệp

Đọc `sql/migrations/002_files.sql` và chạy thủ công trong MySQL Workbench sau khi sao lưu. Migration chỉ bổ sung bảng metadata `files`, không sửa bảng hoặc dòng dữ liệu hiện có. Ứng dụng không tự chạy migration. Thành viên đã đăng nhập và đang ở trong phòng có thể gửi ảnh PNG/JPEG/GIF/WebP, PDF, TXT hoặc DOCX, tối đa 10 MB. Nội dung tệp lưu trong thư mục `uploads/` của máy chủ (hoặc `UPLOADS_DIR` nếu đã cấu hình); thư mục này không public. Tải xuống qua endpoint cần xác thực `/api/files/:id/download` và yêu cầu người dùng đang tham gia phòng chứa tệp. Lịch sử và đồng bộ tệp dùng ID riêng, độc lập với ID tin nhắn.

Sau khi chạy migration đã kiểm tra, khởi động lại ứng dụng. Vào phòng và nhấn **Attach file**. Để demo hai máy khách trên laptop, mở `http://localhost:3000` trong hai hồ sơ/cửa sổ trình duyệt, đăng nhập Alice và Bob rồi vào cùng phòng. Gửi tệp từ Alice; Bob sẽ thấy tên, dung lượng và nút tải xuống. Dùng nút mô phỏng ngắt kết nối trong môi trường development, gửi tệp từ máy khách còn lại rồi kết nối lại; tệp bị lỡ sẽ xuất hiện một lần. Không chép tệp vào `public/` hoặc public thư mục `uploads/` qua web server.

### Hàng đợi tin nhắn offline và HTTPS trên điện thoại

Bản nháp tin nhóm được lưu trong IndexedDB trước khi xóa nội dung ô soạn. Hàng đợi Pending được phân tách theo ID tài khoản và phòng. Sau reconnect, client tham gia lại phòng bằng session đã xác thực, đồng bộ lịch sử rồi mới gửi lần lượt các tin Pending. Khi retry, ACK sử dụng lại UUID mật mã ban đầu; server chỉ xác nhận thành công sau khi MySQL lưu tin, và ID lặp không tạo bản ghi hoặc broadcast mới. Chat riêng bằng `/pm` không được xếp hàng offline.

Khi truy cập từ điện thoại bằng `http://<laptop-LAN-IP>:3000`, trình duyệt không ở secure context. `crypto.randomUUID()` và hàng đợi offline cần HTTPS (hoặc localhost). Ứng dụng có thể tự phục vụ HTTPS khi đặt cả `HTTPS_KEY_FILE` và `HTTPS_CERT_FILE` trong `.env`; TLS cũng bật cookie session Secure. Trên Windows, có thể dùng `mkcert` tạo chứng thư cho IP LAN của laptop rồi cài CA cục bộ trên điện thoại Android:

```powershell
mkcert -install
New-Item -ItemType Directory -Force certs
$lanIp = Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias 'Wi-Fi' |
  Where-Object { $_.IPAddress -notlike '169.254*' -and $_.IPAddress -ne '127.0.0.1' } |
  Select-Object -First 1 -ExpandProperty IPAddress
mkcert -key-file certs/laptop-key.pem -cert-file certs/laptop-cert.pem localhost 127.0.0.1 $lanIp
mkcert -CAROOT
```

Đặt các giá trị `.env` sau (đường dẫn tính từ thư mục project):

```dotenv
HTTPS_KEY_FILE=certs/laptop-key.pem
HTTPS_CERT_FILE=certs/laptop-cert.pem
```

Chỉ chép `rootCA.pem` từ thư mục hiển thị bởi `mkcert -CAROOT` sang Android và cài trong phần cài đặt chứng thư/bảo mật của thiết bị. Giữ riêng `rootCA-key.pem` và `laptop-key.pem`; thư mục `certs/` đã được git-ignore. Khởi động ứng dụng rồi mở `https://<laptop-LAN-IP>:3000` trên điện thoại. Hai thiết bị phải cùng Wi-Fi và Windows Firewall phải cho phép kết nối đến TCP cổng 3000 trên mạng Private. Trình duyệt cần nhận diện HTTPS đáng tin cậy; bỏ qua cảnh báo chứng thư không đảm bảo trang được xem là secure context.

Trước khi xếp hàng, client kiểm tra `window.isSecureContext`, `crypto.randomUUID`/`crypto.getRandomValues` và IndexedDB. Nếu không có `randomUUID` nhưng có `getRandomValues` an toàn, client tạo UUID v4 từ nguồn ngẫu nhiên mật mã. Nếu môi trường không đáp ứng yêu cầu, giao diện hiển thị một cảnh báo và giữ nguyên nội dung chưa gửi trong ô soạn.

#### Truy cập qua Cloudflare Quick Tunnel

Cloudflare Quick Tunnel có thể cung cấp HTTPS công khai và chuyển tiếp đến Node.js đang chạy HTTP trên cùng laptop. Khi `cloudflared` chạy trên máy chủ, ứng dụng chỉ tin các header proxy từ kết nối loopback; kiểm tra origin vẫn so khớp chính xác host và protocol bên ngoài. Không cần bật CORS wildcard hoặc cho phép mọi hostname `trycloudflare.com`. Giữ nguyên URL HTTPS của tunnel trong suốt phiên đăng nhập để cookie session và Socket.IO dùng cùng origin.

## Cách sử dụng

```bash
npm start            # http://localhost:3000
PORT=8080 npm start  # custom port
npm run dev          # restarts on file changes (node --watch)
```

Mở URL trong ít nhất hai tab trình duyệt, đăng ký hoặc đăng nhập bằng các tài khoản riêng, chọn cùng phòng rồi bắt đầu trò chuyện.
Nhập `/pm bob hello` để gửi tin riêng cho `bob`.

### Demo reconnect Socket.IO trên một laptop

Trong PowerShell, bật chế độ development rồi chạy ứng dụng:

```powershell
$env:NODE_ENV = 'development'
npm start
```

Mở `http://localhost:3000` trong hai tab hoặc cửa sổ trình duyệt. Cho Alice và Bob vào cùng một phòng. Trong máy khách
của Alice, nhấn **Simulate Disconnect**; thao tác này chỉ ngắt Socket.IO của trình duyệt đó. Gửi vài tin nhóm từ Bob,
sau đó nhấn **Reconnect** ở máy khách Alice. Alice tham gia lại phòng và nhận các tin còn thiếu từ MySQL; ID tin nhắn
giúp loại bỏ bản trùng. Tiến trình Node.js và MySQL vẫn hoạt động. Các nút kiểm thử chỉ xuất hiện khi
`NODE_ENV=development`, không hiển thị trong production hoặc chế độ khác.

### Các endpoint HTTP

| Phương thức | Đường dẫn | Mô tả |
|--------|---------------|----------------------------------------------|
| GET | `/` | Giao diện chat |
| GET | `/api/rooms` | `[{ "name": "general", "users": 3 }, ...]` |
| GET | `/api/health` | `{ "status": "ok", "uptime": 12.3 }` |
| POST | `/api/auth/register` | Tạo tài khoản và đăng nhập |
| POST | `/api/auth/login` | Đăng nhập và cấp session mới |
| POST | `/api/auth/logout` | Hủy session và các socket đang hoạt động của session đó |
| GET | `/api/auth/me` | Trả về tài khoản hiện tại |
| POST | `/api/rooms/:room/files` | Tải lên một tệp được hỗ trợ (trường multipart `file`, tối đa 10 MB) |
| GET | `/api/files/:id/download` | Tải tệp sau khi kiểm tra session và quyền thành viên phòng |

## Tham chiếu sự kiện Socket.IO

### Máy khách gửi đến máy chủ

| Sự kiện | Payload | Phản hồi ACK |
|-----------|--------------------------------|----------------------------------------------------------------|
| `join` | `{ room }` | `{ ok: true, username, room, history: Message[], files: FileMessage[] }` hoặc `{ ok: false, error }` |
| `message` | `{ text, clientMessageId? }` | `{ ok: true, id }` hoặc `{ ok: false, error }` |
| `messages:sync` | `{ afterId }` | `{ ok: true, messages: Message[] }` gồm tin nhóm mới hơn ID đã nhận trong phòng hiện tại |
| `files:sync` | `{ afterId }` | `{ ok: true, files: FileMessage[] }` cho phòng đã tham gia |
| `typing` | `boolean` | không có |

`text` bắt đầu bằng `/pm <user> ` sẽ được xử lý như tin nhắn riêng. `clientMessageId` được dùng để chống lưu trùng khi gửi lại tin nhóm.

### Máy chủ gửi đến máy khách

| Sự kiện | Payload | Thời điểm gửi |
|----------------|-------------------------------------------|---------------------------------------------------|
| `message` | `Message` | Tin nhóm, tin riêng gửi/nhận hoặc thông báo hệ thống |
| `rooms:update` | `[{ name, users }]` | Khi kết nối và khi thành viên của phòng thay đổi |
| `users:update` | `string[]` (username đã sắp xếp) | Gửi đến phòng khi có người vào hoặc rời phòng |
| `typing` | `{ username, isTyping }` | Chuyển tiếp đến các thành viên khác trong phòng của người gửi |

### Cấu trúc Message

```js
{
  id: 42,                 // monotonically increasing per server
  type: 'chat',           // 'chat' | 'private' | 'system'
  room: 'general',
  timestamp: 1755950000000,
  from: 'alice',          // chat + private only
  to: 'bob',              // private only
  text: 'hello &lt;world&gt;'   // HTML-escaped
}
```

<a id="running-tests"></a>

## Chạy kiểm thử

Kiểm thử tích hợp khởi chạy máy chủ thật trên một cổng ngẫu nhiên và kết nối bằng `socket.io-client`.

```bash
npm test
```

Bộ kiểm thử bao gồm đăng ký/đăng nhập/đăng xuất, session cookie, từ chối kết nối Socket.IO không hợp lệ,
giả mạo danh tính, vào phòng và kiểm tra dữ liệu, cập nhật danh sách phòng, gửi tin, lịch sử, chat riêng,
tải lên/tải xuống tệp, kiểm tra quyền truy cập, giới hạn dung lượng, dữ liệu tệp sai, đồng bộ reconnect,
IndexedDB outbox và chống gửi trùng. Kiểm thử dùng store trong bộ nhớ và thư mục tải lên tạm; không chạy migration MySQL.

## Cấu trúc project

```

Cây trên giữ cấu trúc tổng quát. Các module bổ sung hiện có gồm `public/message-id.js` để tạo ID tin nhắn an toàn và
`tests/message-id.test.js` để kiểm tra module này.
realtime-chat/
├── src/
│   ├── index.js        # entry point, reads PORT
│   ├── server.js       # express + socket.io wiring and event handlers
│   ├── auth.js         # session middleware and authentication APIs
│   ├── users.js        # MySQL user store
│   ├── rooms.js        # in-memory online room membership
│   ├── db.js           # dotenv config and MySQL pool
│   ├── messages.js     # parameterised message persistence and history queries
│   ├── files.js        # file metadata queries and content checks
│   ├── rateLimit.js    # sliding-window RateLimiter
│   └── validate.js     # name validation, HTML escaping, message sanitisation
├── public/
│   ├── index.html      # join + chat screens
│   ├── style.css       # dark, responsive theme
│   ├── app.js          # client logic
│   └── outbox.js       # IndexedDB group-message queue
├── tests/
│   ├── auth.test.js    # authentication and Socket.IO authorization tests
│   ├── chat.test.js    # Socket.IO integration tests using a fake store
│   ├── files.test.js   # authenticated file upload, download, and sync tests
│   ├── outbox.test.js  # IndexedDB persistence, partitioning, and reload tests
│   └── messages.test.js # message store query tests
├── sql/
│   ├── init.sql        # original database and messages table setup
│   └── migrations/
│       ├── 001_accounts_sessions.sql # additive users and sessions tables
│       ├── 002_files.sql             # additive file metadata table
│       └── 003_message_idempotency.sql # nullable client id + unique account key
├── .env.example
├── package.json
├── LICENSE
└── README.md
```

## Giấy phép sử dụng

[MIT](LICENSE) © 2026 Gunjit
