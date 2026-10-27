'use strict';

/**
 * In-memory room registry. Each room tracks only its live members.
 */
const HISTORY_LIMIT = 100;

class RoomStore {
  constructor({ historyLimit = HISTORY_LIMIT } = {}) {
    this.rooms = new Map();
    this.historyLimit = historyLimit;
  }

  _get(room) {
    if (!this.rooms.has(room)) {
      this.rooms.set(room, { users: new Map() });
    }
    return this.rooms.get(room);
  }

  hasUser(room, userId) {
    return Boolean(this.findMemberByUserId(room, userId));
  }

  join(room, socketId, user) {
    this._get(room).users.set(socketId, { id: user.id, username: user.username, sessionId: user.sessionId });
  }

  findMemberByUserId(room, userId) {
    const r = this.rooms.get(room);
    if (!r) return null;
    for (const [socketId, user] of r.users) {
      if (String(user.id) === String(userId)) return { ...user, socketId };
    }
    return null;
  }

  leave(room, socketId) {
    const r = this.rooms.get(room);
    if (!r) return;
    r.users.delete(socketId);
    if (r.users.size === 0) this.rooms.delete(room);
  }

  users(room) {
    const r = this.rooms.get(room);
    return r ? [...r.users.values()].map((user) => user.username).sort((a, b) => a.localeCompare(b)) : [];
  }

  findUser(room, username) {
    const r = this.rooms.get(room);
    if (!r) return null;
    const wanted = username.toLowerCase();
    for (const [socketId, user] of r.users) {
      if (user.username.toLowerCase() === wanted) return { ...user, socketId };
    }
    return null;
  }

  findSocketId(room, userId) {
    const r = this.rooms.get(room);
    if (!r) return null;
    for (const [socketId, user] of r.users) {
      if (String(user.id) === String(userId)) return socketId;
    }
    return null;
  }

  summary() {
    return [...this.rooms.entries()]
      .map(([name, r]) => ({ name, users: r.users.size }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

module.exports = { RoomStore, HISTORY_LIMIT };
