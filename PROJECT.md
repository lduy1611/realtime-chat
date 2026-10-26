# realtime-chat — Project Overview

A self-hosted, authenticated room chat server with a dependency-free browser
client and an integration test suite that drives the real server over real sockets. This document
explains *why* it exists, *how* it is built, and *what was learned* building it. For setup and the
event reference see [README.md](README.md).

## 1. Problem Statement

Small teams, classrooms, hackathon groups and hobby communities regularly need a place to talk in
real time, and the usual answers are a poor fit:

- **Heavyweight SaaS** (Slack, Discord, Teams) brings accounts, workspaces, invitations, billing and
  data retention policies to what might be a two-hour need. Messages leave the organisation's
  infrastructure and live on someone else's servers.
- **HTTP polling** is the tempting "simple" alternative, but it burns bandwidth and server CPU
  asking "anything new?" hundreds of times a minute, and still feels laggy.
- **Naive WebSocket demos** typically broadcast whatever string the client sent straight into
  `innerHTML`, allow anyone to claim any name, and let a single client flood the room. They are
  trivially exploitable via XSS and spam the moment a second person connects.

realtime-chat targets that gap: a server you can run locally, with MySQL-backed accounts, sessions
and message history. Socket.IO pushes messages instead of polling, while the server treats every
client-supplied value as untrusted.

## 2. Purpose & Goals

The project was built to demonstrate that a production-minded real-time service can be small.
Success criteria:

| Goal | How it is met |
|------|---------------|
| Simple local setup | Express, Socket.IO and MySQL; settings are read from `.env` |
| Authenticated identity | Usernames are unique accounts; Socket.IO identity comes from the server session |
| Push, not poll | Socket.IO transports (WebSocket with long-polling fallback) |
| Safe by default | Server-side `escapeHtml`, 500-char cap, name regex, 5 msg/s per socket |
| Durable room history | Last 100 room messages are loaded from MySQL in the `join` acknowledgement |
| Verifiable behaviour | Jest integration tests against a real listening server and isolated test stores |

## 3. Who It's For / Use Cases

1. **Workshop or classroom backchannel** — an instructor runs `npm start` on a laptop; students join
   `#questions` by first name. Nothing to sign up for, and the chat vanishes when the process stops.
2. **Hackathon team room** — a team on a shared LAN wants a low-friction channel without inviting
   everyone to a corporate Slack. `/pm` covers quick side conversations.
3. **Internal tool inside a restricted network** — an organisation that cannot send chat data to
   third-party clouds deploys it behind its own reverse proxy.
4. **Support/watch-party overlay** — a streamer or event host embeds a throwaway room for the
   duration of a session; the bounded history and rate limiter keep it usable under load.
5. **Reference implementation** — engineers learning Socket.IO get a compact, tested example of
   rooms, acknowledgements, per-socket state and cleanup on disconnect.

## 4. How It Works

### Architecture

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

`src/index.js` is a five-line entry point; `createServer()` in `src/server.js` builds the Express
app, HTTP server, Socket.IO instance and `RoomStore` *without* binding a port, so tests can call it
with custom limits and listen on port `0`.

### Event flow

**join** — client emits `join {room}` with an ack callback. Socket.IO has already authenticated
the session. Username and account ID come from that session, never from the join payload. The server
validates the room, rejects a socket or account already in the room, stores the authenticated identity
on `socket.data`, calls `rooms.join()` and `socket.join()`, acks with
`{ ok, username, room, history }`, and fans out three things: a `system` message to *other* members
(`socket.to(room)`), `users:update` to the room, and `rooms:update` to everyone.

**message** — guarded in order: joined? → `limiter.allow()`? → is it a `/pm`? → `sanitizeMessage`.
A chat message is saved to MySQL with a database id and server timestamp, then emitted to the whole
room including the sender. The ack returns `{ ok: true, id }` so the client can correlate. Failed
writes are not broadcast, so clients are not told an unsaved message was accepted.

**typing** — a bare boolean; relayed as `{ username, isTyping }` via `socket.to(room)` so the
sender never sees their own indicator. The client debounces before sending `false`. On disconnect
the server emits `isTyping: false` on the user's behalf so stale "alice is typing…" lines cannot
linger.

**private message** — any text matching `PM_RE = /^\/pm\s+(\S+)\s+([\s\S]+)$/` goes to
`sendPrivate()`. It resolves the target with `rooms.findSocketId()` (case-insensitive), refuses
unknown users and self-messages, resolves the live target to an account ID, saves the message to
MySQL, then emits a `type: 'private'` message
to exactly two sockets: `io.to(targetId)` and the sender. Private messages are excluded from room
history queries.

**disconnect** — `rooms.leave()` drops the member and deletes the room when empty; a `system`
leave notice, a typing reset, `users:update` and `rooms:update` follow.

### In-memory state model (`src/rooms.js`)

```
RoomStore.rooms : Map<roomName, { users: Map<socketId, { id, username }> }>
```

Keying members by socket id makes disconnect cleanup O(1) and makes "which socket is bob?" a
linear scan over a small map. Message history is stored separately through the parameterised MySQL
queries in `src/messages.js`.
`summary()` and `users()` return sorted arrays so the UI is stable across updates.

### Key design decisions

- **Unique usernames per room, not globally.** Identity without accounts only needs to be
  unambiguous inside a conversation. `hasUsername` compares lower-cased so `Bob` and `bob` cannot
  coexist, while the same name may be used in different rooms.
- **Escape on the server, once.** `sanitizeMessage` trims, enforces the 500-character cap and
  HTML-escapes before the message is stored or broadcast. Every consumer, including history
  replay, receives already-safe text; the client relies on this before using `innerHTML` for chat
  bubbles, and uses `textContent` for everything else.
- **Per-socket sliding-window rate limiting.** Each connection gets its own `RateLimiter` instance
  in `socket.data.limiter`; `allow()` prunes timestamps older than `windowMs` and rejects the
  sixth message within a second with a clear error in the ack rather than silently dropping.
- **Durable history.** MySQL stores chat and private messages; each room join reads only the latest
  configured number of group messages. Private records are excluded from room history queries.
- **System messages as first-class messages.** Join/leave notices share the `Message` shape
  (`type: 'system'`) so the client has one render path and one ordering by `id`.
- **Acknowledgement callbacks for request/response interactions.** `join` and `message` use
  Socket.IO acks instead of separate error events, which keeps client code linear and makes the
  tests read like ordinary `await` calls.

### One message, end to end

1. Alice types `hello <world>` and presses Enter. `public/app.js` clears the typing timer, emits
   `typing false`, then `socket.emit('message', { text }, cb)`.
2. `server.js` finds `socket.data.room === 'general'`, `limiter.allow()` returns true, the text
   does not match `PM_RE`.
3. `sanitizeMessage` returns `{ text: 'hello &lt;world&gt;' }`.
4. The parameterised MySQL insert saves the chat and returns its database id.
5. The server builds `{ id, type: 'chat', room: 'general', timestamp, from, text }` and emits it
   with `io.to('general')` after the insert succeeds.
6. The ack `{ ok: true, id: 42 }` returns to Alice. Every tab in `general` (hers included) runs
   `appendMessage`, aligning the bubble right if `m.from === state.username`.
7. Carol joins a minute later and receives message 42 in `history` from her `join` ack.

## 5. Tech Stack & Why

| Layer | Choice | Why |
|-------|--------|-----|
| Runtime | Node.js ≥ 18 | Single language across server, client and tests; `node --watch` for dev |
| HTTP | Express 4 | Static files, authentication APIs and room/health endpoints |
| Real-time | Socket.IO 4 | Rooms, acks, auto-reconnect and transport fallback out of the box; a raw `ws` server would need all four re-implemented |
| Client | Vanilla HTML/CSS/JS | No build step; the whole UI is three files a reviewer can read in minutes |
| State | MySQL + in-memory online membership | Persistent messages with low-latency presence and socket lookups |
| Authentication | `bcryptjs`, `express-session`, MySQL session store | Bcrypt password hashes and server-side sessions with HttpOnly cookies |
| Tests | Jest + `socket.io-client` | Exercises APIs and the same Socket.IO wire protocol browsers use |

## 6. Testing & Quality

`tests/auth.test.js` covers account APIs, session cookies and authenticated sockets. `tests/chat.test.js`
uses an injected fake message store, and `tests/messages.test.js` verifies parameterised query
construction and row mapping. Together the suite contains **34 tests**. Tests use isolated memory
session/user stores and do not run the MySQL migration. The chat suite calls `createServer({ messageStore, userStore, sessionMiddleware })` and listens on
port `0`; each test connects real `socket.io-client` instances to the assigned port, so routing,
acks and room scoping are verified over an actual socket rather than through mocks.

Coverage includes account registration, password hashing, login/logout, session cookies, origin
checks, unauthenticated Socket.IO rejection, spoofed identity payloads, room membership, chat and PM
routing, persistence errors, reconnect synchronization, and parameterised message queries.

Run with `npm test` (`jest --runInBand --forceExit`; tests run serially because they share one
server instance).

## 7. Challenges & Learnings

- **Testing real-time code without flakiness.** Asserting on events that have not arrived yet is
  the classic trap. The suite wraps every signal in a promise: `once(client, event)`, a filtering
  `onceType(client, type)` for `message` payloads, and `emit()` returning the ack,
  so tests await concrete signals instead of sleeping.
- **Where to escape.** Escaping on the client is the common tutorial answer but leaves history,
  private messages and any future non-browser consumer unprotected. Moving it into
  `sanitizeMessage` and storing escaped text made the invariant "anything in `RoomStore` is safe
  to render" hold everywhere, at the cost of the client needing `innerHTML` for chat text only.
- **`socket.to()` versus `io.to()`.** They differ by exactly one recipient, the sender, and the
  right choice changes per event: chat messages use `io.to` so the sender sees their own bubble
  from the server's copy; typing and system notices use `socket.to`. Getting this wrong produces
  either duplicate bubbles or "you joined the room" notices.
- **Cleanup is most of the work.** The disconnect handler has to undo membership, fix the room
  list, fix the user list and cancel typing state. Keeping all per-connection state on
  `socket.data` (including the limiter) meant nothing needed a separate lookup table to tear down.

## 8. Future Improvements

- **Private history UI** — add a private-conversation view if users should browse saved PMs after
  reconnecting; stored private messages are not currently loaded into the room transcript.
- **Authentication** — optional JWT or magic-link sign-in for deployments that need stable
  identities, while keeping anonymous mode for throwaway rooms.
- **Horizontal scaling** — use `@socket.io/redis-adapter` and move `RoomStore` to Redis so
  multiple Node instances share rooms, presence and rate-limit counters.
- **Richer messages** — Markdown-lite formatting, link previews and file attachments with
  server-side size and type checks.
- **Moderation** — room owners, kick/mute, word filters, and an audit log endpoint.
- **Operational hardening** — structured logging, Prometheus metrics, CORS and origin checks on
  the Socket.IO handshake, and a Dockerfile.
- **Client polish** — unread counters per room, desktop notifications, message search over
  history, and an accessibility pass on keyboard navigation.
