'use strict';

const http = require('http');
const { io: Client } = require('socket.io-client');
const { createServer } = require('../src/server');
const { createSession } = require('../src/auth');
const { TestUserStore, TestFileStore, createTestSession } = require('./helpers');

let httpServer;
let io;
let url;
let userStore;
const clients = [];

const request = (method, path, payload, cookie) => new Promise((resolve, reject) => {
  const headers = { Origin: url };
  if (payload) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const req = http.request(url + path, { method, headers }, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => resolve({
      status: res.statusCode,
      body: body ? JSON.parse(body) : {},
      setCookie: res.headers['set-cookie']?.[0],
      cookie: res.headers['set-cookie']?.[0]?.split(';')[0]
    }));
  });
  req.on('error', reject);
  if (payload) req.end(JSON.stringify(payload));
  else req.end();
});

beforeEach((done) => {
  userStore = new TestUserStore();
  const { sessionMiddleware } = createTestSession();
  ({ httpServer, io } = createServer({
    messageStore: { async getRoomHistory() { return []; }, async getRoomMessagesAfter() { return []; }, async save() { return { id: 1, timestamp: Date.now() }; } },
    userStore,
    fileStore: new TestFileStore(),
    sessionMiddleware
  }));
  httpServer.listen(0, () => {
    url = `http://localhost:${httpServer.address().port}`;
    done();
  });
});

afterEach((done) => {
  for (const client of clients.splice(0)) client.disconnect();
  io.close(() => done());
});

describe('authentication API', () => {
  test('initializes the MySQL session store from configuration without running DDL', async () => {
    const { sessionStore } = createSession({
      secret: 'test_only_session_secret_not_for_production_0123456789',
      env: { DB_HOST: 'localhost', DB_PORT: '3306', DB_USER: 'test', DB_PASSWORD: '', DB_NAME: 'realtime_chat' }
    });
    await sessionStore.onReady();
    await sessionStore.close();
  });

  test('registers with a bcrypt hash and issues an HttpOnly localhost session cookie', async () => {
    const result = await request('POST', '/api/auth/register', { username: 'alice', password: 'correct horse 1' });
    expect(result.status).toBe(201);
    expect(result.body).toEqual({ authenticated: true, user: { id: 1, username: 'alice' } });
    expect(userStore.users[0].passwordHash).not.toBe('correct horse 1');
    expect(userStore.users[0].passwordHash).toMatch(/^\$2[aby]\$/);
    expect(result.setCookie).toContain('HttpOnly');
    expect(result.setCookie).toContain('SameSite=Lax');
    expect(result.setCookie).not.toContain('Secure');
    expect((await request('GET', '/api/auth/me', null, result.cookie)).body).toEqual({
      authenticated: true, user: { id: 1, username: 'alice' }
    });
  });

  test('validates registration and enforces case-insensitive username uniqueness', async () => {
    expect((await request('POST', '/api/auth/register', { username: 'a', password: 'correct horse 1' })).status).toBe(400);
    expect((await request('POST', '/api/auth/register', { username: 'alice', password: 'short' })).status).toBe(400);
    expect((await request('POST', '/api/auth/register', { username: 'alice', password: '😀'.repeat(19) })).status).toBe(400);
    expect((await request('POST', '/api/auth/register', { username: 'alice', password: 'correct horse 1' })).status).toBe(201);
    const duplicate = await request('POST', '/api/auth/register', { username: 'ALICE', password: 'correct horse 1' });
    expect(duplicate.status).toBe(409);
  });

  test('logs in, changes the session id, and gives a generic error for wrong credentials', async () => {
    const first = await request('POST', '/api/auth/register', { username: 'alice', password: 'correct horse 1' });
    const login = await request('POST', '/api/auth/login', { username: 'ALICE', password: 'correct horse 1' });
    expect(login.status).toBe(200);
    expect(login.cookie).not.toBe(first.cookie);
    expect((await request('GET', '/api/auth/me', null, login.cookie)).body.user.username).toBe('alice');
    const rejected = await request('POST', '/api/auth/login', { username: 'alice', password: 'wrong password' });
    expect(rejected.status).toBe(401);
    expect(rejected.body.error).toBe('Invalid username or password');
  });

  test('logout destroys the session and clears the cookie', async () => {
    const registered = await request('POST', '/api/auth/register', { username: 'alice', password: 'correct horse 1' });
    const logout = await request('POST', '/api/auth/logout', {}, registered.cookie);
    expect(logout.status).toBe(200);
    expect(logout.setCookie).toContain('Expires=Thu, 01 Jan 1970');
    expect((await request('GET', '/api/auth/me', null, registered.cookie)).status).toBe(401);
  });

  test('rejects cross-origin authentication requests', async () => {
    const originalUrl = url;
    const requestResult = await new Promise((resolve, reject) => {
      const req = http.request(url + '/api/auth/register', {
        method: 'POST', headers: { Origin: 'http://attacker.example', 'Content-Type': 'application/json' }
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ username: 'alice', password: 'correct horse 1' }));
    });
    expect(originalUrl).toBe(url);
    expect(requestResult.status).toBe(403);
  });
});

describe('Socket.IO authentication', () => {
  test('rejects connections without a valid session', async () => {
    const client = Client(url, { forceNew: true, transports: ['websocket'], reconnection: false });
    clients.push(client);
    const error = await new Promise((resolve) => client.once('connect_error', resolve));
    expect(error.message).toBe('Authentication required');
  });

  test('uses the authenticated session identity instead of a forged join or message username', async () => {
    const registered = await request('POST', '/api/auth/register', { username: 'alice', password: 'correct horse 1' });
    const client = Client(url, {
      forceNew: true, transports: ['websocket'], extraHeaders: { Cookie: registered.cookie }
    });
    clients.push(client);
    await new Promise((resolve) => client.once('connect', resolve));
    const joined = await new Promise((resolve) => client.emit('join', { username: 'mallory', room: 'general' }, resolve));
    expect(joined).toMatchObject({ ok: true, username: 'alice' });

    const messagePromise = new Promise((resolve) => client.once('message', resolve));
    client.emit('message', { from: 'mallory', text: 'hello' });
    expect(await messagePromise).toMatchObject({ type: 'chat', from: 'alice', text: 'hello' });
  });

  test('logout disconnects sockets authenticated by that session', async () => {
    const registered = await request('POST', '/api/auth/register', { username: 'alice', password: 'correct horse 1' });
    const client = Client(url, { forceNew: true, transports: ['websocket'], extraHeaders: { Cookie: registered.cookie } });
    clients.push(client);
    await new Promise((resolve) => client.once('connect', resolve));
    const disconnected = new Promise((resolve) => client.once('disconnect', resolve));
    await request('POST', '/api/auth/logout', {}, registered.cookie);
    expect(await disconnected).toBe('io server disconnect');
  });
});
