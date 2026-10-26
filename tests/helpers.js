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

class TestFileStore {
  constructor() { this.files = []; this.nextId = 1; }
  async save(file) { const saved = { ...file, id: this.nextId++ }; this.files.push(saved); return saved; }
  async findById(id) { return this.files.find((file) => file.id === Number(id)) || null; }
  async getRoomHistory(room, limit) {
    return this.files.filter((file) => file.room === room).slice(-limit).map(publicFile);
  }
  async getRoomFilesAfter(room, afterId) {
    return this.files.filter((file) => file.room === room && file.id > afterId).map(publicFile);
  }
}

function publicFile(file) {
  return { id: file.id, type: 'file', room: file.room, from: file.uploader, fileName: file.originalName, fileSize: file.size, mimeType: file.mimeType, timestamp: file.timestamp, downloadUrl: `/api/files/${file.id}/download` };
}

function createTestSession() {
  return createSession({ store: new session.MemoryStore(), secret: 'test_only_session_secret_not_for_production_0123456789' });
}

module.exports = { TestUserStore, TestFileStore, createTestSession };
