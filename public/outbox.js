'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChatOutbox = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const STORE_NAME = 'messages';
  const INDEX_NAME = 'byUserRoom';

  function createOutbox({ indexedDB = globalThis.indexedDB, IDBKeyRange = globalThis.IDBKeyRange, dbName = 'realtime-chat-outbox' } = {}) {
    let dbPromise;
    let flushTail = Promise.resolve();
    let lastAttemptAt = 0;

    function open() {
      if (!indexedDB) return Promise.reject(new Error('IndexedDB is not available in this browser'));
      if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
          const request = indexedDB.open(dbName, 1);
          request.onupgradeneeded = () => {
            const db = request.result;
            const store = db.objectStoreNames.contains(STORE_NAME)
              ? request.transaction.objectStore(STORE_NAME)
              : db.createObjectStore(STORE_NAME, { keyPath: 'clientMessageId' });
            if (!store.indexNames.contains(INDEX_NAME)) store.createIndex(INDEX_NAME, ['userId', 'room'], { unique: false });
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error || new Error('Could not open the local message queue'));
          request.onblocked = () => reject(new Error('The local message queue is blocked by another tab'));
        });
      }
      return dbPromise;
    }

    async function requestResult(request) {
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
      });
    }

    async function enqueue({ clientMessageId, userId, room, text, createdAt = Date.now() }) {
      if (typeof clientMessageId !== 'string' || !clientMessageId) throw new Error('A client message ID is required');
      if (userId == null || String(userId) === '') throw new Error('An account ID is required');
      if (typeof room !== 'string' || !room) throw new Error('A room is required');
      if (typeof text !== 'string' || !text.trim()) throw new Error('Message text is required');
      const record = {
        clientMessageId,
        userId: String(userId),
        room,
        text: text.trim(),
        createdAt: Number(createdAt),
        status: 'pending',
        retryCount: 0,
        serverMessageId: null,
        lastError: null
      };
      const db = await open();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const request = tx.objectStore(STORE_NAME).add(record);
      await Promise.all([transactionDone(tx), requestResult(request)]);
      return record;
    }

    async function listForRoom(userId, room) {
      if (userId == null || String(userId) === '' || typeof room !== 'string') return [];
      const db = await open();
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).index(INDEX_NAME)
        .getAll(IDBKeyRange.only([String(userId), room]));
      const [records] = await Promise.all([requestResult(request), transactionDone(tx)]);
      return records.sort((a, b) => a.createdAt - b.createdAt);
    }

    async function update(clientMessageId, userId, mutate) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        let updated = null;
        tx.oncomplete = () => resolve(updated);
        tx.onabort = tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
        const request = store.get(clientMessageId);
        request.onsuccess = () => {
          const record = request.result;
          if (!record || record.userId !== String(userId)) return;
          updated = mutate(record);
          updated.updatedAt = Date.now();
          store.put(updated);
        };
        request.onerror = () => reject(request.error || new Error('Could not update the local message queue'));
      });
    }

    function flushPending({
      userId, room, onlyClientMessageIds, isCurrent = () => true, send,
      onStatus = () => {}, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      minSendIntervalMs = 350, maxAttempts = 5, baseRetryMs = 500, maxRetryMs = 5000
    }) {
      if (typeof send !== 'function') return Promise.reject(new Error('A message sender is required'));
      const run = async () => {
        const records = await listForRoom(userId, room);
        const selected = onlyClientMessageIds ? new Set(onlyClientMessageIds) : null;
        const report = { sent: 0, failed: 0, remaining: 0, stopped: false };

        for (let index = 0; index < records.length; index++) {
          const record = records[index];
          if (record.status !== 'pending' || (selected && !selected.has(record.clientMessageId))) continue;
          if (!isCurrent()) { report.stopped = true; break; }

          let finished = false;
          for (let attempt = 0; attempt < maxAttempts; attempt++) {
            if (!isCurrent()) { report.stopped = true; break; }
            const pacingDelay = Math.max(0, minSendIntervalMs - (Date.now() - lastAttemptAt));
            if (pacingDelay) await wait(pacingDelay);
            if (!isCurrent()) { report.stopped = true; break; }

            const attempted = await update(record.clientMessageId, userId, (current) => ({
              ...current, status: 'pending', retryCount: current.retryCount + 1, lastError: null
            }));
            if (!attempted) { finished = true; break; }
            onStatus(attempted, 'pending');
            lastAttemptAt = Date.now();

            let response;
            try { response = await send(attempted); }
            catch (error) { response = { retryable: true, error: error.message || 'Network error' }; }

            if (response && response.ok === true && response.id != null) {
              const saved = await update(record.clientMessageId, userId, (current) => ({
                ...current, status: 'sent', serverMessageId: Number(response.id), lastError: null
              }));
              if (saved) onStatus(saved, 'sent');
              report.sent++;
              finished = true;
              break;
            }
            if (response?.stopped) { report.stopped = true; break; }

            if (response?.code === 'RATE_LIMITED' || response?.retryable || response?.timeout) {
              if (attempt + 1 >= maxAttempts) break;
              const backoff = Math.min(maxRetryMs, baseRetryMs * (2 ** attempt));
              await wait(Math.max(Number(response.retryAfterMs) || 0, backoff));
              continue;
            }

            const error = response?.error || 'Message was rejected by the server';
            const failed = await update(record.clientMessageId, userId, (current) => ({
              ...current, status: 'failed', lastError: String(error).slice(0, 500)
            }));
            if (failed) onStatus(failed, 'failed', error);
            report.failed++;
            finished = true;
            break;
          }

          if (report.stopped) break;
          if (!finished) {
            report.remaining = records.slice(index).filter((item) => item.status === 'pending' && (!selected || selected.has(item.clientMessageId))).length;
            break; // Preserve ordering while the oldest result is uncertain.
          }
        }
        return report;
      };

      const operation = flushTail.then(run, run);
      flushTail = operation.catch(() => {});
      return operation;
    }

    return {
      enqueue,
      listForRoom,
      async markAttempt(clientMessageId, userId) {
        return update(clientMessageId, userId, (record) => ({ ...record, status: 'pending', retryCount: record.retryCount + 1, lastError: null }));
      },
      markSent(clientMessageId, userId, serverMessageId) {
        return update(clientMessageId, userId, (record) => ({ ...record, status: 'sent', serverMessageId: serverMessageId == null ? null : Number(serverMessageId), lastError: null }));
      },
      markFailed(clientMessageId, userId, error) {
        return update(clientMessageId, userId, (record) => ({ ...record, status: 'failed', lastError: String(error || 'Message was rejected').slice(0, 500) }));
      },
      flushPending,
      get,
      close: async () => { if (dbPromise) (await dbPromise).close(); dbPromise = null; }
    };

    async function get(clientMessageId) {
      const db = await open();
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(clientMessageId);
      const [result] = await Promise.all([requestResult(request), transactionDone(tx)]);
      return result;
    }
  }

  function transactionDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    });
  }

  return { createOutbox };
});
