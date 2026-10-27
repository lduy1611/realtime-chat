'use strict';

const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { Server } = require('socket.io');
const { RoomStore } = require('./rooms');
const { RateLimiter } = require('./rateLimit');
const { validateName, sanitizeMessage } = require('./validate');
const { installAuthRoutes, sameOrigin } = require('./auth');
const { MAX_FILE_SIZE, safeOriginalName, detectFile, publicFile } = require('./files');

const PM_RE = /^\/pm\s+(\S+)\s+([\s\S]+)$/;
const CLIENT_MESSAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
  // cloudflared connects from this host to localhost. Trust forwarded host and
  // protocol headers only when the immediate peer is loopback, never any proxy.
  app.set('trust proxy', 'loopback');
  const httpServer = options.httpsOptions
    ? https.createServer(options.httpsOptions, app)
    : http.createServer(app);
  const io = new Server(httpServer);
  const rooms = new RoomStore({ historyLimit: options.historyLimit });
  const messageStore = options.messageStore;
  const userStore = options.userStore;
  const sessionMiddleware = options.sessionMiddleware;
  const fileStore = options.fileStore;
  const uploadsDir = options.uploadsDir || path.join(__dirname, '..', 'uploads');
  const developmentMode = options.developmentMode ?? process.env.NODE_ENV === 'development';
  if (!messageStore || !userStore || !sessionMiddleware) {
    throw new Error('createServer requires messageStore, userStore, and sessionMiddleware');
  }

  app.use(express.json({ limit: '10kb' }));
  app.use(sessionMiddleware);
  app.use(express.static(path.join(__dirname, '..', 'public')));
  installAuthRoutes(app, { userStore, io });

  const requireAccount = (req, res, next) => {
    if (!req.session?.user?.id) return res.status(401).json({ error: 'Authentication required' });
    next();
  };
  if (fileStore) {
    fs.mkdirSync(uploadsDir, { recursive: true });
    const upload = multer({
      // Browser multipart filenames are UTF-8 bytes; Busboy otherwise decodes
      // non-extended `filename=` parameters as Latin-1 by default.
      defParamCharset: 'utf8',
      storage: multer.diskStorage({
        destination: (_req, _file, callback) => callback(null, uploadsDir),
        filename: (_req, _file, callback) => callback(null, `${crypto.randomUUID()}.upload`)
      }),
      limits: { fileSize: MAX_FILE_SIZE, files: 1 }
    }).single('file');

    app.post('/api/rooms/:room/files', sameOrigin, requireAccount, (req, res, next) => {
      upload(req, res, (error) => {
        if (!error) return next();
        if (req.file?.path) fs.promises.unlink(req.file.path).catch(() => {});
        const tooLarge = error.code === 'LIMIT_FILE_SIZE';
        return res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? 'File exceeds the 10 MB limit' : 'A single file upload is required' });
      });
    }, async (req, res) => {
      const room = req.params.room;
      const user = req.session.user;
      if (!req.file) return res.status(400).json({ error: 'Choose a file to upload' });
      if (!rooms.hasUser(room, user.id)) {
        await fs.promises.unlink(req.file.path).catch(() => {});
        return res.status(403).json({ error: 'Join this room before uploading files' });
      }
      const originalName = safeOriginalName(req.file.originalname);
      let detected;
      try {
        detected = detectFile(await fs.promises.readFile(req.file.path), originalName);
      } catch (error) {
        await fs.promises.unlink(req.file.path).catch(() => {});
        console.error('Failed to inspect uploaded file:', error);
        return res.status(500).json({ error: 'Could not inspect uploaded file' });
      }
      if (!detected) {
        await fs.promises.unlink(req.file.path).catch(() => {});
        return res.status(415).json({ error: 'Unsupported or invalid file type' });
      }
      try {
        const saved = await fileStore.save({
          room, uploadedBy: user.id, uploader: user.username, originalName,
          storageName: path.basename(req.file.filename, '.upload'), mimeType: detected.mime,
          size: req.file.size, timestamp: Date.now()
        });
        const message = publicFile(saved);
        io.to(room).emit('message', message);
        res.status(201).json(message);
      } catch (error) {
        await fs.promises.unlink(req.file.path).catch(() => {});
        console.error('Failed to save file metadata:', error);
        res.status(500).json({ error: 'Could not save file metadata' });
      }
    });

    app.get('/api/files/:id/download', requireAccount, async (req, res) => {
      if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'File not found' });
      try {
        const file = await fileStore.findById(Number(req.params.id));
        if (!file) return res.status(404).json({ error: 'File not found' });
        if (!rooms.hasUser(file.room, req.session.user.id)) return res.status(403).json({ error: 'Join this room to download the file' });
        if (!/^[a-f0-9-]{36}$/i.test(file.storageName)) return res.status(404).json({ error: 'File not found' });
        const storagePath = path.join(uploadsDir, `${file.storageName}.upload`);
        const asciiFilename = file.originalName.replace(/[^\x20-\x7e]|["\\;]/g, '_');
        const encodedFilename = encodeURIComponent(file.originalName).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
        res.set({
          'Content-Type': file.mimeType,
          'Content-Length': String(file.size),
          'Content-Disposition': `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, no-store'
        });
        const stream = fs.createReadStream(storagePath);
        stream.on('error', (error) => {
          if (!res.headersSent) res.status(error.code === 'ENOENT' ? 404 : 500).json({ error: 'File is unavailable' });
          else res.destroy(error);
        });
        stream.pipe(res);
      } catch (error) {
        console.error('File download failed:', error);
        if (!res.headersSent) res.status(500).json({ error: 'Could not download file' });
      }
    });
  }

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

  io.engine.use(sessionMiddleware);
  io.use((socket, next) => {
    const user = socket.request.session && socket.request.session.user;
    if (!user || !user.id || !user.username) return next(new Error('Authentication required'));
    socket.data.userId = user.id;
    socket.data.username = user.username;
    socket.data.sessionId = socket.request.sessionID;
    next();
  });

  async function sendPrivate(socket, target, body, clientMessageId, reply) {
    const { room, username } = socket.data;
    const { error, text } = sanitizeMessage(body);
    if (error) return reply({ ok: false, error });

    try {
      if (clientMessageId && messageStore.findByClientMessageId) {
        const previous = await messageStore.findByClientMessageId(socket.data.userId, clientMessageId);
        if (previous) {
          if (previous.type !== 'private' || previous.room !== room || previous.text !== text || previous.recipient?.toLowerCase() !== target.toLowerCase()) {
            return reply({ ok: false, error: 'Client message ID conflicts with a previously saved message', code: 'MESSAGE_ID_CONFLICT' });
          }
          return reply({ ok: true, id: previous.id, clientMessageId });
        }
      }

      const targetUser = rooms.findUser(room, target);
      if (!targetUser) return reply({ ok: false, error: `User "${target}" is not in this room` });
      const targetId = rooms.findSocketId(room, targetUser.id);
      if (targetId === socket.id) return reply({ ok: false, error: 'You cannot message yourself' });
      const recipient = targetUser.username;

      const saved = await messageStore.save({
        type: 'private', room, from: username, userId: socket.data.userId,
        clientMessageId: clientMessageId || null, to: recipient, text
      });
      const message = { id: saved.id, type: 'private', room, timestamp: saved.timestamp, from: username, to: recipient, text,
        ...(clientMessageId ? { clientMessageId } : {}) };
      if (!saved.duplicate) {
        io.to(targetId).emit('message', message);
        socket.emit('message', message);
      }
      reply({ ok: true, id: message.id, ...(clientMessageId ? { clientMessageId } : {}) });
    } catch (error) {
      if (error.code === 'MESSAGE_ID_CONFLICT') {
        return reply({ ok: false, error: 'Client message ID conflicts with a previously saved message', code: 'MESSAGE_ID_CONFLICT' });
      }
      console.error('Failed to save private message:', error);
      reply({ ok: false, error: 'Message could not be saved. Please try again.' });
    }
  }

  io.on('connection', (socket) => {
    socket.data.limiter = new RateLimiter(rateLimit);
    socket.join(`session:${socket.data.sessionId}`);
    socket.emit('rooms:update', rooms.summary());

    socket.on('join', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const { room } = payload || {};

      const err = validateName(room, 'Room');
      if (err) return reply({ ok: false, error: err });
      const roomName = room.trim();
      if (socket.data.joining) return reply({ ok: false, error: 'Room join is already in progress', code: 'JOIN_IN_PROGRESS', retryable: true });
      if (socket.data.room) {
        if (socket.data.room !== roomName) return reply({ ok: false, error: 'Already joined a room' });
        try {
          const [history, files] = await Promise.all([
            messageStore.getRoomHistory(roomName, rooms.historyLimit),
            fileStore ? fileStore.getRoomHistory(roomName, rooms.historyLimit) : Promise.resolve([])
          ]);
          return reply({ ok: true, username: socket.data.username, room: roomName, history, files });
        } catch (error) {
          console.error('Failed to reload room history:', error);
          return reply({ ok: false, error: 'Could not load chat history. Please try again.' });
        }
      }

      const existingMember = rooms.findMemberByUserId(roomName, socket.data.userId);
      if (existingMember) {
        // A mobile transport can be half-open while its client has already
        // reconnected. Replace only the exact previous socket reported by that
        // client and only within the same authenticated session. This keeps
        // separate tabs/sessions from evicting one another.
        const previousSocketId = typeof payload?.previousSocketId === 'string' ? payload.previousSocketId : null;
        if (existingMember.sessionId !== socket.data.sessionId || existingMember.socketId !== previousSocketId) {
          return reply({ ok: false, error: 'This account is already in this room' });
        }
        const previousSocket = io.sockets.sockets.get(existingMember.socketId);
        if (previousSocket && previousSocket.id !== socket.id) previousSocket.disconnect(true);
        else if (!previousSocket) {
          rooms.leave(roomName, existingMember.socketId);
          broadcastUsers(roomName);
          broadcastRooms();
        } else {
          return reply({ ok: false, error: 'Already joined a room' });
        }
      }

      const { username, userId } = socket.data;
      socket.data.joining = true;
      socket.data.room = roomName;
      rooms.join(roomName, socket.id, { id: userId, username, sessionId: socket.data.sessionId });
      socket.join(roomName);

      let history;
      let files = [];
      try {
        [history, files] = await Promise.all([
          messageStore.getRoomHistory(roomName, rooms.historyLimit),
          fileStore ? fileStore.getRoomHistory(roomName, rooms.historyLimit) : Promise.resolve([])
        ]);
      } catch (error) {
        rooms.leave(roomName, socket.id);
        socket.leave(roomName);
        delete socket.data.room;
        delete socket.data.joining;
        console.error('Failed to load room history:', error);
        return reply({ ok: false, error: 'Could not load chat history. Please try again.' });
      }
      if (!socket.connected) {
        rooms.leave(roomName, socket.id);
        socket.leave(roomName);
        delete socket.data.room;
        delete socket.data.joining;
        return;
      }
      delete socket.data.joining;

      reply({ ok: true, username, room: roomName, history, files });
      socket.to(roomName).emit('message', makeMessage('system', roomName, { text: `${username} joined the room` }));
      broadcastUsers(roomName);
      broadcastRooms();
    });

    socket.on('message', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const { room, username } = socket.data;
      if (!room) return reply({ ok: false, error: 'Join a room first' });

      const raw = payload && payload.text;
      const rawClientMessageId = payload && payload.clientMessageId;
      if (rawClientMessageId !== undefined && (typeof rawClientMessageId !== 'string' || !CLIENT_MESSAGE_ID_RE.test(rawClientMessageId))) {
        return reply({ ok: false, error: 'Invalid client message ID' });
      }
      // UUIDs are case-insensitive; canonicalize before the binary-collated DB key.
      const clientMessageId = rawClientMessageId?.toLowerCase();

      const pm = typeof raw === 'string' ? raw.trim().match(PM_RE) : null;
      // Idempotent retries do not consume a new-message rate-limit token.
      if (clientMessageId && messageStore.findByClientMessageId) {
        const { error, text } = sanitizeMessage(pm ? pm[2] : raw);
        if (!error) {
          try {
            const previous = await messageStore.findByClientMessageId(socket.data.userId, clientMessageId);
            if (previous) {
              const expectedType = pm ? 'private' : 'chat';
              const expectedRecipient = pm ? pm[1].toLowerCase() : null;
              if (previous.type !== expectedType || previous.room !== room || previous.text !== text || (previous.recipient?.toLowerCase() ?? null) !== expectedRecipient) {
                return reply({ ok: false, error: 'Client message ID conflicts with a previously saved message', code: 'MESSAGE_ID_CONFLICT' });
              }
              return reply({ ok: true, id: previous.id, clientMessageId });
            }
          } catch (error) {
            console.error('Failed to check message retry:', error);
            return reply({ ok: false, error: 'Message status could not be checked. Please retry.', code: 'PERSISTENCE_ERROR', retryable: true });
          }
        }
      }

      if (!socket.data.limiter.allow()) {
        const limited = { ok: false, error: 'You are sending messages too quickly' };
        return reply(pm ? limited : { ...limited, code: 'RATE_LIMITED', retryAfterMs: rateLimit.windowMs });
      }
      if (pm) return sendPrivate(socket, pm[1], pm[2], clientMessageId, reply);

      const { error, text } = sanitizeMessage(raw);
      if (error) return reply({ ok: false, error });

      try {
        const saved = await messageStore.save({
          type: 'chat', room, from: username, userId: socket.data.userId,
          clientMessageId: clientMessageId || null, to: null, text
        });
        const message = {
          id: saved.id, type: 'chat', room, timestamp: saved.timestamp, from: username, text,
          ...(clientMessageId ? { clientMessageId } : {})
        };
        if (!saved.duplicate) io.to(room).emit('message', message);
        reply({ ok: true, id: message.id, ...(clientMessageId ? { clientMessageId } : {}) });
      } catch (error) {
        if (error.code === 'MESSAGE_ID_CONFLICT') {
          return reply({ ok: false, error: 'Client message ID conflicts with a previously saved message', code: 'MESSAGE_ID_CONFLICT' });
        }
        console.error('Failed to save room message:', error);
        reply({ ok: false, error: 'Message could not be saved. Please try again.', code: 'PERSISTENCE_ERROR', retryable: true });
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

    socket.on('files:sync', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const { room } = socket.data;
      if (!room) return reply({ ok: false, error: 'Join a room first' });
      const afterId = payload && Number(payload.afterId);
      if (!Number.isSafeInteger(afterId) || afterId < 0) return reply({ ok: false, error: 'Invalid file cursor' });
      if (!fileStore) return reply({ ok: true, files: [] });
      try {
        reply({ ok: true, files: await fileStore.getRoomFilesAfter(room, afterId) });
      } catch (error) {
        console.error('Failed to sync room files:', error);
        reply({ ok: false, error: 'Could not sync files. Please try again.' });
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
