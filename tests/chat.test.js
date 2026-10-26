'use strict';

const http = require('http');
const { io: Client } = require('socket.io-client');
const { createServer } = require('../src/server');

let httpServer;
let io;
let url;
const clients = [];
let messageStore;

class TestMessageStore {
  constructor() { this.messages = []; this.nextId = 1; }
  async save(message) {
    const saved = { ...message, id: this.nextId++, timestamp: Date.now() };
    this.messages.push(saved);
    return { id: saved.id, timestamp: saved.timestamp };
  }
  async getRoomHistory(room, limit) {
    return this.messages
      .filter((message) => message.type === 'chat' && message.room === room)
      .slice(-limit)
      .map(({ id, type, room: messageRoom, timestamp, from, text }) => ({ id, type, room: messageRoom, timestamp, from, text }));
  }
}

const connect = () => {
  const c = Client(url, { forceNew: true, transports: ['websocket'] });
  clients.push(c);
  return new Promise((resolve) => c.on('connect', () => resolve(c)));
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

const getJson = (path) =>
  new Promise((resolve, reject) => {
    http.get(url + path, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });

beforeEach((done) => {
  messageStore = new TestMessageStore();
  ({ httpServer, io } = createServer({ messageStore, historyLimit: 5, rateLimit: { limit: 3, windowMs: 1000 } }));
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
    const c = await connect();
    const res = await join(c, 'alice', 'general');
    expect(res).toEqual({ ok: true, username: 'alice', room: 'general', history: [] });
  });

  test('rejects invalid usernames and rooms', async () => {
    const c = await connect();
    expect((await join(c, 'a', 'general')).ok).toBe(false);
    expect((await join(c, 'bad name!', 'general')).ok).toBe(false);
    expect((await join(c, 'alice', '')).ok).toBe(false);
    expect((await join(c, undefined, 'general')).error).toMatch(/Username/);
  });

  test('returns a useful error when room history cannot be loaded', async () => {
    const c = await connect();
    const logError = jest.spyOn(console, 'error').mockImplementation(() => {});
    messageStore.getRoomHistory = async () => { throw new Error('database unavailable'); };
    const res = await join(c, 'alice', 'general');
    expect(res).toEqual({ ok: false, error: 'Could not load chat history. Please try again.' });
    expect((await getJson('/api/rooms')).body).toEqual([]);
    logError.mockRestore();
  });

  test('rejects a duplicate username in the same room (case-insensitive)', async () => {
    const a = await connect();
    const b = await connect();
    await join(a, 'alice', 'general');
    const res = await join(b, 'ALICE', 'general');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/already taken/);
  });

  test('allows the same username in different rooms', async () => {
    const a = await connect();
    const b = await connect();
    await join(a, 'alice', 'room-1');
    expect((await join(b, 'alice', 'room-2')).ok).toBe(true);
  });

  test('sends system messages on join and leave to other members', async () => {
    const a = await connect();
    await join(a, 'alice', 'general');
    const b = await connect();
    const joined = once(a, 'message');
    await join(b, 'bob', 'general');
    expect(await joined).toMatchObject({ type: 'system', text: 'bob joined the room' });

    const left = once(a, 'message');
    b.disconnect();
    expect(await left).toMatchObject({ type: 'system', text: 'bob left the room' });
  });
});

describe('rooms', () => {
  test('GET /api/rooms lists rooms with user counts', async () => {
    const a = await connect();
    const b = await connect();
    await join(a, 'alice', 'general');
    await join(b, 'bob', 'general');
    const { status, body } = await getJson('/api/rooms');
    expect(status).toBe(200);
    expect(body).toEqual([{ name: 'general', users: 2 }]);
  });

  test('broadcasts rooms:update when users join and leave', async () => {
    const a = await connect();
    const b = await connect();
    const update = once(a, 'rooms:update');
    await join(b, 'bob', 'lobby');
    expect(await update).toEqual([{ name: 'lobby', users: 1 }]);

    const emptied = once(a, 'rooms:update');
    b.disconnect();
    expect(await emptied).toEqual([]);
  });

  test('sends users:update with the sorted member list', async () => {
    const a = await connect();
    const b = await connect();
    await join(a, 'zed', 'general');
    const update = once(a, 'users:update');
    await join(b, 'amy', 'general');
    expect(await update).toEqual(['amy', 'zed']);
  });
});

describe('messaging', () => {
  test('broadcasts chat messages with sender and timestamp to the room only', async () => {
    const a = await connect();
    const b = await connect();
    const other = await connect();
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
    const a = await connect();
    await join(a, 'alice', 'general');
    const received = once(a, 'message');
    await emit(a, 'message', { text: '<b>hi</b>' });
    expect((await received).text).toBe('&lt;b&gt;hi&lt;/b&gt;');

    expect((await emit(a, 'message', { text: '   ' })).ok).toBe(false);
    expect((await emit(a, 'message', { text: 'x'.repeat(501) })).error).toMatch(/exceeds/);
    expect((await emit(a, 'message', { text: 42 })).ok).toBe(false);
  });

  test('rejects messages before joining a room', async () => {
    const a = await connect();
    const res = await emit(a, 'message', { text: 'hi' });
    expect(res).toEqual({ ok: false, error: 'Join a room first' });
  });

  test('rate limits messages per socket', async () => {
    const a = await connect();
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
    const a = await connect();
    await join(a, 'alice', 'general');
    for (let i = 1; i <= 3; i++) {
      await emit(a, 'message', { text: `msg ${i}` });
    }
    const b = await connect();
    const res = await join(b, 'bob', 'general');
    expect(res.history.map((m) => m.text)).toEqual(['msg 1', 'msg 2', 'msg 3']);
  });

  test('caps history at the configured limit', async () => {
    const a = await connect();
    await join(a, 'alice', 'general');
    for (let i = 1; i <= 7; i++) {
      await emit(a, 'message', { text: `msg ${i}` });
      if (i % 3 === 0) await new Promise((r) => setTimeout(r, 1050));
    }
    const b = await connect();
    const res = await join(b, 'bob', 'general');
    expect(res.history.map((m) => m.text)).toEqual(['msg 3', 'msg 4', 'msg 5', 'msg 6', 'msg 7']);
  });
});

describe('typing', () => {
  test('relays typing state to other room members but not the sender', async () => {
    const a = await connect();
    const b = await connect();
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
  test('/pm delivers only to the sender and the target', async () => {
    const a = await connect();
    const b = await connect();
    const c = await connect();
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
    const a = await connect();
    await join(a, 'alice', 'general');
    expect((await emit(a, 'message', { text: '/pm nobody hi' })).error).toMatch(/not in this room/);
    expect((await emit(a, 'message', { text: '/pm alice hi' })).error).toMatch(/yourself/);
  });

  test('private messages are not stored in room history', async () => {
    const a = await connect();
    const b = await connect();
    await join(a, 'alice', 'general');
    await join(b, 'bob', 'general');
    await emit(a, 'message', { text: '/pm bob psst' });
    await emit(a, 'message', { text: 'public' });
    expect(messageStore.messages.map((m) => m.type)).toEqual(['private', 'chat']);
    expect(messageStore.messages[0]).toMatchObject({ from: 'alice', to: 'bob', text: 'psst' });
    const c = await connect();
    const res = await join(c, 'carol', 'general');
    expect(res.history.map((m) => m.text)).toEqual(['public']);
  });

  test('does not broadcast or acknowledge a message when persistence fails', async () => {
    const a = await connect();
    const b = await connect();
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
