'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const socket = io({ autoConnect: false });
  const outbox = window.ChatOutbox.createOutbox();

  const el = {
    authScreen: $('auth-screen'),
    loginForm: $('login-form'),
    registerForm: $('register-form'),
    authError: $('auth-error'),
    showRegister: $('show-register'),
    showLogin: $('show-login'),
    joinScreen: $('join-screen'),
    chatScreen: $('chat-screen'),
    joinForm: $('join-form'),
    accountName: $('account-name'),
    room: $('room'),
    joinError: $('join-error'),
    joinRooms: $('join-rooms'),
    roomOptions: $('room-options'),
    roomList: $('room-list'),
    userList: $('user-list'),
    roomName: $('room-name'),
    roomNameSide: $('room-name-side'),
    me: $('me'),
    messages: $('messages'),
    typing: $('typing'),
    messageForm: $('message-form'),
    messageInput: $('message-input'),
    fileInput: $('file-input'),
    fileButton: $('file-button'),
    status: $('status'),
    connectionTestControls: $('connection-test-controls'),
    simulateDisconnect: $('simulate-disconnect'),
    simulateReconnect: $('simulate-reconnect'),
    sidebar: $('sidebar'),
    sidebarOpen: $('sidebar-open'),
    sidebarClose: $('sidebar-close'),
    leaveBtn: $('leave-btn'),
    logoutBtn: $('logout-btn')
  };

  const state = {
    username: null, userId: null, room: null, typing: new Set(), typingTimer: null, isTyping: false,
    seenMessageIds: new Set(), messageRowsByClientId: new Map(), lastMessageId: 0,
    seenFileIds: new Set(), lastFileId: 0, developmentMode: false, offlineQueueWarningShown: false
  };
  let connectionGeneration = 0;
  let roomGeneration = 0;
  const previousSocketStorageKey = 'realtime-chat.previous-socket-id';
  let lastConnectedSocketId = null;
  let suppressSocketResumeToken = false;

  function readPreviousSocketId() {
    try { return window.sessionStorage.getItem(previousSocketStorageKey); }
    catch (_) { return null; }
  }

  function clearPreviousSocketId() {
    try { window.sessionStorage.removeItem(previousSocketStorageKey); }
    catch (_) { /* sessionStorage may be disabled by browser privacy settings. */ }
  }

  function queueContext() {
    return { userId: String(state.userId), room: state.room, connectionGeneration, roomGeneration };
  }

  function isCurrentQueueContext(context) {
    return Boolean(context && socket.connected && String(state.userId) === context.userId &&
      state.room === context.room && connectionGeneration === context.connectionGeneration &&
      roomGeneration === context.roomGeneration);
  }

  const formatTime = (ts) =>
    new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // ---- rendering -------------------------------------------------------

  const outboxKey = (clientMessageId) => `${String(state.userId)}:${clientMessageId}`;

  function setDeliveryStatus(row, status, error) {
    let badge = row.querySelector('.delivery-status');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'delivery-status';
      row.querySelector('.meta').appendChild(badge);
    }
    badge.className = `delivery-status ${status}`;
    badge.textContent = status[0].toUpperCase() + status.slice(1);
    badge.title = error || '';
  }

  function showOutboxSent(clientMessageId, serverMessageId, userId) {
    if (String(state.userId) !== String(userId)) return;
    if (serverMessageId != null) {
      const id = Number(serverMessageId);
      if (Number.isSafeInteger(id) && id > 0) {
        state.seenMessageIds.add(String(serverMessageId));
        if (id > state.lastMessageId) state.lastMessageId = id;
      }
    }
    const row = state.messageRowsByClientId.get(`${String(userId)}:${clientMessageId}`);
    if (row) {
      if (serverMessageId != null) row.dataset.serverMessageId = String(serverMessageId);
      setDeliveryStatus(row, 'sent');
    }
  }

  function markOutboxSent(clientMessageId, serverMessageId) {
    const ownerId = state.userId;
    showOutboxSent(clientMessageId, serverMessageId, ownerId);
    outbox.markSent(clientMessageId, ownerId, serverMessageId)
      .catch(() => localNotice('Could not update the local message status.', 'error'));
  }

  function escapeMessageText(text) {
    return String(text).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  }

  function renderRooms(rooms) {
    el.roomList.innerHTML = '';
    el.joinRooms.innerHTML = '';
    el.roomOptions.innerHTML = '';
    for (const r of rooms) {
      const li = document.createElement('li');
      if (r.name === state.room) li.classList.add('active');
      const name = document.createElement('span');
      name.textContent = '#' + r.name;
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = r.users;
      li.append(name, count);
      el.roomList.appendChild(li);

      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = '#' + r.name + ' (' + r.users + ')';
      chip.addEventListener('click', () => { el.room.value = r.name; el.room.focus(); });
      el.joinRooms.appendChild(chip);

      const opt = document.createElement('option');
      opt.value = r.name;
      el.roomOptions.appendChild(opt);
    }
  }

  function renderUsers(users) {
    el.userList.innerHTML = '';
    for (const u of users) {
      const li = document.createElement('li');
      li.className = 'user' + (u === state.username ? ' me' : '');
      li.textContent = u;
      el.userList.appendChild(li);
    }
  }

  function renderTyping() {
    const names = [...state.typing];
    let text = '';
    if (names.length === 1) text = names[0] + ' is typing...';
    else if (names.length === 2) text = names[0] + ' and ' + names[1] + ' are typing...';
    else if (names.length > 2) text = 'Several people are typing...';
    el.typing.textContent = text;
  }

  function appendMessage(m) {
    if (m.type === 'chat' && m.id != null) {
      const id = Number(m.id);
      const key = String(m.id);
      if (state.seenMessageIds.has(key)) return;
      state.seenMessageIds.add(key);
      if (Number.isSafeInteger(id) && id > state.lastMessageId) state.lastMessageId = id;
    }
    const ownClientMessage = m.type === 'chat' && m.clientMessageId && m.from === state.username;
    if (ownClientMessage) {
      const localKey = outboxKey(m.clientMessageId);
      const existingRow = state.messageRowsByClientId.get(localKey);
      if (existingRow) {
        existingRow.dataset.serverMessageId = String(m.id);
        existingRow.querySelector('.bubble').innerHTML = m.text;
        const time = existingRow.querySelector('.time');
        if (time) time.textContent = formatTime(m.timestamp);
        setDeliveryStatus(existingRow, 'sent');
        markOutboxSent(m.clientMessageId, m.id);
        return;
      }
    }
    if (m.type === 'file' && m.id != null) {
      const id = Number(m.id);
      const key = String(m.id);
      if (state.seenFileIds.has(key)) return;
      state.seenFileIds.add(key);
      if (Number.isSafeInteger(id) && id > state.lastFileId) state.lastFileId = id;
    }

    const li = document.createElement('li');
    li.className = 'msg ' + m.type;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    if (m.type === 'chat' || m.type === 'private' || m.type === 'file') {
      if (m.from === state.username) li.classList.add('own');
      const meta = document.createElement('div');
      meta.className = 'meta';
      const from = document.createElement('span');
      from.className = 'from';
      if (m.type === 'file') {
        from.textContent = m.from;
      } else if (m.type === 'private') {
        from.textContent = m.from === state.username ? 'you -> ' + m.to : m.from + ' -> you';
      } else {
        from.textContent = m.from;
      }
      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = formatTime(m.timestamp);
      meta.append(from, time);
      if (m.type === 'chat' && m.from === state.username && m.clientMessageId) {
        li.dataset.clientMessageId = m.clientMessageId;
        if (m.id != null) li.dataset.serverMessageId = String(m.id);
        state.messageRowsByClientId.set(outboxKey(m.clientMessageId), li);
      }
      li.appendChild(meta);
      if (m.type === 'chat' && m.from === state.username && m.clientMessageId) {
        setDeliveryStatus(li, m.status || 'sent', m.lastError);
      }
      if (m.type === 'file') {
        const name = document.createElement('span');
        name.className = 'file-name';
        name.textContent = m.fileName;
        const size = document.createElement('span');
        size.className = 'file-size';
        size.textContent = formatFileSize(m.fileSize);
        const download = document.createElement('a');
        download.className = 'file-download';
        download.href = m.downloadUrl;
        download.textContent = 'Download';
        download.setAttribute('aria-label', `Download ${m.fileName}`);
        bubble.append(name, size, download);
      } else {
        // Chat text is HTML-escaped by the server before broadcast.
        bubble.innerHTML = m.text;
      }
    } else {
      bubble.textContent = m.text;
    }
    li.appendChild(bubble);
    el.messages.appendChild(li);
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  const localNotice = (text, type) => appendMessage({ type: type || 'system', text, timestamp: Date.now() });
  function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  function renderStoredMessages(messages) {
    messages.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
    for (const message of messages) appendMessage(message);
  }

  // ---- join / leave ----------------------------------------------------

  el.joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    el.joinError.textContent = '';
    const room = el.room.value.trim();
    const joiningUserId = String(state.userId);
    socket.emit('join', { room, previousSocketId: readPreviousSocketId() }, async (res) => {
      if (String(state.userId) !== joiningUserId || !socket.connected) return;
      if (!res.ok) { clearPreviousSocketId(); el.joinError.textContent = res.error; return; }
      clearPreviousSocketId();
      roomGeneration++;
      state.username = res.username;
      state.room = res.room;
      el.roomName.textContent = res.room;
      el.roomNameSide.textContent = res.room;
      el.me.textContent = res.username;
      el.messages.innerHTML = '';
      state.seenMessageIds.clear();
      state.messageRowsByClientId.clear();
      state.lastMessageId = 0;
      state.seenFileIds.clear();
      state.lastFileId = 0;
      const history = res.history || [];
      const persistedClientIds = new Set(history.map((message) => message.clientMessageId).filter(Boolean));
      let queued = [];
      try {
        queued = await outbox.listForRoom(state.userId, state.room);
        for (const item of queued) {
          if (persistedClientIds.has(item.clientMessageId)) {
            await outbox.markSent(item.clientMessageId, state.userId, history.find((message) => message.clientMessageId === item.clientMessageId)?.id);
          }
        }
      } catch (_) {
        localNotice('Could not restore this account’s local message queue.', 'error');
      }
      const localMessages = queued
        .filter((item) => item.status !== 'sent' && !persistedClientIds.has(item.clientMessageId))
        .map((item) => ({
          id: null, type: 'chat', clientMessageId: item.clientMessageId, room: item.room,
          timestamp: item.createdAt, from: state.username, text: escapeMessageText(item.text),
          status: item.status, lastError: item.lastError
        }));
      renderStoredMessages([...history, ...(res.files || []), ...localMessages]);
      localNotice('You joined #' + res.room);
      el.joinScreen.classList.add('hidden');
      el.chatScreen.classList.remove('hidden');
      el.messageInput.focus();
      await syncRoomAndFlush(queueContext());
    });
  });

  el.leaveBtn.addEventListener('click', () => window.location.reload());
  el.logoutBtn.addEventListener('click', async () => {
    connectionGeneration++;
    roomGeneration++;
    state.room = null;
    suppressSocketResumeToken = true;
    clearPreviousSocketId();
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      socket.disconnect();
      window.location.reload();
    }
  });

  el.simulateDisconnect.addEventListener('click', () => {
    if (!state.developmentMode || !socket.connected) return;
    el.simulateDisconnect.disabled = true;
    el.simulateReconnect.disabled = false;
    socket.disconnect();
  });

  el.simulateReconnect.addEventListener('click', () => {
    if (!state.developmentMode || socket.connected) return;
    el.simulateReconnect.disabled = true;
    socket.connect();
  });

  // ---- messaging -------------------------------------------------------

  function updateOutboxRow(clientMessageId, status, error) {
    const row = state.messageRowsByClientId.get(outboxKey(clientMessageId));
    if (row) setDeliveryStatus(row, status, error);
  }

  function sendQueuedRecord(record, context) {
    return new Promise((resolve) => {
      if (!isCurrentQueueContext(context) || record.userId !== context.userId || record.room !== context.room) {
        return resolve({ stopped: true });
      }
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        socket.off('disconnect', onDisconnect);
        resolve(result);
      };
      const onDisconnect = () => finish({ stopped: true });
      socket.once('disconnect', onDisconnect);
      // Volatile prevents a stale queued Socket.IO packet from being sent after
      // this connection closes. The same ID makes a retry safe if MySQL saved
      // the message but this ACK was lost.
      socket.volatile.timeout(8000).emit('message', {
        text: record.text,
        clientMessageId: record.clientMessageId
      }, (timeoutError, response) => {
        if (!isCurrentQueueContext(context)) return finish({ stopped: true });
        if (timeoutError) return finish({ retryable: true, timeout: true, error: 'Message ACK timed out' });
        if (response?.ok === true && response.id != null) return finish(response);
        if (response?.code === 'RATE_LIMITED' || response?.retryable) return finish(response);
        finish(response || { retryable: true, error: 'The server did not acknowledge the message' });
      });
    });
  }

  function newClientMessageId() {
    return window.ChatMessageId.createClientMessageId(window);
  }

  function offlineQueueAvailable() {
    const support = window.ChatMessageId.offlineQueueSupport({
      isSecureContext: window.isSecureContext,
      crypto: window.crypto,
      indexedDB: window.indexedDB
    });
    if (support.supported) return true;
    if (!state.offlineQueueWarningShown) {
      state.offlineQueueWarningShown = true;
      const warning = support.reason === 'insecure-context'
        ? 'Offline message queue needs a secure page (HTTPS or localhost). On a phone, open the laptop server through trusted HTTPS; your draft is still in the input.'
        : support.reason === 'indexeddb-unavailable'
          ? 'This browser does not provide IndexedDB, so offline messages cannot be queued. Your draft is still in the input.'
          : 'This browser does not provide a secure random number generator, so an offline message ID cannot be created. Your draft is still in the input.';
      localNotice(warning, 'error');
    }
    return false;
  }

  el.messageForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = el.messageInput.value.trim();
    if (!text) return;
    const privateCommand = text.match(/^\/pm\s+(\S+)\s+([\s\S]+)$/);
    if (privateCommand) {
      if (!socket.connected) {
        localNotice('Private messages cannot be queued while disconnected.', 'error');
        return;
      }
      socket.emit('message', { text }, (response) => {
        if (!response.ok) localNotice(response.error, 'error');
      });
      el.messageInput.value = '';
      stopTyping();
      return;
    }

    if (!offlineQueueAvailable()) return;

    const context = queueContext();
    const senderName = state.username;
    let record;
    try {
      record = await outbox.enqueue({
        clientMessageId: newClientMessageId(), userId: context.userId,
        room: context.room, text, createdAt: Date.now()
      });
    } catch (error) {
      const message = error.code === 'insecure-context'
        ? 'Offline message queue needs HTTPS or localhost. Your draft is still in the input.'
        : `Could not save the message locally. Your text is still in the input. ${error.message}`;
      localNotice(message, 'error');
      return;
    }
    el.messageInput.value = '';
    stopTyping();
    if (String(state.userId) !== context.userId || state.room !== context.room) return;
    appendMessage({
      id: null, type: 'chat', clientMessageId: record.clientMessageId, room: record.room,
      timestamp: record.createdAt, from: senderName, text: escapeMessageText(record.text), status: 'pending'
    });
    if (isCurrentQueueContext(context)) {
      await outbox.flushPending({
        userId: context.userId, room: context.room,
        onlyClientMessageIds: [record.clientMessageId],
        isCurrent: () => isCurrentQueueContext(context),
        send: (queuedRecord) => sendQueuedRecord(queuedRecord, context),
        onStatus: (queuedRecord, status, error) => {
          if (!isCurrentQueueContext(context)) return;
          if (status === 'sent') showOutboxSent(queuedRecord.clientMessageId, queuedRecord.serverMessageId, context.userId);
          else updateOutboxRow(queuedRecord.clientMessageId, status, error || queuedRecord.lastError);
        }
      });
    }
  });

  el.fileButton.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', async () => {
    const file = el.fileInput.files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { localNotice('Files must be 10 MB or smaller.', 'error'); el.fileInput.value = ''; return; }
    const form = new FormData();
    form.append('file', file);
    el.fileButton.disabled = true;
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(state.room)}/files`, { method: 'POST', body: form });
      const result = await response.json();
      if (!response.ok) localNotice(result.error || 'Upload failed.', 'error');
    } catch (_) {
      localNotice('Could not upload file. Check your connection and try again.', 'error');
    } finally {
      el.fileButton.disabled = false;
      el.fileInput.value = '';
    }
  });

  function stopTyping() {
    clearTimeout(state.typingTimer);
    if (state.isTyping) { state.isTyping = false; socket.emit('typing', false); }
  }

  el.messageInput.addEventListener('input', () => {
    if (!el.messageInput.value) return stopTyping();
    if (!state.isTyping) { state.isTyping = true; socket.emit('typing', true); }
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(stopTyping, 1500);
  });

  // ---- socket events ---------------------------------------------------

  socket.on('rooms:update', renderRooms);
  socket.on('users:update', renderUsers);
  socket.on('message', appendMessage);
  socket.on('typing', ({ username, isTyping }) => {
    if (isTyping) state.typing.add(username); else state.typing.delete(username);
    renderTyping();
  });
  function setConnectionStatus(status) {
    el.status.classList.remove('online', 'reconnecting');
    if (status === 'online') {
      el.status.textContent = 'online';
      el.status.classList.add('online');
    } else if (status === 'reconnecting') {
      el.status.textContent = 'reconnecting...';
      el.status.classList.add('reconnecting');
    } else {
      el.status.textContent = 'connection lost';
    }
  }

  function emitWithAck(event, payload) {
    return new Promise((resolve) => {
      if (!socket.connected) return resolve({ timeout: true });
      socket.timeout(8000).emit(event, payload, (error, response) => {
        resolve(error ? { timeout: true, error } : { response });
      });
    });
  }

  const wait = (duration) => new Promise((resolve) => setTimeout(resolve, duration));

  async function syncMessagesWithRetry(context) {
    const delays = [500, 1000, 2000];
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (!isCurrentQueueContext(context)) return null;
      const result = await emitWithAck('messages:sync', { afterId: state.lastMessageId });
      if (result.response?.ok) return result.response;
      if (!isCurrentQueueContext(context)) return null;
      if (attempt < delays.length) await wait(delays[attempt]);
    }
    return null;
  }

  async function reconcileOutboxHistory(messages, context) {
    if (!isCurrentQueueContext(context)) return;
    const queued = await outbox.listForRoom(context.userId, context.room);
    const byId = new Map(queued.map((record) => [record.clientMessageId, record]));
    for (const message of messages || []) {
      if (message.from !== state.username || !message.clientMessageId || !byId.has(message.clientMessageId)) continue;
      const record = byId.get(message.clientMessageId);
      const saved = await outbox.markSent(record.clientMessageId, context.userId, message.id);
      if (saved) showOutboxSent(record.clientMessageId, message.id, context.userId);
    }
  }

  async function syncRoomAndFlush(context, { reconnected = false } = {}) {
    let sync;
    try { sync = await syncMessagesWithRetry(context); }
    catch (_) { sync = null; }
    if (!isCurrentQueueContext(context)) return;
    if (!sync?.ok) {
      localNotice('Could not sync room history. Pending messages were not sent.', 'error');
      setConnectionStatus('online');
      return;
    }

    try {
      await reconcileOutboxHistory(sync.messages, context);
    } catch (_) {
      localNotice('Could not reconcile the local message queue; pending messages were not sent.', 'error');
      return;
    }

    const fileResult = await emitWithAck('files:sync', { afterId: state.lastFileId });
    if (!isCurrentQueueContext(context)) return;
    if (fileResult.response?.ok) renderStoredMessages([...(sync.messages || []), ...(fileResult.response.files || [])]);
    else {
      renderStoredMessages(sync.messages || []);
      localNotice('Could not sync shared files. Retry the connection to load missing files.', 'error');
    }
    setConnectionStatus('online');
    if (reconnected) localNotice('Reconnected');

    try {
      const report = await outbox.flushPending({
        userId: context.userId,
        room: context.room,
        isCurrent: () => isCurrentQueueContext(context),
        send: (record) => sendQueuedRecord(record, context),
        onStatus: (record, status, error) => {
          if (!isCurrentQueueContext(context)) return;
          if (status === 'sent') showOutboxSent(record.clientMessageId, record.serverMessageId, context.userId);
          else updateOutboxRow(record.clientMessageId, status, error || record.lastError);
        }
      });
      if (report.remaining && isCurrentQueueContext(context)) {
        localNotice('Some messages remain Pending and will be retried after the next connection.', 'error');
      }
    } catch (_) {
      if (isCurrentQueueContext(context)) localNotice('Could not process Pending messages; they remain queued.', 'error');
    }
  }

  async function rejoinAndSync(context) {
    const delays = [500, 1000, 2000];
    let response = null;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      const joinResult = await emitWithAck('join', { room: context.room, previousSocketId: readPreviousSocketId() });
      if (!isCurrentQueueContext(context)) return;
      response = joinResult.response;
      if (response?.ok) break;
      const retryable = joinResult.timeout || response?.code === 'JOIN_IN_PROGRESS';
      if (!retryable || attempt === delays.length) break;
      await wait(delays[attempt]);
    }
    if (!response?.ok) {
      clearPreviousSocketId();
      localNotice(response?.error || 'Could not rejoin the room. Check the connection and retry.', 'error');
      return setConnectionStatus('offline');
    }
    clearPreviousSocketId();
    try { await reconcileOutboxHistory(response.history, context); }
    catch (_) {
      localNotice('Could not reconcile local messages after reconnect.', 'error');
      return;
    }
    await syncRoomAndFlush(context, { reconnected: true });
  }

  socket.on('connect', () => {
    connectionGeneration++;
    lastConnectedSocketId = socket.id;
    if (state.developmentMode) {
      el.simulateDisconnect.disabled = false;
      el.simulateReconnect.disabled = true;
    }
    if (state.room) {
      setConnectionStatus('reconnecting');
      rejoinAndSync(queueContext());
    } else {
      setConnectionStatus('online');
    }
  });
  socket.on('disconnect', () => {
    connectionGeneration++;
    if (!suppressSocketResumeToken && lastConnectedSocketId) {
      try { window.sessionStorage.setItem(previousSocketStorageKey, lastConnectedSocketId); }
      catch (_) { /* Server-side timeout cleanup remains the fallback. */ }
    }
    if (state.developmentMode) {
      el.simulateDisconnect.disabled = true;
      el.simulateReconnect.disabled = false;
    }
    setConnectionStatus('offline');
    if (state.room) localNotice('Connection lost. Reconnecting...', 'error');
  });
  socket.io.on('reconnect_attempt', () => setConnectionStatus('reconnecting'));
  socket.io.on('reconnect_failed', () => setConnectionStatus('offline'));

  window.addEventListener('pagehide', () => {
    if (!suppressSocketResumeToken && socket.connected && lastConnectedSocketId) {
      try { window.sessionStorage.setItem(previousSocketStorageKey, lastConnectedSocketId); }
      catch (_) { /* Server-side timeout cleanup remains the fallback. */ }
    }
  });

  async function enterAuthenticatedSession(user) {
    if (state.userId != null && String(state.userId) !== String(user.id)) {
      connectionGeneration++;
      roomGeneration++;
      state.room = null;
      clearPreviousSocketId();
    }
    state.userId = user.id;
    state.username = user.username;
    el.me.textContent = user.username;
    el.accountName.textContent = user.username;
    el.authScreen.classList.add('hidden');
    el.joinScreen.classList.remove('hidden');
    socket.connect();
  }

  async function submitAuth(form, endpoint) {
    el.authError.textContent = '';
    const values = Object.fromEntries(new FormData(form));
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values)
      });
      const result = await response.json();
      if (!response.ok) {
        el.authError.textContent = result.error || 'Authentication failed';
        return;
      }
      await enterAuthenticatedSession(result.user);
    } catch (_) {
      el.authError.textContent = 'Could not reach the server. Try again.';
    }
  }

  el.loginForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submitAuth(el.loginForm, '/api/auth/login');
  });
  el.registerForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submitAuth(el.registerForm, '/api/auth/register');
  });
  el.showRegister.addEventListener('click', () => {
    el.loginForm.hidden = true;
    el.registerForm.hidden = false;
    el.authError.textContent = '';
  });
  el.showLogin.addEventListener('click', () => {
    el.registerForm.hidden = true;
    el.loginForm.hidden = false;
    el.authError.textContent = '';
  });

  fetch('/api/auth/me')
    .then(async (response) => {
      if (!response.ok) return null;
      return response.json();
    })
    .then((result) => {
      if (result && result.authenticated) enterAuthenticatedSession(result.user);
    })
    .catch(() => { el.authError.textContent = 'Could not reach the server. Try again.'; });

  fetch('/api/config')
    .then((response) => response.ok ? response.json() : null)
    .then((config) => {
      if (!config || config.developmentMode !== true) return;
      state.developmentMode = true;
      el.connectionTestControls.hidden = false;
      el.simulateDisconnect.disabled = !socket.connected;
      el.simulateReconnect.disabled = socket.connected;
    })
    .catch(() => { /* Keep development controls hidden if config cannot be read. */ });

  // ---- sidebar (mobile) ------------------------------------------------

  el.sidebarOpen.addEventListener('click', () => el.sidebar.classList.add('open'));
  el.sidebarClose.addEventListener('click', () => el.sidebar.classList.remove('open'));

})();
