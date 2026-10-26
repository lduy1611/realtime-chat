'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const { RoomStore } = require('./rooms');
const { RateLimiter } = require('./rateLimit');
const { validateName, sanitizeMessage } = require('./validate');

const PM_RE = /^\/pm\s+(\S+)\s+([\s\S]+)$/;
let nextMessageId = 1;

function makeMessage(type, room, fields) {
  return { id: nextMessageId++, type, room, timestamp: Date.now(), ...fields };
}

/**
 * Builds the HTTP + Socket.IO server without binding to a port,
 * so it can be used both by the entry point and by tests.
 */
function createServer(options = {}) {
  const app = express();
  const httpServer = http.createServer(app);
  const io = new Server(httpServer);
  const rooms = new RoomStore({ historyLimit: options.historyLimit });
  const messageStore = options.messageStore;
  const developmentMode = options.developmentMode ?? process.env.NODE_ENV === 'development';
  if (!messageStore) throw new Error('createServer requires a messageStore');

  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  app.get('/api/config', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ developmentMode });
  });

  app.get('/api/rooms', (req, res) => {
    res.json(rooms.summary());
  });

  const broadcastRooms = () => io.emit('rooms:update', rooms.summary());
  const broadcastUsers = (room) => io.to(room).emit('users:update', rooms.users(room));

  const rateLimit = { limit: 5, windowMs: 1000, ...(options.rateLimit || {}) };

  async function sendPrivate(socket, target, body, reply) {
    const { room, username } = socket.data;
    const { error, text } = sanitizeMessage(body);
    if (error) return reply({ ok: false, error });

    const targetId = rooms.findSocketId(room, target);
    if (!targetId) return reply({ ok: false, error: `User "${target}" is not in this room` });
    if (targetId === socket.id) return reply({ ok: false, error: 'You cannot message yourself' });

    const recipient = rooms.users(room).find((u) => u.toLowerCase() === target.toLowerCase());
    try {
      const saved = await messageStore.save({ type: 'private', room, from: username, to: recipient, text });
      const message = { id: saved.id, type: 'private', room, timestamp: saved.timestamp, from: username, to: recipient, text };
      io.to(targetId).emit('message', message);
      socket.emit('message', message);
      reply({ ok: true, id: message.id });
    } catch (error) {
      console.error('Failed to save private message:', error);
      reply({ ok: false, error: 'Message could not be saved. Please try again.' });
    }
  }

  io.on('connection', (socket) => {
    socket.data.limiter = new RateLimiter(rateLimit);
    socket.emit('rooms:update', rooms.summary());

    socket.on('join', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const { username, room } = payload || {};

      const err = validateName(username, 'Username') || validateName(room, 'Room');
      if (err) return reply({ ok: false, error: err });
      if (socket.data.room || socket.data.joining) return reply({ ok: false, error: 'Already joined a room' });

      const name = username.trim();
      const roomName = room.trim();
      if (rooms.hasUsername(roomName, name)) {
        return reply({ ok: false, error: 'Username is already taken in this room' });
      }

      socket.data.joining = true;
      socket.data.username = name;
      socket.data.room = roomName;
      rooms.join(roomName, socket.id, name);
      socket.join(roomName);

      let history;
      try {
        history = await messageStore.getRoomHistory(roomName, rooms.historyLimit);
      } catch (error) {
        rooms.leave(roomName, socket.id);
        socket.leave(roomName);
        delete socket.data.username;
        delete socket.data.room;
        delete socket.data.joining;
        console.error('Failed to load room history:', error);
        return reply({ ok: false, error: 'Could not load chat history. Please try again.' });
      }
      delete socket.data.joining;

      reply({ ok: true, username: name, room: roomName, history });
      socket.to(roomName).emit('message', makeMessage('system', roomName, { text: `${name} joined the room` }));
      broadcastUsers(roomName);
      broadcastRooms();
    });

    socket.on('message', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const { room, username } = socket.data;
      if (!room) return reply({ ok: false, error: 'Join a room first' });
      if (!socket.data.limiter.allow()) {
        return reply({ ok: false, error: 'You are sending messages too quickly' });
      }

      const raw = payload && payload.text;
      const pm = typeof raw === 'string' ? raw.trim().match(PM_RE) : null;
      if (pm) return sendPrivate(socket, pm[1], pm[2], reply);

      const { error, text } = sanitizeMessage(raw);
      if (error) return reply({ ok: false, error });

      try {
        const saved = await messageStore.save({ type: 'chat', room, from: username, to: null, text });
        const message = { id: saved.id, type: 'chat', room, timestamp: saved.timestamp, from: username, text };
        io.to(room).emit('message', message);
        reply({ ok: true, id: message.id });
      } catch (error) {
        console.error('Failed to save room message:', error);
        reply({ ok: false, error: 'Message could not be saved. Please try again.' });
      }
    });

    socket.on('messages:sync', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const { room } = socket.data;
      if (!room) return reply({ ok: false, error: 'Join a room first' });

      const afterId = payload && Number(payload.afterId);
      if (!Number.isSafeInteger(afterId) || afterId < 0) {
        return reply({ ok: false, error: 'Invalid message cursor' });
      }

      try {
        const messages = await messageStore.getRoomMessagesAfter(room, afterId);
        reply({ ok: true, messages });
      } catch (error) {
        console.error('Failed to sync room messages:', error);
        reply({ ok: false, error: 'Could not sync chat messages. Please try again.' });
      }
    });

    socket.on('typing', (isTyping) => {
      const { room, username } = socket.data;
      if (!room) return;
      socket.to(room).emit('typing', { username, isTyping: Boolean(isTyping) });
    });

    socket.on('disconnect', () => {
      const { room, username } = socket.data;
      if (!room) return;
      rooms.leave(room, socket.id);
      socket.to(room).emit('message', makeMessage('system', room, { text: `${username} left the room` }));
      socket.to(room).emit('typing', { username, isTyping: false });
      broadcastUsers(room);
      broadcastRooms();
    });
  });

  return { app, httpServer, io, rooms };
}

module.exports = { createServer };
