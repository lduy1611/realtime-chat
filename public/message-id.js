'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChatMessageId = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function offlineQueueSupport({ isSecureContext, crypto, indexedDB }) {
    if (isSecureContext !== true) return { supported: false, reason: 'insecure-context' };
    if (!indexedDB) return { supported: false, reason: 'indexeddb-unavailable' };
    if (!crypto || (typeof crypto.randomUUID !== 'function' && typeof crypto.getRandomValues !== 'function')) {
      return { supported: false, reason: 'secure-random-unavailable' };
    }
    return { supported: true };
  }

  function createClientMessageId(environment = globalThis) {
    const support = offlineQueueSupport({
      isSecureContext: environment.isSecureContext,
      crypto: environment.crypto,
      indexedDB: environment.indexedDB
    });
    if (!support.supported) {
      const error = new Error(support.reason);
      error.code = support.reason;
      throw error;
    }
    if (typeof environment.crypto.randomUUID === 'function') return environment.crypto.randomUUID();

    // randomUUID is missing on some secure browser contexts. Construct RFC 4122
    // UUID v4 with the Web Crypto CSPRNG; never use Math.random for idempotency.
    const bytes = environment.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  return { offlineQueueSupport, createClientMessageId };
});
