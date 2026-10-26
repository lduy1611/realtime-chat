'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const socket = io();

  const el = {
    joinScreen: $('join-screen'),
    chatScreen: $('chat-screen'),
    joinForm: $('join-form'),
    username: $('username'),
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
    status: $('status'),
    connectionTestControls: $('connection-test-controls'),
    simulateDisconnect: $('simulate-disconnect'),
    simulateReconnect: $('simulate-reconnect'),
    sidebar: $('sidebar'),
    sidebarOpen: $('sidebar-open'),
    sidebarClose: $('sidebar-close'),
    leaveBtn: $('leave-btn')
  };

  const state = {
    username: null, room: null, typing: new Set(), typingTimer: null, isTyping: false,
    seenMessageIds: new Set(), lastMessageId: 0, developmentMode: false
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
      chip.addEventListener('click', () => { el.room.value = r.name; el.username.focus(); });
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

    const li = document.createElement('li');
    li.className = 'msg ' + m.type;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    if (m.type === 'chat' || m.type === 'private') {
      if (m.from === state.username) li.classList.add('own');
      const meta = document.createElement('div');
      meta.className = 'meta';
      const from = document.createElement('span');
      from.className = 'from';
      if (m.type === 'private') {
        from.textContent = m.from === state.username ? 'you -> ' + m.to : m.from + ' -> you';
      } else {
        from.textContent = m.from;
      }
      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = formatTime(m.timestamp);
      meta.append(from, time);
      li.appendChild(meta);
      // Chat text is HTML-escaped by the server before broadcast.
      bubble.innerHTML = m.text;
    } else {
      bubble.textContent = m.text;
    }
    li.appendChild(bubble);
    el.messages.appendChild(li);
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  const localNotice = (text, type) => appendMessage({ type: type || 'system', text, timestamp: Date.now() });

  // ---- join / leave ----------------------------------------------------

  el.joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    el.joinError.textContent = '';
    const username = el.username.value.trim();
    const room = el.room.value.trim();
    socket.emit('join', { username, room }, (res) => {
      if (!res.ok) { el.joinError.textContent = res.error; return; }
      state.username = res.username;
      state.room = res.room;
      el.roomName.textContent = res.room;
      el.roomNameSide.textContent = res.room;
      el.me.textContent = res.username;
      el.messages.innerHTML = '';
      state.seenMessageIds.clear();
      state.lastMessageId = 0;
      for (const m of res.history) appendMessage(m);
      localNotice('You joined #' + res.room);
      el.joinScreen.classList.add('hidden');
      el.chatScreen.classList.remove('hidden');
      el.messageInput.focus();
      try { localStorage.setItem('rc:username', res.username); } catch (_) { /* storage unavailable */ }
    });
  });

  el.leaveBtn.addEventListener('click', () => window.location.reload());

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
    socket.emit('join', { username: state.username, room: state.room }, (res) => {
      if (!res.ok) {
        localNotice(res.error, 'error');
        return setConnectionStatus('offline');
      }
      socket.emit('messages:sync', { afterId: state.lastMessageId }, (sync) => {
        if (!sync.ok) localNotice(sync.error, 'error');
        else for (const message of sync.messages) appendMessage(message);
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

  try {
    const saved = localStorage.getItem('rc:username');
    if (saved) el.username.value = saved;
  } catch (_) { /* storage unavailable */ }
})();
