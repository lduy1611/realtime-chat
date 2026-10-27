'use strict';

const { createClientMessageId, offlineQueueSupport } = require('../public/message-id');

const secureEnvironment = () => ({
  isSecureContext: true,
  indexedDB: {},
  crypto: { randomUUID: () => 'f29eeb30-eaeb-4bd9-a88a-d184815fd13d' }
});

describe('secure offline message IDs', () => {
  test('uses randomUUID in secure contexts', () => {
    const environment = secureEnvironment();
    expect(createClientMessageId(environment)).toBe('f29eeb30-eaeb-4bd9-a88a-d184815fd13d');
  });

  test('uses getRandomValues to create a UUID v4 when randomUUID is unavailable', () => {
    const environment = secureEnvironment();
    environment.crypto = { getRandomValues: (bytes) => bytes.fill(0xaa) };
    const id = createClientMessageId(environment);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('rejects insecure HTTP and reports missing IndexedDB or secure randomness', () => {
    const environment = secureEnvironment();
    environment.isSecureContext = false;
    expect(offlineQueueSupport(environment)).toEqual({ supported: false, reason: 'insecure-context' });
    expect(() => createClientMessageId(environment)).toThrow(expect.objectContaining({ code: 'insecure-context' }));

    environment.isSecureContext = true;
    environment.indexedDB = undefined;
    expect(offlineQueueSupport(environment).reason).toBe('indexeddb-unavailable');
    environment.indexedDB = {};
    environment.crypto = {};
    expect(offlineQueueSupport(environment).reason).toBe('secure-random-unavailable');
  });
});
