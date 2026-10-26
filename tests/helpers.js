'use strict';

const session = require('express-session');
const { createSession } = require('../src/auth');

class TestUserStore {
  constructor() {
    this.users = [];
    this.nextId = 1;
  }

  async create(username, passwordHash) {
    if (await this.findByUsername(username)) {
      const error = new Error('duplicate username');
      error.code = 'ER_DUP_ENTRY';
      throw error;
    }
    const user = { id: this.nextId++, username, passwordHash };
    this.users.push(user);
    return { id: user.id, username: user.username };
  }

  async findByUsername(username) {
    return this.users.find((user) => user.username.toLowerCase() === username.toLowerCase()) || null;
  }
}

function createTestSession() {
  return createSession({ store: new session.MemoryStore(), secret: 'test_only_session_secret_not_for_production_0123456789' });
}

module.exports = { TestUserStore, createTestSession };
