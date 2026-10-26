'use strict';

const { MessageStore } = require('../src/messages');

describe('MessageStore', () => {
  test('inserts a message with parameterised SQL and returns its database id', async () => {
    const execute = jest.fn().mockResolvedValue([{ insertId: 42 }]);
    const store = new MessageStore({ execute });
    const result = await store.save({ type: 'chat', room: 'lớp học', from: 'alice', to: null, text: 'xin chào' });
    expect(execute.mock.calls[0][0]).toContain('VALUES (?, ?, ?, ?, ?, ?)');
    expect(execute.mock.calls[0][1]).toEqual(['chat', 'lớp học', 'alice', null, 'xin chào', expect.any(Number)]);
    expect(result).toEqual({ id: 42, timestamp: expect.any(Number) });
  });

  test('loads only the requested room history in chronological order', async () => {
    const rows = [
      { id: 2, type: 'chat', room: 'general', sender: 'bob', text: 'second', timestamp: 2000 },
      { id: 1, type: 'chat', room: 'general', sender: 'alice', text: 'first', timestamp: 1000 }
    ];
    const execute = jest.fn().mockResolvedValue([rows]);
    const store = new MessageStore({ execute });
    const history = await store.getRoomHistory('general', 100);
    expect(execute.mock.calls[0][0]).toContain('WHERE room = ? AND type = ?');
    expect(execute.mock.calls[0][1]).toEqual(['general', 'chat', 100]);
    expect(history.map((message) => message.text)).toEqual(['first', 'second']);
    expect(history[0]).toMatchObject({ id: 1, from: 'alice', timestamp: 1000 });
  });

  test('queries only group messages newer than the reconnect cursor', async () => {
    const rows = [{ id: 9, type: 'chat', room: 'general', sender: 'bob', text: 'missed', timestamp: 9000 }];
    const execute = jest.fn().mockResolvedValue([rows]);
    const store = new MessageStore({ execute });
    const messages = await store.getRoomMessagesAfter('general', 8);
    expect(execute.mock.calls[0][0]).toContain("WHERE room = ? AND type = ? AND id > ? ORDER BY id ASC");
    expect(execute.mock.calls[0][1]).toEqual(['general', 'chat', 8]);
    expect(messages).toMatchObject([{ id: 9, room: 'general', from: 'bob', text: 'missed' }]);
  });
});
