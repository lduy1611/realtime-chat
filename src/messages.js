'use strict';

class MessageStore {
  constructor(pool) {
    this.pool = pool;
  }

  async save(message) {
    const timestamp = Date.now();
    const [result] = await this.pool.execute(
      'INSERT INTO messages (type, room, sender, recipient, text, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
      [message.type, message.room, message.from, message.to || null, message.text, timestamp]
    );
    return { id: result.insertId, timestamp };
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
}

module.exports = { MessageStore };
