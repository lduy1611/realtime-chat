# realtime-chat

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Socket.IO](https://img.shields.io/badge/socket.io-4.x-010101?logo=socket.io)](https://socket.io)
[![Express](https://img.shields.io/badge/express-4.x-000000?logo=express)](https://expressjs.com)
[![Tests](https://img.shields.io/badge/tests-22%20passing-4cd28a)](#running-tests)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A real-time chat application with rooms, built on **Express** and **Socket.IO** with a dependency-free
vanilla HTML/CSS/JS client. Users join a room under a unique username, see who is online, watch typing
indicators, receive recent history on join, and send private messages with a `/pm` command. The server
escapes HTML, enforces length limits and rate-limits each socket.

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
- **Graceful disconnects** – leave notices, user/room lists and typing state all clean up; the client re-joins automatically on reconnect
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
2. Open MySQL Workbench and connect to your local MySQL Server.
3. Open `sql/init.sql` in Workbench and execute it. It creates the `realtime_chat` database and UTF-8 `messages` table if they do not already exist; it does not drop existing data.
4. Edit the project `.env` file with your MySQL host, port, username and password. Do not commit `.env`.

Example `.env` for a local server:

```dotenv
PORT=3000
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_actual_mysql_password
DB_NAME=realtime_chat
```

Start the app with `npm start`. It verifies the MySQL connection before listening on port 3000. If MySQL is unavailable, startup fails with a connection error. A failed history read prevents joining, and a failed message write prevents broadcast and returns an error to the sender. `npm test` uses a fake message store and does not require MySQL.

## Usage

```bash
npm start            # http://localhost:3000
PORT=8080 npm start  # custom port
npm run dev          # restarts on file changes (node --watch)
```

Open the URL in two or more browser tabs, pick different usernames and the same room, and start chatting.
Type `/pm bob hello` to send a private message to `bob`.

### HTTP endpoints

| Method | Path          | Description                                  |
|--------|---------------|----------------------------------------------|
| GET    | `/`           | Chat client                                  |
| GET    | `/api/rooms`  | `[{ "name": "general", "users": 3 }, ...]`   |
| GET    | `/api/health` | `{ "status": "ok", "uptime": 12.3 }`         |

## Socket event reference

### Client → server

| Event     | Payload                        | Ack response                                                   |
|-----------|--------------------------------|----------------------------------------------------------------|
| `join`    | `{ username, room }`           | `{ ok: true, username, room, history: Message[] }` or `{ ok: false, error }` |
| `message` | `{ text }`                     | `{ ok: true, id }` or `{ ok: false, error }`                   |
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

22 tests cover joining and validation, room list API and live updates, broadcast scoping, sanitisation,
rate limiting, history delivery and capping, typing relay, private-message routing and persistence errors.

## Project structure

```
realtime-chat/
├── src/
│   ├── index.js        # entry point, reads PORT
│   ├── server.js       # express + socket.io wiring and event handlers
│   ├── rooms.js        # in-memory online room membership
│   ├── db.js           # dotenv config and MySQL pool
│   ├── messages.js     # parameterised message persistence and history queries
│   ├── rateLimit.js    # sliding-window RateLimiter
│   └── validate.js     # name validation, HTML escaping, message sanitisation
├── public/
│   ├── index.html      # join + chat screens
│   ├── style.css       # dark, responsive theme
│   └── app.js          # client logic
├── tests/
│   ├── chat.test.js    # Socket.IO integration tests using a fake store
│   └── messages.test.js # message store query tests
├── sql/
│   └── init.sql        # database and utf8mb4 table setup
├── .env.example
├── package.json
├── LICENSE
└── README.md
```

## License

[MIT](LICENSE) © 2026 Gunjit
