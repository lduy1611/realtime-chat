# realtime-chat — Tổng quan dự án

Máy chủ chat theo phòng có xác thực, tự triển khai được, đi kèm client trình duyệt không cần thư viện giao diện
bên ngoài và bộ kiểm thử tích hợp giao tiếp với máy chủ thật qua socket. Tài liệu này trình bày *lý do xây dựng*,
*cách triển khai* và *kinh nghiệm rút ra*. Xem [README.md](README.md) để biết cách cài đặt và tra cứu sự kiện.

## 1. Phát biểu bài toán

Nhóm nhỏ, lớp học, nhóm hackathon và cộng đồng sở thích thường cần một kênh trao đổi thời gian thực. Các giải pháp
phổ biến đôi khi không phù hợp:

- **Dịch vụ SaaS nhiều tính năng** (Slack, Discord, Teams) thường đi kèm workspace, lời mời, thanh toán và chính sách
  lưu trữ dữ liệu cho nhu cầu có thể chỉ kéo dài vài giờ. Tin nhắn rời khỏi hạ tầng của tổ chức và được lưu trên máy chủ bên ngoài.
- **HTTP polling** có vẻ là lựa chọn "đơn giản", nhưng tiêu tốn băng thông và CPU khi liên tục hỏi máy chủ
  "có gì mới không?", đồng thời vẫn tạo cảm giác trễ.
- **Ví dụ WebSocket sơ sài** thường đưa trực tiếp chuỗi do client gửi vào `innerHTML`, cho phép tự nhận bất kỳ tên nào
  và để một client gửi dồn dập. Cách làm đó dễ bị khai thác XSS và spam khi có người thứ hai tham gia.

realtime-chat hướng đến nhu cầu này: máy chủ có thể chạy cục bộ, tài khoản, session và lịch sử tin nhắn được lưu bằng
MySQL. Socket.IO chủ động đẩy dữ liệu thay cho polling; máy chủ xem mọi giá trị từ client là dữ liệu không đáng tin.

## 2. Mục đích và mục tiêu

Project minh họa rằng một dịch vụ thời gian thực có các biện pháp an toàn cơ bản vẫn có thể gọn nhẹ.
Các tiêu chí đạt được:

| Mục tiêu | Cách đáp ứng |
|------|---------------|
| Khởi động cục bộ đơn giản | Express, Socket.IO và MySQL; cấu hình được đọc từ `.env` |
| Danh tính đã xác thực | Tài khoản có username duy nhất; danh tính Socket.IO lấy từ session phía máy chủ |
| Đẩy dữ liệu thay cho polling | Socket.IO dùng WebSocket và có long-polling làm phương án dự phòng |
| An toàn mặc định | `sanitizeMessage` escape HTML, giới hạn 500 ký tự, regex kiểm tra tên và giới hạn 5 tin/giây/socket |
| Lịch sử phòng bền vững | Tin nhóm lưu trong MySQL; `join` trả tối đa 100 tin gần nhất, còn `messages:sync` lấy tin mới hơn cursor |
| Hành vi có thể kiểm chứng | Kiểm thử tích hợp Jest chạy máy chủ thật và store kiểm thử biệt lập |

## 3. Đối tượng và tình huống sử dụng

1. **Trao đổi trong lớp học hoặc workshop** – giảng viên chạy `npm start` trên laptop; sinh viên đăng nhập và cùng vào
   phòng `#questions`. Lịch sử tin nhóm được lưu trong MySQL sau khi máy chủ dừng.
2. **Phòng nhóm hackathon** – nhóm dùng chung LAN có kênh trao đổi riêng mà không cần mời toàn bộ thành viên vào dịch vụ khác.
   `/pm` hỗ trợ trao đổi nhanh giữa hai người.
3. **Công cụ nội bộ trong mạng hạn chế** – tổ chức không thể gửi dữ liệu chat lên dịch vụ đám mây bên ngoài có thể đặt ứng dụng
   sau reverse proxy được kiểm soát.
4. **Kênh trao đổi cho sự kiện** – người tổ chức tạo phòng trong thời gian diễn ra sự kiện; lịch sử giới hạn và rate limiter
   giúp duy trì khả năng sử dụng.
5. **Tài liệu tham khảo** – người học Socket.IO có ví dụ gọn, có kiểm thử về phòng, ACK, trạng thái từng socket và dọn dẹp khi ngắt kết nối.

## 4. Cơ chế hoạt động

### Kiến trúc

```
 Browser tab (public/app.js)            Node process (src/)
 ┌──────────────────────────┐   WebSocket   ┌──────────────────────────────────────┐
 │ join form → socket.emit  │ ◄═══════════► │ server.js                            │
 │ message input / typing   │   Socket.IO   │  io.on('connection') handlers        │
 │ renders 'message',       │               │    ├─ validate.js  (names, escaping) │
 │ 'users:update',          │               │    ├─ rateLimit.js (per socket)      │
 │ 'rooms:update', 'typing' │               │    └─ rooms.js     RoomStore         │
 └──────────────────────────┘               │         Map<room, {users, history}>  │
        ▲  GET / , /api/rooms, /api/health  │ express static + JSON endpoints      │
        └───────────────────────────────────┴──────────────────────────────────────┘
```

Sơ đồ trên tóm tắt luồng kết nối. Trong triển khai hiện tại, `RoomStore` chỉ quản lý thành viên trực tuyến; lịch sử tin nhắn nhóm
và riêng được lưu trong MySQL, không nằm trong map của `RoomStore`.

`src/index.js` là điểm khởi chạy ứng dụng: nạp cấu hình, kiểm tra kết nối/schema MySQL và tạo server. Hàm `createServer()`
trong `src/server.js` tạo Express app, HTTP hoặc HTTPS server, Socket.IO và `RoomStore` mà chưa mở cổng; nhờ vậy test có
thể truyền giới hạn tùy chỉnh và lắng nghe trên cổng `0`. `RoomStore` chỉ giữ thành viên trực tuyến; lịch sử tin nhắn nằm trong MySQL.

### Luồng sự kiện

**join** – client gửi `join {room}` cùng callback ACK. Middleware Socket.IO xác thực session trước đó. Username và ID tài khoản
lấy từ session, không lấy từ payload `join`. Máy chủ kiểm tra tên phòng, ngăn tài khoản đang hoạt động ở phòng mở thêm kết nối
không hợp lệ, lưu danh tính đã xác thực trong `socket.data`, gọi `rooms.join()` và `socket.join()`, rồi ACK kèm
`{ ok, username, room, history }`. Khi vào phòng mới, máy chủ gửi thông báo `system` đến các thành viên khác bằng
`socket.to(room)`, gửi `users:update` cho phòng và `rooms:update` cho mọi client. Khi cùng session reconnect, socket cũ chỉ được
thay thế khi client cung cấp đúng ID socket trước đó.

**message** – máy chủ kiểm tra theo thứ tự: đã vào phòng chưa, giới hạn tốc độ, nội dung có phải lệnh `/pm` không, sau đó
kiểm tra bằng `sanitizeMessage`. Tin nhóm được lưu vào MySQL với ID database và thời gian máy chủ trước khi phát đến cả phòng,
kể cả người gửi. ACK trả `{ ok: true, id }`. Với tin nhóm có `clientMessageId`, máy chủ kiểm tra tin đã lưu trước đó; nếu cùng
tài khoản gửi lại đúng nội dung/phòng thì trả ID cũ và không broadcast lại. Lỗi ghi MySQL không được broadcast.

**typing** – client gửi giá trị boolean; máy chủ chuyển tiếp `{ username, isTyping }` bằng `socket.to(room)` nên người gửi
không nhận trạng thái của chính mình. Client debounce trước khi gửi `false`. Khi ngắt kết nối, máy chủ thay người dùng gửi
`isTyping: false` để trạng thái cũ không bị giữ lại.

**private message** – nội dung khớp `PM_RE = /^\/pm\s+(\S+)\s+([\s\S]+)$/` được xử lý bởi `sendPrivate()`.
Máy chủ tìm người nhận đang trực tuyến trong phòng (không phân biệt hoa/thường), từ chối người nhận không tồn tại hoặc tự gửi
cho chính mình, lưu tin riêng vào MySQL rồi gửi `type: 'private'` đến socket của người nhận và người gửi. Tin riêng không xuất
hiện trong truy vấn lịch sử chung của phòng; hiện chưa có giao diện đồng bộ lịch sử tin riêng sau reconnect.

**disconnect** – `rooms.leave()` loại thành viên khỏi phòng và xóa phòng khỏi danh sách khi phòng rỗng; tiếp theo máy chủ gửi
thông báo rời phòng, reset trạng thái typing, cập nhật `users:update` và `rooms:update`.

### Mô hình trạng thái trong bộ nhớ (`src/rooms.js`)

```
RoomStore.rooms : Map<roomName, { users: Map<socketId, { id, username }> }>
```

Lưu thành viên theo socket ID giúp tra cứu và dọn socket cụ thể khi ngắt kết nối; việc tìm socket của một username là phép duyệt
qua map thành viên đang hoạt động. Bản ghi thành viên cũng chứa ID session để hỗ trợ phân biệt reconnect cùng session với phiên
đăng nhập khác. Lịch sử tin nhắn được truy vấn riêng bằng SQL có tham số trong `src/messages.js`. `summary()` và `users()` trả về
các mảng đã sắp xếp để giao diện ổn định giữa các lần cập nhật.

### Các quyết định thiết kế chính

- **Username duy nhất toàn hệ thống.** Tài khoản được lưu trong bảng `users`; username được kiểm tra không phân biệt hoa/thường.
  Một tài khoản chỉ có một socket hoạt động trong cùng phòng, ngoại trừ trường hợp socket cũ cùng session được thay thế khi reconnect.
- **Escape ở máy chủ.** `sanitizeMessage` cắt khoảng trắng, giới hạn 500 ký tự và escape HTML trước khi lưu hoặc phát tin. Lịch sử
  MySQL cũng trả văn bản đã xử lý; client dùng `innerHTML` cho nội dung chat đã escape và dùng `textContent` cho nội dung khác.
- **Giới hạn tốc độ dạng cửa sổ trượt theo socket.** Mỗi kết nối có một `RateLimiter` trong `socket.data.limiter`; `allow()` loại
  timestamp cũ hơn `windowMs` và từ chối tin vượt giới hạn bằng lỗi trong ACK.
- **Lịch sử bền vững.** MySQL lưu tin nhóm lẫn tin riêng. Khi `join`, ứng dụng đọc tối đa số tin nhóm được cấu hình (mặc định 100);
  `messages:sync` đọc các tin nhóm có ID lớn hơn cursor và không áp dụng giới hạn 100 tin. Tin riêng bị loại khỏi lịch sử phòng chung.
- **Thông báo hệ thống tạm thời.** Thông báo vào/rời phòng dùng dạng message `type: 'system'` để tái sử dụng luồng hiển thị,
  nhưng không phải bản ghi lịch sử MySQL.
- **ACK cho tương tác request/response.** `join` và `message` dùng ACK của Socket.IO thay vì sự kiện lỗi riêng, giúp luồng client
  tuyến tính và test có thể `await` như lời gọi thông thường.
- **Offline Message Queue có idempotency.** IndexedDB giữ tin nhóm Pending theo tài khoản/phòng. Client đợi đồng bộ lịch sử xong mới
  flush tuần tự; `clientMessageId` ổn định giúp retry an toàn khi ACK bị mất.

### Vòng đời một tin nhắn

1. Alice nhập `hello <world>` rồi nhấn Enter. `public/app.js` dừng timer typing và tạo UUID `clientMessageId` an toàn.
2. Client lưu bản nháp vào IndexedDB trước khi xóa nội dung ô nhập; bản ghi bắt đầu ở trạng thái Pending và gắn với tài khoản/phòng.
3. Nếu đang kết nối, client gửi `message` kèm `clientMessageId`. `server.js` xác nhận socket đã vào phòng và kiểm tra rate limit.
4. `sanitizeMessage` trả `{ text: 'hello &lt;world&gt;' }`; truy vấn MySQL có tham số lưu tin và trả ID database.
5. Sau khi lưu thành công, máy chủ tạo `{ id, type: 'chat', room: 'general', timestamp, from, text }`, broadcast bằng
   `io.to('general')` rồi gửi ACK `{ ok: true, id }`.
6. Các máy khách trong phòng hiển thị tin theo ID; client Alice đối chiếu `clientMessageId` để cập nhật dòng Pending thành Sent
   mà không thêm bản sao khi nhận cả event lẫn ACK.
7. Nếu ACK bị mất, client gửi lại cùng `clientMessageId`. Máy chủ trả ID đã lưu, không tạo bản ghi hoặc broadcast lần nữa.
8. Carol vào phòng sau đó sẽ nhận tối đa 100 tin gần nhất trong ACK `join`; các tin có ID mới hơn cursor được lấy bằng `messages:sync`.

## 5. Công nghệ sử dụng và lý do lựa chọn

| Tầng | Công nghệ | Lý do |
|-------|--------|-----|
| Runtime | Node.js ≥ 18 | Dùng chung một ngôn ngữ cho máy chủ, client và kiểm thử; hỗ trợ `node --watch` khi phát triển |
| HTTP | Express 4 | Phục vụ file tĩnh, API xác thực, phòng và health check |
| Thời gian thực | Socket.IO 4 | Có sẵn phòng, ACK, tự reconnect và dự phòng transport; nếu dùng `ws` thuần phải tự xây các phần này |
| Client | HTML/CSS/JS thuần | Không cần bước build; giao diện dễ đọc và kiểm tra trực tiếp |
| Trạng thái | MySQL và danh sách thành viên trong bộ nhớ | Tin nhắn được lưu bền vững; trạng thái online và tra cứu socket có độ trễ thấp |
| Xác thực | `bcryptjs`, `express-session`, MySQL session store | Hash mật khẩu bcrypt và lưu session phía máy chủ với cookie HttpOnly |
| Tải tệp | Multer và thư mục lưu trữ riêng | Kiểm tra giới hạn, loại tệp và quyền trước khi cung cấp tải xuống có xác thực |
| Hàng đợi offline | IndexedDB và `clientMessageId` | Lưu tin nhóm Pending trong trình duyệt và retry idempotent sau reconnect |
| Kiểm thử | Jest và `socket.io-client` | Kiểm thử API và giao thức Socket.IO mà trình duyệt sử dụng |

## 6. Kiểm thử và chất lượng

`tests/auth.test.js` kiểm tra API tài khoản, cookie session và socket đã xác thực. `tests/chat.test.js` dùng message store giả lập;
`tests/messages.test.js` kiểm tra truy vấn có tham số và ánh xạ dòng kết quả; `tests/files.test.js` kiểm tra truyền tệp;
`tests/outbox.test.js` và `tests/message-id.test.js` kiểm tra hàng đợi cùng ID an toàn. Test dùng store session/người dùng trong bộ nhớ
và không chạy migration MySQL. Bộ test chat gọi `createServer({ messageStore, userStore, sessionMiddleware })` rồi lắng nghe trên
cổng `0`; mỗi test kết nối client `socket.io-client` thật đến cổng được cấp, nhờ đó kiểm tra routing, ACK và phạm vi phòng trên
socket thật thay vì chỉ dùng mock.

Các nội dung được kiểm tra gồm đăng ký tài khoản, hash mật khẩu, login/logout, session cookie, kiểm tra origin, từ chối Socket.IO
chưa xác thực, payload giả mạo danh tính, thành viên phòng, định tuyến chat nhóm và PM, lỗi lưu trữ, reconnect, ACK mất, gửi trùng,
phân tách hàng đợi theo tài khoản/phòng, truyền tệp và truy vấn SQL có tham số.

Chạy bằng `npm test` (`jest --runInBand --forceExit`; các test chạy tuần tự vì dùng chung một server trong từng bộ kiểm thử).

## 7. Thách thức và kinh nghiệm

- **Kiểm thử thời gian thực ổn định.** Lỗi thường gặp là kiểm tra sự kiện trước khi nó đến. Bộ test bọc tín hiệu bằng promise:
  `once(client, event)`, `onceType(client, type)` để lọc payload `message`, và `emit()` để nhận ACK; nhờ đó test chờ tín hiệu cụ thể
  thay vì ngủ một khoảng thời gian cố định.
- **Vị trí escape dữ liệu.** Chỉ escape ở client sẽ không bảo vệ lịch sử, tin riêng hoặc các loại client khác. Đưa xử lý vào
  `sanitizeMessage` trước khi lưu/phát giúp mọi client nhận nội dung an toàn; client chỉ dùng `innerHTML` cho tin chat đã escape.
- **`socket.to()` và `io.to()`.** Hai phương thức khác nhau ở việc có gửi lại cho người gửi hay không. Tin chat dùng `io.to` để
  người gửi nhận bản tin từ server; typing và thông báo phòng dùng `socket.to`. Chọn sai có thể tạo bong bóng trùng hoặc thông báo
  người gửi tự tham gia phòng.
- **Dọn dẹp khi ngắt kết nối.** Handler disconnect phải xóa thành viên, cập nhật danh sách phòng/người dùng và reset typing. Lưu
  trạng thái từng kết nối trong `socket.data` (bao gồm rate limiter và session ID) giúp dọn đúng socket khi rời hoặc reconnect.
- **Retry cần idempotency.** ACK có thể mất sau khi database đã lưu tin. Giữ nguyên `clientMessageId`, kiểm tra nội dung/phòng ở
  máy chủ và không broadcast lại giúp retry mà không nhân đôi bản ghi hoặc tin hiển thị.

## 8. Hướng phát triển có thể xem xét

- **Giao diện lịch sử tin riêng** – thêm màn hình cuộc trò chuyện riêng nếu cần xem lại PM đã lưu sau reconnect; hiện tại PM không
  được nạp vào transcript phòng chung.
- **Mở rộng ngang** – dùng `@socket.io/redis-adapter` và chuyển `RoomStore` sang Redis để nhiều tiến trình Node chia sẻ phòng,
  presence và bộ đếm rate limit.
- **Định dạng tin nhắn phong phú hơn** – cân nhắc Markdown giới hạn, xem trước liên kết hoặc phản ứng tin nhắn.
- **Kiểm duyệt** – bổ sung chủ phòng, kick/mute, bộ lọc từ khóa và endpoint nhật ký kiểm toán.
- **Tăng cường vận hành** – logging có cấu trúc, metric Prometheus, kiểm tra origin cho handshake Socket.IO và Dockerfile.
- **Hoàn thiện client** – bộ đếm tin chưa đọc, thông báo desktop, tìm kiếm lịch sử và cải thiện khả năng truy cập bằng bàn phím.
