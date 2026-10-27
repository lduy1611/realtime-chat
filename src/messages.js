'use strict';

class MessageStore {
  constructor(pool) {
    this.pool = pool;
  }

  async save(message) {
    if (message.clientMessageId && !message.userId) {
      throw new Error('userId is required when clientMessageId is provided');
    }
    const timestamp = Date.now();
    try {
      const [result] = await this.pool.execute(
        'INSERT INTO messages (type, room, sender, sender_user_id, client_message_id, recipient, text, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [message.type, message.room, message.from, message.userId ?? null, message.clientMessageId ?? null, message.to || null, message.text, timestamp]
      );
      return { id: Number(result.insertId), timestamp, duplicate: false };
    } catch (error) {
      if (error.code !== 'ER_DUP_ENTRY' || !message.userId || !message.clientMessageId) throw error;

      const [rows] = await this.pool.execute(
        'SELECT id, type, room, recipient, text, created_at_ms AS timestamp FROM messages WHERE sender_user_id = ? AND client_message_id = ? LIMIT 1',
        [message.userId, message.clientMessageId]
      );
      const existing = rows[0];
      if (!existing) throw error;
      // A duplicate key on this pair is a retry only if its payload is unchanged.
      if (existing.type !== message.type || existing.room !== message.room || existing.text !== message.text || (existing.recipient ?? null) !== (message.to ?? null)) {
        const conflict = new Error('Client message ID was already used with different message data');
        conflict.code = 'MESSAGE_ID_CONFLICT';
        throw conflict;
      }
      return { id: Number(existing.id), timestamp: Number(existing.timestamp), duplicate: true };
    }
  }

  async findByClientMessageId(userId, clientMessageId) {
    const [rows] = await this.pool.execute(
      'SELECT id, type, room, recipient, text, created_at_ms AS timestamp FROM messages WHERE sender_user_id = ? AND client_message_id = ? LIMIT 1',
      [userId, clientMessageId]
    );
    const row = rows[0];
    return row ? { ...row, id: Number(row.id), timestamp: Number(row.timestamp) } : null;
  }

  async getRoomHistory(room, limit) {
    const [rows] = await this.pool.execute(
      'SELECT id, type, room, sender, text, created_at_ms AS timestamp FROM messages WHERE room = ? AND type = ? ORDER BY id DESC LIMIT ?',
      [room, 'chat', limit]
    );
    return rows.reverse().map((row) => ({
      id: Number(row.id),
      type: row.type,
      room: row.room,
      timestamp: Number(row.timestamp),
      from: row.sender,
      text: row.text
    }));
  }

  async getRoomMessagesAfter(room, afterId) {
    const [rows] = await this.pool.execute(
      'SELECT id, type, room, sender, text, created_at_ms AS timestamp FROM messages WHERE room = ? AND type = ? AND id > ? ORDER BY id ASC',
      [room, 'chat', afterId]
    );
    return rows.map((row) => ({
      id: Number(row.id),
      type: row.type,
      room: row.room,
      timestamp: Number(row.timestamp),
      from: row.sender,
      text: row.text
    }));
  }
}

module.exports = { MessageStore };
