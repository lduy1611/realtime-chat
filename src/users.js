'use strict';

class UserStore {
  constructor(pool) {
    this.pool = pool;
  }

  async create(username, passwordHash) {
    const usernameKey = username.toLowerCase();
    const [result] = await this.pool.execute(
      'INSERT INTO users (username, username_key, password_hash) VALUES (?, ?, ?)',
      [username, usernameKey, passwordHash]
    );
    return { id: Number(result.insertId), username };
  }

  async findByUsername(username) {
    const [rows] = await this.pool.execute(
      'SELECT id, username, password_hash FROM users WHERE username_key = ? LIMIT 1',
      [username.toLowerCase()]
    );
    return rows[0] ? { id: Number(rows[0].id), username: rows[0].username, passwordHash: rows[0].password_hash } : null;
  }
}

module.exports = { UserStore };
