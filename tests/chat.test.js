'use strict';

const http = require('http');
const { io: Client } = require('socket.io-client');
const { createServer } = require('../src/server');
const { TestUserStore, TestFileStore, createTestSession } = require('./helpers');

let httpServer;
let io;
let url;
const clients = [];
let messageStore;
let userStore;
let fileStore;
let sessionMiddleware;

class TestMessageStore {
  constructor() { this.messages = []; this.nextId = 1; }
  async save(message) {
    if (message.clientMessageId) {
      const existing = this.messages.find((row) => row.userId === message.userId && row.clientMessageId === message.clientMessageId.toLowerCase());
      if (existing) {
        if (existing.type !== message.type || existing.room !== message.room || existing.text !== message.text) {
          const error = new Error('message ID conflict'); error.code = 'MESSAGE_ID_CONFLICT'; throw error;
        }
        return { id: existing.id, timestamp: existing.timestamp, duplicate: true };
      }
    }
    const saved = { ...message, clientMessageId: message.clientMessageId?.toLowerCase() ?? null, id: this.nextId++, timestamp: Date.now() };
    this.messages.push(saved);
    return { id: saved.id, timestamp: saved.timestamp, duplicate: false };
  }
  async findByClientMessageId(userId, clientMessageId) {
    const row = this.messages.find((item) => item.userId === userId && item.clientMessageId === clientMessageId.toLowerCase());
    return row ? { ...row, recipient: row.to, id: row.id } : null;
  }
  async getRoomHistory(room, limit) {
    return this.messages
      .filter((message) => message.type === 'chat' && message.room === room)
      .slice(-limit)
      .map(({ id, type, room: messageRoom, timestamp, from, text, clientMessageId }) => ({ id, type, room: messageRoom, timestamp, from, text, clientMessageId: clientMessageId ?? null }));
  }
  async getRoomMessagesAfter(room, afterId) {
    return this.messages
      .filter((message) => message.type === 'chat' && message.room === room && message.id > afterId)
      .map(({ id, type, room: messageRoom, timestamp, from, text, clientMessageId }) => ({ id, type, room: messageRoom, timestamp, from, text, clientMessageId: clientMessageId ?? null }));
  }
}

const apiRequest = (path, payload) =>
  new Promise((resolve, reject) => {
    const request = http.request(url + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: url }
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body), cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }));
    });
    request.on('error', reject);
    request.end(JSON.stringify(payload));
  });

const openSocket = async (cookie) => {
  const c = Client(url, { forceNew: true, transports: ['websocket'], extraHeaders: { Cookie: cookie } });
  clients.push(c);
  return new Promise((resolve) => c.on('connect', () => resolve(c)));
};

const connect = async (username) => {
  const result = await apiRequest('/api/auth/register', { username, password: 'TestPassword123!' });
  if (result.status !== 201) throw new Error(`Test account registration failed for ${username}: ${result.body.error}`);
  return openSocket(result.cookie);
};

const connectExisting = async (username) => {
  const result = await apiRequest('/api/auth/login', { username, password: 'TestPassword123!' });
  if (result.status !== 200) throw new Error(`Test account login failed for ${username}: ${result.body.error}`);
  return openSocket(result.cookie);
};

const emit = (c, event, payload) => new Promise((resolve) => c.emit(event, payload, resolve));
const once = (c, event) => new Promise((resolve) => c.once(event, resolve));
const onceType = (c, type) =>
  new Promise((resolve) => {
    const handler = (m) => {
      if (m.type !== type) return;
      c.off('message', handler);
      resolve(m);
    };
    c.on('message', handler);
  });
const join = (c, username, room) => emit(c, 'join', { username, room });

const getJsonAt = (baseUrl, path) =>
  new Promise((resolve, reject) => {
    http.get(baseUrl + path, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });
const getJson = (path) => getJsonAt(url, path);

beforeEach((done) => {
  messageStore = new TestMessageStore();
  userStore = new TestUserStore();
  fileStore = new TestFileStore();
  ({ sessionMiddleware } = createTestSession());
  ({ httpServer, io } = createServer({
    messageStore, fileStore, userStore, sessionMiddleware, historyLimit: 5,
    rateLimit: { limit: 3, windowMs: 1000 }
  }));
  httpServer.listen(0, () => {
    url = `http://localhost:${httpServer.address().port}`;
    done();
  });
});

afterEach((done) => {
  for (const c of clients.splice(0)) c.disconnect();
  io.close(() => done());
});

describe('join', () => {
  test('accepts a valid username and room and returns empty history', async () => {
    const c = await connect('alice');
    const res = await join(c, 'alice', 'general');
    expect(res).toEqual({ ok: true, username: 'alice', room: 'general', history: [], files: [] });
  });

  test('rejects invalid usernames and rooms', async () => {
    const c = await connect('alice');
    expect((await join(c, 'forged', 'bad room')).ok).toBe(false);
    expect(await join(c, 'forged', 'general')).toMatchObject({ ok: true, username: 'alice' });
  });

  test('returns a useful error when room history cannot be loaded', async () => {
    const c = await connect('alice');
    const logError = jest.spyOn(console, 'error').mockImplementation(() => {});
    messageStore.getRoomHistory = async () => { throw new Error('database unavailable'); };
    const res = await join(c, 'alice', 'general');
    expect(res).toEqual({ ok: false, error: 'Could not load chat history. Please try again.' });
    expect((await getJson('/api/rooms')).body).toEqual([]);
    logError.mockRestore();
  });

  test('rejects a duplicate username in the same room (case-insensitive)', async () => {
    const a = await connect('alice');
    const b = await connectExisting('alice');
    await join(a, 'alice', 'general');
    const res = await join(b, 'ALICE', 'general');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/already in this room/);
  });

  test('allows the same username in different rooms', async () => {
    const a = await connect('alice');
    const b = await connectExisting('alice');
    await join(a, 'alice', 'room-1');
    expect((await join(b, 'alice', 'room-2')).ok).toBe(true);
  });

  test('sends system messages on join and leave to other members', async () => {
    const a = await connect('alice');
    await join(a, 'alice', 'general');
    const b = await connect('bob');
    const joined = once(a, 'message');
    await join(b, 'bob', 'general');
    expect(await joined).toMatchObject({ type: 'system', text: 'bob joined the room' });

    const left = once(a, 'message');
    b.disconnect();
    expect(await left).toMatchObject({ type: 'system', text: 'bob left the room' });
  });
});

describe('rooms', () => {
  test('development controls are enabled only when the server is in development mode', async () => {
    expect((await getJson('/api/config')).body).toEqual({ developmentMode: false });

    const development = createServer({
      messageStore: new TestMessageStore(), userStore: new TestUserStore(), sessionMiddleware,
      developmentMode: true
    });
    await new Promise((resolve) => development.httpServer.listen(0, resolve));
    const developmentUrl = `http://localhost:${development.httpServer.address().port}`;
    try {
      expect((await getJsonAt(developmentUrl, '/api/config')).body).toEqual({ developmentMode: true });
    } finally {
      await new Promise((resolve) => development.io.close(resolve));
    }
  });

  test('GET /api/rooms lists rooms with user counts', async () => {
    const a = await connect('alice');
    const b = await connect('bob');
    await join(a, 'alice', 'general');
    await join(b, 'bob', 'general');
    const { status, body } = await getJson('/api/rooms');
    expect(status).toBe(200);
    expect(body).toEqual([{ name: 'general', users: 2 }]);
  });

  test('broadcasts rooms:update when users join and leave', async () => {
    const a = await connect('alice');
    const b = await connect('bob');
    const update = once(a, 'rooms:update');
    await join(b, 'bob', 'lobby');
    expect(await update).toEqual([{ name: 'lobby', users: 1 }]);

    const emptied = once(a, 'rooms:update');
    b.disconnect();
    expect(await emptied).toEqual([]);
  });

  test('sends users:update with the sorted member list', async () => {
    const a = await connect('zed');
    const b = await connect('amy');
    await join(a, 'zed', 'general');
    const update = once(a, 'users:update');
    await join(b, 'amy', 'general');
    expect(await update).toEqual(['amy', 'zed']);
  });
});

describe('messaging', () => {
  test('deduplicates a retry after a lost ACK and does not broadcast the saved row twice', async () => {
    const alice = await connect('alice');
    const bob = await connect('bob');
    await join(alice, 'alice', 'general');
    await join(bob, 'bob', 'general');
    const payload = { text: 'send once', clientMessageId: 'c8418fb5-8bde-4a4c-a6bb-930e34e47af2' };
    const firstBroadcast = onceType(bob, 'chat');
    const disconnected = once(alice, 'disconnect');
    const actualSave = messageStore.save.bind(messageStore);
    let didDisconnect = false;
    messageStore.save = async (message) => {
      const saved = await actualSave(message);
      if (message.clientMessageId === payload.clientMessageId && !didDisconnect) {
        didDisconnect = true;
        io.sockets.sockets.get(alice.id).disconnect(true);
      }
      return saved;
    };
    let firstAckReceived = false;
    alice.emit('message', payload, () => { firstAckReceived = true; });
    const delivered = await firstBroadcast;
    await disconnected;
    expect(firstAckReceived).toBe(false);

    const reconnected = once(alice, 'connect');
    alice.connect();
    await reconnected;
    expect((await join(alice, 'alice', 'general')).ok).toBe(true);
    const retryAck = await emit(alice, 'message', { ...payload, clientMessageId: payload.clientMessageId.toUpperCase() });

    expect(retryAck).toMatchObject({ ok: true, id: delivered.id, clientMessageId: payload.clientMessageId });
    expect(messageStore.messages.filter((row) => row.clientMessageId === payload.clientMessageId)).toHaveLength(1);
    const duplicateBroadcast = jest.fn();
    bob.on('message', duplicateBroadcast);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(duplicateBroadcast).not.toHaveBeenCalled();
  });

  test('rejects reusing a client message ID with different content or room', async () => {
    const alice = await connect('alice');
    await join(alice, 'alice', 'general');
    const clientMessageId = 'b7b068d5-a88f-49a0-9e09-dc59349bd341';
    const first = await emit(alice, 'message', { text: 'original', clientMessageId });
    const textConflict = await emit(alice, 'message', { text: 'changed', clientMessageId });
    expect(first.ok).toBe(true);
    expect(textConflict).toMatchObject({ ok: false, code: 'MESSAGE_ID_CONFLICT' });
    expect(messageStore.messages.filter((row) => row.clientMessageId === clientMessageId)).toHaveLength(1);

    const otherRoomClient = await connectExisting('alice');
    await join(otherRoomClient, 'alice', 'another-room');
    const roomConflict = await emit(otherRoomClient, 'message', { text: 'original', clientMessageId });
    expect(roomConflict).toMatchObject({ ok: false, code: 'MESSAGE_ID_CONFLICT' });
    expect(messageStore.messages.filter((row) => row.clientMessageId === clientMessageId)).toHaveLength(1);
  });

  test('scopes the same client message ID independently for different accounts', async () => {
    const alice = await connect('alice');
    const bob = await connect('bob');
    await join(alice, 'alice', 'general');
    await join(bob, 'bob', 'general');
    const clientMessageId = 'ef5b000e-96d6-4ce4-945a-89fae8232aad';
    const aliceResult = await emit(alice, 'message', { text: 'same text', clientMessageId });
    const bobResult = await emit(bob, 'message', { text: 'same text', clientMessageId });
    expect(aliceResult.ok).toBe(true);
    expect(bobResult.ok).toBe(true);
    expect(bobResult.id).not.toBe(aliceResult.id);
    expect(messageStore.messages.filter((row) => row.clientMessageId === clientMessageId)).toHaveLength(2);
  });

  test('validates supplied IDs while accepting legacy messages without clientMessageId', async () => {
    const alice = await connect('alice');
    await join(alice, 'alice', 'general');
    expect(await emit(alice, 'message', { text: 'bad id', clientMessageId: 'not-a-uuid' }))
      .toMatchObject({ ok: false, error: 'Invalid client message ID' });
    const oldClient = await emit(alice, 'message', { text: 'legacy client' });
    expect(oldClient.ok).toBe(true);
    expect(messageStore.messages.find((row) => row.text === 'legacy client')).toMatchObject({ clientMessageId: null, userId: 1 });
  });

  test('does not ACK success until the message store resolves', async () => {
    const alice = await connect('alice');
    await join(alice, 'alice', 'general');
    let finishSave;
    messageStore.save = () => new Promise((resolve) => { finishSave = resolve; });
    let acked = false;
    const resultPromise = emit(alice, 'message', { text: 'wait for MySQL' }).then((result) => { acked = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(acked).toBe(false);
    finishSave({ id: 987, timestamp: Date.now(), duplicate: false });
    expect((await resultPromise).ok).toBe(true);
  });

  test('broadcasts chat messages with sender and timestamp to the room only', async () => {
    const a = await connect('alice');
    const b = await connect('bob');
    const other = await connect('carol');
    await join(a, 'alice', 'general');
    await join(b, 'bob', 'general');
    await join(other, 'carol', 'elsewhere');

    const otherSpy = jest.fn();
    other.on('message', otherSpy);
    const received = once(b, 'message');
    const ack = await emit(a, 'message', { text: 'hello bob' });

    expect(ack.ok).toBe(true);
    const msg = await received;
    expect(msg).toMatchObject({ type: 'chat', from: 'alice', text: 'hello bob', room: 'general' });
    expect(typeof msg.timestamp).toBe('number');
    await new Promise((r) => setTimeout(r, 50));
    expect(otherSpy).not.toHaveBeenCalled();
  });

  test('escapes HTML and enforces length limits and non-empty text', async () => {
    const a = await connect('alice');
    await join(a, 'alice', 'general');
    const received = once(a, 'message');
    await emit(a, 'message', { text: '<b>hi</b>' });
    expect((await received).text).toBe('&lt;b&gt;hi&lt;/b&gt;');

    expect((await emit(a, 'message', { text: '   ' })).ok).toBe(false);
    expect((await emit(a, 'message', { text: 'x'.repeat(501) })).error).toMatch(/exceeds/);
    expect((await emit(a, 'message', { text: 42 })).ok).toBe(false);
  });

  test('rejects messages before joining a room', async () => {
    const a = await connect('alice');
    const res = await emit(a, 'message', { text: 'hi' });
    expect(res).toEqual({ ok: false, error: 'Join a room first' });
  });

  test('rate limits messages per socket', async () => {
    const a = await connect('alice');
    await join(a, 'alice', 'general');
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await emit(a, 'message', { text: `m${i}` }));
    expect(results.slice(0, 3).every((r) => r.ok)).toBe(true);
    expect(results[3].ok).toBe(false);
    expect(results[3].error).toMatch(/too quickly/);
  });
});

describe('history', () => {
  test('sends the most recent messages to a newly joined user', async () => {
    const a = await connect('alice');
    await join(a, 'alice', 'general');
    for (let i = 1; i <= 3; i++) {
      await emit(a, 'message', { text: `msg ${i}` });
    }
    const b = await connect('bob');
    const res = await join(b, 'bob', 'general');
    expect(res.history.map((m) => m.text)).toEqual(['msg 1', 'msg 2', 'msg 3']);
  });

  test('caps history at the configured limit', async () => {
    const a = await connect('alice');
    await join(a, 'alice', 'general');
    for (let i = 1; i <= 7; i++) {
      await emit(a, 'message', { text: `msg ${i}` });
      if (i % 3 === 0) await new Promise((r) => setTimeout(r, 1050));
    }
    const b = await connect('bob');
    const res = await join(b, 'bob', 'general');
    expect(res.history.map((m) => m.text)).toEqual(['msg 3', 'msg 4', 'msg 5', 'msg 6', 'msg 7']);
  });

  test('syncs only missing room messages after reconnect, excluding private messages', async () => {
    const alice = await connect('alice');
    const bob = await connect('bob');
    const carol = await connect('carol');
    await join(alice, 'alice', 'general');
    await join(bob, 'bob', 'general');
    await join(carol, 'carol', 'general');

    const firstMessage = onceType(alice, 'chat');
    await emit(bob, 'message', { text: 'already received' });
    const first = await firstMessage;
    const usersAfterDisconnect = once(bob, 'users:update');
    alice.disconnect();
    expect(await usersAfterDisconnect).toEqual(['bob', 'carol']);

    await new Promise((resolve) => setTimeout(resolve, 1050));
    await emit(bob, 'message', { text: '/pm carol private while alice is away' });
    await emit(bob, 'message', { text: 'missed one' });
    await emit(bob, 'message', { text: 'missed two' });

    const reconnected = once(alice, 'connect');
    alice.connect();
    await reconnected;
    const joined = await join(alice, 'alice', 'general');
    expect(joined.ok).toBe(true);
    const sync = await emit(alice, 'messages:sync', { afterId: first.id });

    expect(sync.ok).toBe(true);
    expect(sync.messages.map((message) => message.text)).toEqual(['missed one', 'missed two']);
    expect(sync.messages.every((message) => message.type === 'chat')).toBe(true);
  });

  test('rejects message sync requests without joining or with an invalid cursor', async () => {
    const c = await connect('alice');
    expect(await emit(c, 'messages:sync', { afterId: 0 })).toEqual({ ok: false, error: 'Join a room first' });
    await join(c, 'alice', 'general');
    expect(await emit(c, 'messages:sync', { afterId: -1 })).toEqual({ ok: false, error: 'Invalid message cursor' });
  });
});

describe('typing', () => {
  test('relays typing state to other room members but not the sender', async () => {
    const a = await connect('alice');
    const b = await connect('bob');
    await join(a, 'alice', 'general');
    await join(b, 'bob', 'general');

    const selfSpy = jest.fn();
    a.on('typing', selfSpy);
    const typing = once(b, 'typing');
    a.emit('typing', true);
    expect(await typing).toEqual({ username: 'alice', isTyping: true });

    const stopped = once(b, 'typing');
    a.emit('typing', false);
    expect(await stopped).toEqual({ username: 'alice', isTyping: false });
    expect(selfSpy).not.toHaveBeenCalled();
  });
});

describe('private messages', () => {
  test('deduplicates private message retries without re-broadcasting', async () => {
    const alice = await connect('alice');
    const bob = await connect('bob');
    await join(alice, 'alice', 'general');
    await join(bob, 'bob', 'general');
    const clientMessageId = '3d3a41c0-83e4-4a10-90f7-74b4ed2ae848';
    const received = onceType(bob, 'private');
    const first = await emit(alice, 'message', { text: '/pm bob private once', clientMessageId });
    expect(await received).toMatchObject({ id: first.id, clientMessageId });
    const duplicate = await emit(alice, 'message', { text: '/pm bob private once', clientMessageId });
    expect(duplicate).toMatchObject({ ok: true, id: first.id });
    expect(messageStore.messages.filter((row) => row.clientMessageId === clientMessageId)).toHaveLength(1);
  });

  test('/pm delivers only to the sender and the target', async () => {
    const a = await connect('alice');
    const b = await connect('bob');
    const c = await connect('carol');
    await join(a, 'alice', 'general');
    await join(b, 'bob', 'general');
    await join(c, 'carol', 'general');

    const carolSpy = jest.fn();
    c.on('message', (m) => m.type === 'private' && carolSpy(m));
    const toBob = onceType(b, 'private');
    const echo = onceType(a, 'private');
    const ack = await emit(a, 'message', { text: '/pm Bob secret <stuff>' });

    expect(ack.ok).toBe(true);
    const msg = await toBob;
    expect(msg).toMatchObject({ type: 'private', from: 'alice', to: 'bob', text: 'secret &lt;stuff&gt;' });
    expect(await echo).toMatchObject({ type: 'private', to: 'bob' });
    await new Promise((r) => setTimeout(r, 50));
    expect(carolSpy).not.toHaveBeenCalled();
  });

  test('/pm reports unknown users and self-messaging', async () => {
    const a = await connect('alice');
    await join(a, 'alice', 'general');
    expect((await emit(a, 'message', { text: '/pm nobody hi' })).error).toMatch(/not in this room/);
    expect((await emit(a, 'message', { text: '/pm alice hi' })).error).toMatch(/yourself/);
  });

  test('private messages are not stored in room history', async () => {
    const a = await connect('alice');
    const b = await connect('bob');
    await join(a, 'alice', 'general');
    await join(b, 'bob', 'general');
    await emit(a, 'message', { text: '/pm bob psst' });
    await emit(a, 'message', { text: 'public' });
    expect(messageStore.messages.map((m) => m.type)).toEqual(['private', 'chat']);
    expect(messageStore.messages[0]).toMatchObject({ from: 'alice', to: 'bob', text: 'psst' });
    const c = await connect('carol');
    const res = await join(c, 'carol', 'general');
    expect(res.history.map((m) => m.text)).toEqual(['public']);
  });

  test('does not broadcast or acknowledge a message when persistence fails', async () => {
    const a = await connect('alice');
    const b = await connect('bob');
    await join(a, 'alice', 'general');
    await join(b, 'bob', 'general');
    messageStore.save = async () => { throw new Error('database unavailable'); };
    const logError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const receive = jest.fn();
    b.on('message', receive);
    const result = await emit(a, 'message', { text: 'must persist first' });
    expect(result).toEqual({ ok: false, error: 'Message could not be saved. Please try again.' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(receive).not.toHaveBeenCalled();
    logError.mockRestore();
  });
});
