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

  test('reports unavailable IndexedDB instead of pretending a message was queued', async () => {
    const unavailableOutbox = createOutbox({ indexedDB: null, dbName: `${dbName}-unavailable` });
    await expect(unavailableOutbox.enqueue(message('no-idb', 10, 'general', 'keep this draft')))
      .rejects.toThrow('IndexedDB is not available');
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

  test('flushes only the current account and room, sequentially, and resumes after reconnect', async () => {
    await outbox.enqueue(message('alice-general-1', 10, 'general', 'one'));
    await outbox.enqueue(message('alice-general-2', 10, 'general', 'two'));
    await outbox.enqueue(message('alice-random', 10, 'random', 'wrong room'));
    await outbox.enqueue(message('bob-general', 20, 'general', 'wrong account'));
    let connected = true;
    let active = 0;
    let maxActive = 0;
    const sent = [];
    const report = await outbox.flushPending({
      userId: 10, room: 'general', isCurrent: () => connected,
      wait: async () => {}, minSendIntervalMs: 0,
      send: async (record) => {
        active++;
        maxActive = Math.max(maxActive, active);
        sent.push(record.clientMessageId);
        await Promise.resolve();
        active--;
        return { ok: true, id: sent.length };
      }
    });
    expect(report.sent).toBe(2);
    expect(maxActive).toBe(1);
    expect(sent).toEqual(['alice-general-1', 'alice-general-2']);

    await outbox.enqueue(message('alice-general-3', 10, 'general', 'three'));
    connected = false;
    const stopped = await outbox.flushPending({
      userId: 10, room: 'general', isCurrent: () => connected,
      send: async () => ({ ok: true, id: 3 })
    });
    expect(stopped.stopped).toBe(true);
    expect((await outbox.get('alice-general-3')).status).toBe('pending');
    connected = true;
    const resumed = await outbox.flushPending({
      userId: 10, room: 'general', isCurrent: () => connected,
      wait: async () => {}, minSendIntervalMs: 0,
      send: async (record) => ({ ok: true, id: record.clientMessageId === 'alice-general-3' ? 3 : 4 })
    });
    expect(resumed.sent).toBe(1);
    expect((await outbox.get('alice-general-3')).status).toBe('sent');
  });

  test('retries the same clientMessageId after a persisted message loses its ACK', async () => {
    await outbox.enqueue(message('stable-client-id', 10, 'general', 'saved before timeout'));
    const serverMessages = new Map();
    const broadcasts = [];
    const attemptedIds = [];
    const report = await outbox.flushPending({
      userId: 10, room: 'general', wait: async () => {}, minSendIntervalMs: 0,
      send: async (record) => {
        attemptedIds.push(record.clientMessageId);
        const existing = serverMessages.get(record.clientMessageId);
        if (existing) return { ok: true, id: existing.id };
        const saved = { id: 41, text: record.text, room: record.room };
        serverMessages.set(record.clientMessageId, saved);
        broadcasts.push(saved.id);
        return { timeout: true, retryable: true, error: 'simulated lost ACK' };
      }
    });
    expect(report.sent).toBe(1);
    expect(attemptedIds).toEqual(['stable-client-id', 'stable-client-id']);
    expect(serverMessages.size).toBe(1);
    expect(broadcasts).toEqual([41]);
    expect(await outbox.get('stable-client-id')).toMatchObject({ status: 'sent', serverMessageId: 41, retryCount: 2 });
  });

  test('stops the current flush immediately when the account or room context changes', async () => {
    await outbox.enqueue(message('first-context', 10, 'general', 'first'));
    await outbox.enqueue(message('second-context', 10, 'general', 'must wait'));
    let activeUserId = '10';
    let activeRoom = 'general';
    const sent = [];
    const report = await outbox.flushPending({
      userId: 10, room: 'general', wait: async () => {}, minSendIntervalMs: 0,
      isCurrent: () => activeUserId === '10' && activeRoom === 'general',
      send: async (record) => {
        sent.push(record.clientMessageId);
        activeRoom = 'random'; // Represents navigation while the ACK is in flight.
        return { ok: true, id: 61 };
      }
    });
    expect(sent).toEqual(['first-context']);
    expect(report.stopped).toBe(true);
    expect(await outbox.get('first-context')).toMatchObject({ status: 'sent', serverMessageId: 61 });
    expect(await outbox.get('second-context')).toMatchObject({ status: 'pending', retryCount: 0 });
  });

  test('backs off after rate limit and transient database failure, then records permanent conflicts', async () => {
    await outbox.enqueue(message('retry-id', 10, 'general', 'retry me'));
    await outbox.enqueue(message('conflict-id', 10, 'general', 'conflict'));
    const waits = [];
    let retryCalls = 0;
    const report = await outbox.flushPending({
      userId: 10, room: 'general', wait: async (duration) => waits.push(duration),
      minSendIntervalMs: 0, baseRetryMs: 1, maxRetryMs: 10,
      send: async (record) => {
        if (record.clientMessageId === 'conflict-id') return { ok: false, code: 'MESSAGE_ID_CONFLICT', error: 'ID conflict' };
        retryCalls++;
        if (retryCalls === 1) return { ok: false, code: 'RATE_LIMITED', retryAfterMs: 7 };
        if (retryCalls === 2) return { ok: false, code: 'PERSISTENCE_ERROR', retryable: true };
        return { ok: true, id: 55 };
      }
    });
    expect(report).toMatchObject({ sent: 1, failed: 1 });
    expect(waits).toContain(7);
    expect(waits).toContain(2);
    expect(await outbox.get('retry-id')).toMatchObject({ status: 'sent', retryCount: 3 });
    expect(await outbox.get('conflict-id')).toMatchObject({ status: 'failed', lastError: 'ID conflict' });
  });
});
