# realtime-chat

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Socket.IO](https://img.shields.io/badge/socket.io-4.x-010101?logo=socket.io)](https://socket.io)
[![Express](https://img.shields.io/badge/express-4.x-000000?logo=express)](https://expressjs.com)
[![Tests](https://img.shields.io/badge/tests-34%20passing-4cd28a)](#running-tests)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A real-time chat application with rooms, built on **Express**, **Socket.IO** and **MySQL**, with a
dependency-free vanilla HTML/CSS/JS client. Registered users join rooms, see who is online, watch
typing indicators, receive recent history on join, and send private messages with a `/pm` command.
The server stores bcrypt password hashes and HttpOnly MySQL-backed sessions, escapes HTML, enforces
length limits and rate-limits chat and authentication attempts.

📄 See [PROJECT.md](PROJECT.md) for the problem statement, design and implementation walkthrough.

## Features

- **Rooms** – join any room by name; rooms are created on demand and removed when empty
- **Validated identities** – usernames and room names are 2–20 chars (`A-Z a-z 0-9 _ -`); usernames are unique per room (case-insensitive)
- **Live room list** – `GET /api/rooms` plus `rooms:update` pushes with user counts
- **Message broadcast** – every chat message carries an id, sender, room and server timestamp
- **System messages** – join/leave notices for the room
- **Typing indicator** – "alice is typing…" relayed to everyone else in the room
- **Online users sidebar** – kept in sync with `users:update`
- **Message history** – last 100 room messages are loaded from MySQL and delivered in the join acknowledgement
- **Private messages** – `/pm <user> <message>` delivers to one recipient, echoes to the sender, and is saved privately in MySQL
- **Sanitisation** – HTML is escaped server-side; messages are trimmed and capped at 500 characters
- **Rate limiting** – sliding window of 5 messages per second per socket
- **Reconnect recovery** – the client rejoins its room and fetches only missing group messages by database ID, suppressing duplicates
- **Connection status** – shows online, connection lost and reconnecting states
- **Graceful disconnects** – leave notices, user/room lists and typing state all clean up
- **Responsive dark UI** – collapsible sidebar on small screens, own messages aligned right, private messages highlighted

## UI at a glance

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

The join screen is a centred card with username and room inputs, inline validation errors, and clickable
chips showing the rooms that currently have people in them.

## Installation

```powershell
git clone https://github.com/gunjit-web/realtime-chat.git
cd realtime-chat
npm install
Copy-Item .env.example .env
```

### MySQL setup on Windows

1. Install and start MySQL Server. If it is already installed, open the Windows Services app and start the MySQL service if needed.
2. Open MySQL Workbench and connect to your local MySQL Server. Before any schema changes, select **Server → Data Export**, select `realtime_chat`, choose **Dump Structure and Data** and **Export to Self-Contained File**, then click **Start Export**. Keep the resulting backup outside the project.
3. Open `sql/init.sql` in Workbench and execute it if the database or original `messages` table has not been created yet.
4. Review and apply the migration files in order in Workbench: `001_accounts_sessions.sql`, `002_files.sql`, then `003_message_idempotency.sql`. They add the account/session/file tables and nullable idempotency columns/index; they do not delete or rewrite existing `messages` rows. The app performs read-only schema checks and does not run migrations at startup.
5. Copy `.env.example` to `.env`, then enter your MySQL host, port, username, password, and a new session secret. Do not commit `.env`.

Example `.env` for a local server:

```dotenv
PORT=3000
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_actual_mysql_password
DB_NAME=realtime_chat
SESSION_SECRET=
```

Generate a session secret locally in PowerShell with `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"` and paste the output into `.env`. Never paste the generated value into source code or commit it. For localhost over HTTP the session cookie is HttpOnly and SameSite=Lax without Secure; production mode requires HTTPS for Secure cookies.

Start the app with `npm start`. It checks MySQL and the `users`/`sessions`/`files` tables before listening on port 3000. If a reviewed migration has not been run, startup fails without changing the database. A failed history read prevents joining, and a failed message write prevents broadcast and returns an error to the sender. `npm test` uses fake stores and does not require MySQL.

### File sharing

Review `sql/migrations/002_files.sql` and run it manually in MySQL Workbench after taking a backup. It only adds the `files` metadata table and does not modify existing rows or tables. The app does not run migrations automatically. Signed-in members of a room can attach PNG/JPEG/GIF/WebP images, PDF, TXT, or DOCX files up to 10 MB. File bytes are saved under the server's `uploads/` directory (or `UPLOADS_DIR` if configured); this directory is not public. Downloads go through the authenticated `/api/files/:id/download` endpoint and require an active connection in that file's room. File history and reconnect sync use file IDs separately from chat message IDs.

After applying the reviewed migration, restart the app. Join a room and click **Attach file**. To demo with two clients, open `http://localhost:3000` in two browser profiles/windows, sign in as Alice and Bob, and join the same room. Upload from Alice; Bob should see the filename, size, and download control. Use the development disconnect controls on one client, send a file from the other while disconnected, then reconnect; the missed file should appear once. Do not copy files into `public/` or expose `uploads/` through a web server.

## Usage

```bash
npm start            # http://localhost:3000
PORT=8080 npm start  # custom port
npm run dev          # restarts on file changes (node --watch)
```

Open the URL in two or more browser tabs, register or sign in with separate accounts, choose the same room, and start chatting.
Type `/pm bob hello` to send a private message to `bob`.

### Demo Socket.IO reconnect on one laptop

Start the app in PowerShell with development mode enabled:

```powershell
$env:NODE_ENV = 'development'
npm start
```

Open `http://localhost:3000` in two tabs or browser windows. Join the same room as `alice` in one
client and `bob` in the other. In Alice's client, click **Simulate Disconnect**; only that browser's
Socket.IO connection is closed. Send a few group messages from Bob, then click **Reconnect** in
Alice's client. Alice rejoins and receives the missing room messages from MySQL, with message IDs
preventing duplicates. The Node.js process and MySQL remain running. The test controls are shown only
when `NODE_ENV=development`; they stay hidden in production and other modes.

### HTTP endpoints

| Method | Path          | Description                                  |
|--------|---------------|----------------------------------------------|
| GET    | `/`           | Chat client                                  |
| GET    | `/api/rooms`  | `[{ "name": "general", "users": 3 }, ...]`   |
| GET    | `/api/health` | `{ "status": "ok", "uptime": 12.3 }`         |
| POST   | `/api/auth/register` | Create an account and sign in                 |
| POST   | `/api/auth/login` | Sign in and rotate the session                   |
| POST   | `/api/auth/logout` | Destroy the session and its active sockets     |
| GET    | `/api/auth/me` | Return the current account                       |
| POST   | `/api/rooms/:room/files` | Upload one allowed file (multipart field `file`, max 10 MB) |
| GET    | `/api/files/:id/download` | Download a file after session and room-membership checks |

## Socket event reference

### Client → server

| Event     | Payload                        | Ack response                                                   |
|-----------|--------------------------------|----------------------------------------------------------------|
| `join`    | `{ room }`                      | `{ ok: true, username, room, history: Message[], files: FileMessage[] }` or `{ ok: false, error }` |
| `message` | `{ text }`                     | `{ ok: true, id }` or `{ ok: false, error }`                   |
| `files:sync` | `{ afterId }`                 | `{ ok: true, files: FileMessage[] }` for the joined room       |
| `typing`  | `boolean`                      | none                                                           |

`text` beginning with `/pm <user> ` is routed as a private message.

### Server → client

| Event          | Payload                                   | When                                              |
|----------------|-------------------------------------------|---------------------------------------------------|
| `message`      | `Message`                                 | Chat broadcast, private message, or system notice |
| `rooms:update` | `[{ name, users }]`                       | On connect and whenever any room's membership changes |
| `users:update` | `string[]` (sorted usernames)             | Sent to a room when someone joins or leaves it    |
| `typing`       | `{ username, isTyping }`                  | Relayed to other members of the sender's room     |

### Message shape

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

## Running tests

Integration tests spin up the real server on a random port and drive it with `socket.io-client`.

```bash
npm test
```

The suite covers authentication, cookie sessions, invalid Socket.IO connections, identity spoofing,
joining and validation, room updates, message delivery, history, private messaging, file upload/download,
file access checks, upload limits, invalid file data, and reconnect synchronization. Tests use in-memory
stores and temporary upload folders; they do not run MySQL migrations.

## Project structure

```
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
│   └── app.js          # client logic
├── tests/
│   ├── auth.test.js    # authentication and Socket.IO authorization tests
│   ├── chat.test.js    # Socket.IO integration tests using a fake store
│   ├── files.test.js   # authenticated file upload, download, and sync tests
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

## License

[MIT](LICENSE) © 2026 Gunjit
