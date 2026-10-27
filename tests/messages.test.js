'use strict';

const { MessageStore } = require('../src/messages');

describe('MessageStore', () => {
  test('inserts with parameterised SQL and persists account and client IDs', async () => {
    const execute = jest.fn().mockResolvedValue([{ insertId: 42 }]);
    const store = new MessageStore({ execute });
    const message = {
      type: 'chat', room: 'lớp học', from: 'alice', userId: 7,
      clientMessageId: 'c8418fb5-8bde-4a4c-a6bb-930e34e47af2', to: null, text: 'xin chào'
    };
    const result = await store.save(message);
    expect(execute.mock.calls[0][0]).toContain('VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    expect(execute.mock.calls[0][1]).toEqual([
      'chat', 'lớp học', 'alice', 7, message.clientMessageId, null, 'xin chào', expect.any(Number)
    ]);
    expect(result).toEqual({ id: 42, timestamp: expect.any(Number), duplicate: false });
  });

  test('accepts old clients that omit clientMessageId', async () => {
    const execute = jest.fn().mockResolvedValue([{ insertId: 43 }]);
    const store = new MessageStore({ execute });
    const result = await store.save({ type: 'chat', room: 'general', from: 'alice', userId: 7, text: 'legacy client' });
    expect(execute.mock.calls[0][1]).toEqual([
      'chat', 'general', 'alice', 7, null, null, 'legacy client', expect.any(Number)
    ]);
    expect(result).toMatchObject({ id: 43, duplicate: false });
  });

  test('returns the stored row for an identical retry after a unique-key violation', async () => {
    const duplicate = Object.assign(new Error('duplicate key'), { code: 'ER_DUP_ENTRY' });
    const execute = jest.fn()
      .mockRejectedValueOnce(duplicate)
      .mockResolvedValueOnce([[{ id: 12, type: 'chat', room: 'general', text: 'same text', timestamp: 1234 }]]);
    const store = new MessageStore({ execute });
    const result = await store.save({
      type: 'chat', room: 'general', from: 'alice', userId: 7,
      clientMessageId: 'c8418fb5-8bde-4a4c-a6bb-930e34e47af2', text: 'same text'
    });
    expect(result).toEqual({ id: 12, timestamp: 1234, duplicate: true });
    expect(execute.mock.calls[1][0]).toContain('sender_user_id = ? AND client_message_id = ?');
    expect(execute.mock.calls[1][1]).toEqual([7, 'c8418fb5-8bde-4a4c-a6bb-930e34e47af2']);
  });

  test('rejects a duplicate key when room or message content differs', async () => {
    const duplicate = Object.assign(new Error('duplicate key'), { code: 'ER_DUP_ENTRY' });
    const execute = jest.fn()
      .mockRejectedValueOnce(duplicate)
      .mockResolvedValueOnce([[{ id: 12, type: 'chat', room: 'general', text: 'original', timestamp: 1234 }]]);
    const store = new MessageStore({ execute });
    await expect(store.save({
      type: 'chat', room: 'other', from: 'alice', userId: 7,
      clientMessageId: 'c8418fb5-8bde-4a4c-a6bb-930e34e47af2', text: 'original'
    })).rejects.toMatchObject({ code: 'MESSAGE_ID_CONFLICT' });
  });

  test('loads legacy room history rows that have no idempotency metadata', async () => {
    const rows = [
      { id: 2, type: 'chat', room: 'general', sender: 'bob', clientMessageId: null, text: 'second', timestamp: 2000 },
      { id: 1, type: 'chat', room: 'general', sender: 'alice', clientMessageId: 'c8418fb5-8bde-4a4c-a6bb-930e34e47af2', text: 'first', timestamp: 1000 }
    ];
    const execute = jest.fn().mockResolvedValue([rows]);
    const store = new MessageStore({ execute });
    const history = await store.getRoomHistory('general', 100);
    expect(execute.mock.calls[0][0]).toContain('WHERE room = ? AND type = ?');
    expect(execute.mock.calls[0][1]).toEqual(['general', 'chat', 100]);
    expect(history.map((message) => message.text)).toEqual(['first', 'second']);
    expect(history[0]).toMatchObject({ id: 1, from: 'alice', clientMessageId: 'c8418fb5-8bde-4a4c-a6bb-930e34e47af2', timestamp: 1000 });
  });

  test('queries only group messages newer than the reconnect cursor', async () => {
    const rows = [{ id: 9, type: 'chat', room: 'general', sender: 'bob', clientMessageId: 'b7b068d5-a88f-49a0-9e09-dc59349bd341', text: 'missed', timestamp: 9000 }];
    const execute = jest.fn().mockResolvedValue([rows]);
    const store = new MessageStore({ execute });
    const messages = await store.getRoomMessagesAfter('general', 8);
    expect(execute.mock.calls[0][0]).toContain('WHERE room = ? AND type = ? AND id > ? ORDER BY id ASC');
    expect(execute.mock.calls[0][1]).toEqual(['general', 'chat', 8]);
    expect(messages).toMatchObject([{ id: 9, room: 'general', from: 'bob', clientMessageId: 'b7b068d5-a88f-49a0-9e09-dc59349bd341', text: 'missed' }]);
  });
});
