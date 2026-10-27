'use strict';

require('fake-indexeddb/auto');
const { createOutbox } = require('../public/outbox');

let dbName;
let outbox;

beforeEach(() => {
  dbName = `outbox-test-${Date.now()}-${Math.random()}`;
  outbox = createOutbox({ dbName });
});

afterEach(async () => {
  await outbox.close();
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(dbName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Database deletion blocked'));
  });
});

const message = (clientMessageId, userId, room, text) => ({ clientMessageId, userId, room, text, createdAt: 1234 });

describe('IndexedDB message outbox', () => {
  test('persists the required fields and Pending state before sending', async () => {
    const record = await outbox.enqueue(message('alice-1', 10, 'general', 'hello offline'));
    expect(record).toMatchObject({
      clientMessageId: 'alice-1', userId: '10', room: 'general', text: 'hello offline',
      createdAt: 1234, status: 'pending', retryCount: 0, serverMessageId: null
    });
    expect(await outbox.listForRoom(10, 'general')).toEqual([record]);
  });

  test('isolates pending messages by account and room', async () => {
    await outbox.enqueue(message('a-general', 10, 'general', 'A general'));
    await outbox.enqueue(message('a-random', 10, 'random', 'A random'));
    await outbox.enqueue(message('b-general', 20, 'general', 'B general'));
    expect((await outbox.listForRoom(10, 'general')).map((item) => item.clientMessageId)).toEqual(['a-general']);
    expect((await outbox.listForRoom(10, 'random')).map((item) => item.clientMessageId)).toEqual(['a-random']);
    expect((await outbox.listForRoom(20, 'general')).map((item) => item.clientMessageId)).toEqual(['b-general']);
  });

  test('restores Pending messages after reopening the database', async () => {
    await outbox.enqueue(message('persist-me', 10, 'general', 'survives reload'));
    await outbox.close();
    outbox = createOutbox({ dbName });
    expect(await outbox.listForRoom(10, 'general')).toMatchObject([
      { clientMessageId: 'persist-me', text: 'survives reload', status: 'pending', retryCount: 0 }
    ]);
  });

  test('tracks attempts, Sent, and Failed status under the owning account', async () => {
    await outbox.enqueue(message('status-id', 10, 'general', 'state test'));
    expect(await outbox.markAttempt('status-id', 10)).toMatchObject({ status: 'pending', retryCount: 1 });
    expect(await outbox.markSent('status-id', 20, 99)).toBeNull();
    expect(await outbox.markSent('status-id', 10, 99)).toMatchObject({ status: 'sent', serverMessageId: 99 });
    expect(await outbox.markFailed('status-id', 10, 'server rejected')).toMatchObject({ status: 'failed', lastError: 'server rejected' });
  });
});
