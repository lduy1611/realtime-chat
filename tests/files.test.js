'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: Client } = require('socket.io-client');
const { createServer } = require('../src/server');
const { TestUserStore, TestFileStore, createTestSession } = require('./helpers');

let httpServer; let io; let url; let uploadsDir; let fileStore; let userStore;
const clients = [];

const request = (method, pathname, { cookie, body, contentType } = {}) => new Promise((resolve, reject) => {
  const headers = { Origin: url };
  if (cookie) headers.Cookie = cookie;
  if (contentType) headers['Content-Type'] = contentType;
  if (body) headers['Content-Length'] = body.length;
  const req = http.request(url + pathname, { method, headers }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => {
      const response = Buffer.concat(chunks);
      resolve({ status: res.statusCode, headers: res.headers, body: response });
    });
  });
  req.on('error', reject);
  req.end(body);
});

const signup = (username) => new Promise((resolve, reject) => {
  const body = Buffer.from(JSON.stringify({ username, password: 'TestPassword123!' }));
  const req = http.request(url + '/api/auth/register', { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json', 'Content-Length': body.length } }, (res) => {
    res.resume();
    res.on('end', () => resolve(res.headers['set-cookie'][0].split(';')[0]));
  });
  req.on('error', reject); req.end(body);
});

function multipart(name, content, mime = 'application/octet-stream') {
  const boundary = '----file-test-boundary';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

const openSocket = (cookie) => new Promise((resolve) => {
  const client = Client(url, { forceNew: true, transports: ['websocket'], extraHeaders: { Cookie: cookie } });
  clients.push(client); client.on('connect', () => resolve(client));
});
const emit = (client, event, payload) => new Promise((resolve) => client.emit(event, payload, resolve));

beforeEach((done) => {
  uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'realtime-chat-files-'));
  fileStore = new TestFileStore(); userStore = new TestUserStore();
  const { sessionMiddleware } = createTestSession();
  ({ httpServer, io } = createServer({
    messageStore: { async getRoomHistory() { return []; }, async getRoomMessagesAfter() { return []; }, async save() { return { id: 1, timestamp: Date.now() }; } },
    fileStore, userStore, sessionMiddleware, uploadsDir
  }));
  httpServer.listen(0, () => { url = `http://localhost:${httpServer.address().port}`; done(); });
});

afterEach((done) => {
  clients.splice(0).forEach((client) => client.disconnect());
  io.close(() => { fs.rmSync(uploadsDir, { recursive: true, force: true }); done(); });
});

describe('authenticated room file sharing', () => {
  test('uploads a valid image, broadcasts it to the room, and downloads it with membership', async () => {
    expect((await request('GET', '/api/files/1/download')).status).toBe(401);
    const cookie = await signup('alice');
    const client = await openSocket(cookie);
    await emit(client, 'join', { room: 'general' });
    const message = new Promise((resolve) => client.once('message', resolve));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
    const form = multipart('hello.png', png, 'image/png');
    const uploaded = await request('POST', '/api/rooms/general/files', { cookie, ...form });
    expect(uploaded.status).toBe(201);
    expect(JSON.parse(uploaded.body)).toMatchObject({ id: 1, type: 'file', fileName: 'hello.png', fileSize: png.length, from: 'alice' });
    expect(await message).toMatchObject({ id: 1, type: 'file', room: 'general' });
    expect((await request('GET', `/${fileStore.files[0].storageName}.upload`, { cookie })).status).toBe(404);
    const download = await request('GET', '/api/files/1/download', { cookie });
    expect(download.status).toBe(200);
    expect(download.body).toEqual(png);
    expect(download.headers['content-disposition']).toContain('hello.png');
  });

  test.each([
    'Ảnh chụp màn hình.txt',
    'meeting-notes.txt',
    "Bob's (final) 50%.txt"
  ])('preserves valid multipart filename %s through metadata and download headers', async (fileName) => {
    const cookie = await signup('alice');
    const client = await openSocket(cookie);
    await emit(client, 'join', { room: 'general' });
    const broadcast = new Promise((resolve) => client.once('message', resolve));
    const form = multipart(fileName, Buffer.from('UTF-8 text'), 'text/plain');
    const uploaded = await request('POST', '/api/rooms/general/files', { cookie, ...form });
    expect(uploaded.status).toBe(201);
    expect(JSON.parse(uploaded.body).fileName).toBe(fileName);
    expect((await broadcast).fileName).toBe(fileName);
    expect(fileStore.files[0].originalName).toBe(fileName);
    expect((await emit(client, 'files:sync', { afterId: 0 })).files[0].fileName).toBe(fileName);
    const downloaded = await request('GET', '/api/files/1/download', { cookie });
    expect(downloaded.status).toBe(200);
    const disposition = downloaded.headers['content-disposition'];
    const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/)[1];
    expect(decodeURIComponent(encoded)).toBe(fileName);
    expect(disposition).toContain('filename=');
  });

  test('rejects uploads without a session and files with invalid content', async () => {
    const form = multipart('fake.png', Buffer.from('not an image'), 'image/png');
    expect((await request('POST', '/api/rooms/general/files', form)).status).toBe(401);
    const cookie = await signup('alice');
    const client = await openSocket(cookie); await emit(client, 'join', { room: 'general' });
    const invalid = await request('POST', '/api/rooms/general/files', { cookie, ...form });
    expect(invalid.status).toBe(415);
    expect(fileStore.files).toHaveLength(0);
    expect(fs.readdirSync(uploadsDir)).toHaveLength(0);
  });

  test('rejects files larger than 10 MB and unsupported extensions', async () => {
    const cookie = await signup('alice');
    const client = await openSocket(cookie); await emit(client, 'join', { room: 'general' });
    const tooLarge = multipart('large.txt', Buffer.alloc(10 * 1024 * 1024 + 1, 65), 'text/plain');
    expect((await request('POST', '/api/rooms/general/files', { cookie, ...tooLarge })).status).toBe(413);
    const unsupported = multipart('payload.exe', Buffer.from('MZ'), 'application/octet-stream');
    expect((await request('POST', '/api/rooms/general/files', { cookie, ...unsupported })).status).toBe(415);
    expect(fileStore.files).toHaveLength(0);
  });

  test('requires room membership to upload and download, and syncs files by ID', async () => {
    const cookie = await signup('alice');
    const form = multipart('note.txt', Buffer.from('hello text'), 'text/plain');
    expect((await request('POST', '/api/rooms/general/files', { cookie, ...form })).status).toBe(403);
    const client = await openSocket(cookie); await emit(client, 'join', { room: 'general' });
    const uploaded = await request('POST', '/api/rooms/general/files', { cookie, ...form });
    expect(uploaded.status).toBe(201);
    const sync = await emit(client, 'files:sync', { afterId: 0 });
    expect(sync.files).toHaveLength(1);
    expect(sync.files[0]).toMatchObject({ id: 1, fileName: 'note.txt' });
    client.disconnect();
    expect((await request('GET', '/api/files/1/download', { cookie })).status).toBe(403);
  });
});
