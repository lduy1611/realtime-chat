'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const socket = io({ autoConnect: false });

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
    seenMessageIds: new Set(), lastMessageId: 0, seenFileIds: new Set(), lastFileId: 0, developmentMode: false
  };

  const formatTime = (ts) =>
    new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // ---- rendering -------------------------------------------------------

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
      li.appendChild(meta);
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
    socket.emit('join', { room }, (res) => {
      if (!res.ok) { el.joinError.textContent = res.error; return; }
      state.username = res.username;
      state.room = res.room;
      el.roomName.textContent = res.room;
      el.roomNameSide.textContent = res.room;
      el.me.textContent = res.username;
      el.messages.innerHTML = '';
      state.seenMessageIds.clear();
      state.lastMessageId = 0;
      state.seenFileIds.clear();
      state.lastFileId = 0;
      renderStoredMessages([...(res.history || []), ...(res.files || [])]);
      localNotice('You joined #' + res.room);
      el.joinScreen.classList.add('hidden');
      el.chatScreen.classList.remove('hidden');
      el.messageInput.focus();
    });
  });

  el.leaveBtn.addEventListener('click', () => window.location.reload());
  el.logoutBtn.addEventListener('click', async () => {
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

  el.messageForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = el.messageInput.value.trim();
    if (!text) return;
    socket.emit('message', { text }, (res) => {
      if (!res.ok) localNotice(res.error, 'error');
    });
    el.messageInput.value = '';
    stopTyping();
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

  function rejoinAndSync() {
    socket.emit('join', { room: state.room }, (res) => {
      if (!res.ok) {
        localNotice(res.error, 'error');
        return setConnectionStatus('offline');
      }
      Promise.all([
        new Promise((resolve) => socket.emit('messages:sync', { afterId: state.lastMessageId }, resolve)),
        new Promise((resolve) => socket.emit('files:sync', { afterId: state.lastFileId }, resolve))
      ]).then(([sync, fileSync]) => {
        if (!sync.ok) localNotice(sync.error, 'error');
        if (!fileSync.ok) localNotice(fileSync.error, 'error');
        renderStoredMessages([...(sync.messages || []), ...(fileSync.files || [])]);
        setConnectionStatus('online');
        localNotice('Reconnected');
      });
    });
  }

  socket.on('connect', () => {
    if (state.developmentMode) {
      el.simulateDisconnect.disabled = false;
      el.simulateReconnect.disabled = true;
    }
    if (state.room) {
      setConnectionStatus('reconnecting');
      rejoinAndSync();
    } else {
      setConnectionStatus('online');
    }
  });
  socket.on('disconnect', () => {
    if (state.developmentMode) {
      el.simulateDisconnect.disabled = true;
      el.simulateReconnect.disabled = false;
    }
    setConnectionStatus('offline');
    if (state.room) localNotice('Connection lost. Reconnecting...', 'error');
  });
  socket.io.on('reconnect_attempt', () => setConnectionStatus('reconnecting'));
  socket.io.on('reconnect_failed', () => setConnectionStatus('offline'));

  async function enterAuthenticatedSession(user) {
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
