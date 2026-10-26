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

  hasUsername(room, username) {
    const r = this.rooms.get(room);
    if (!r) return false;
    const wanted = username.toLowerCase();
    for (const u of r.users.values()) {
      if (u.toLowerCase() === wanted) return true;
    }
    return false;
  }

  join(room, socketId, username) {
    this._get(room).users.set(socketId, username);
  }

  leave(room, socketId) {
    const r = this.rooms.get(room);
    if (!r) return;
    r.users.delete(socketId);
    if (r.users.size === 0) this.rooms.delete(room);
  }

  users(room) {
    const r = this.rooms.get(room);
    return r ? [...r.users.values()].sort((a, b) => a.localeCompare(b)) : [];
  }

  findSocketId(room, username) {
    const r = this.rooms.get(room);
    if (!r) return null;
    const wanted = username.toLowerCase();
    for (const [id, u] of r.users) {
      if (u.toLowerCase() === wanted) return id;
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
