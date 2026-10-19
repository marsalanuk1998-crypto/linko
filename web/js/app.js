'use strict';
(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  let me = null;
  let privKey = null;
  let currentPeer = null;
  let chats = [];
  let messageCache = {}; // chatId -> messages
  let peerKeys = {}; // userId -> publicKey
  let aesCache = {}; // userId -> CryptoKey
  let presence = {}; // userId -> { online, lastSeen }
  let typingTimers = {};
  let recording = false;
  let mediaRecorder = null;
  let recordChunks = [];

  function show(id) {
    $$('.screen').forEach(s => s.classList.add('hidden'));
    const el = document.getElementById(id);
    if (el) el.classList.remove('hidden');
  }

  function toastError(el, msg) {
    el.hidden = !msg;
    el.textContent = msg || '';
  }

  function initials(name) {
    return String(name || '?').trim().slice(0, 1).toUpperCase();
  }

  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function fmtLastSeen(ts) {
    if (!ts) return 'last seen recently';
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return 'last seen today at ' + fmtTime(ts);
    return 'last seen ' + d.toLocaleDateString() + ' ' + fmtTime(ts);
  }

  async function getAes(peer) {
    if (!peer?.publicKey) throw new Error('Peer has no public key');
    if (aesCache[peer.id]) return aesCache[peer.id];
    const key = await LinkoCrypto.deriveAesKey(privKey, peer.publicKey);
    aesCache[peer.id] = key;
    peerKeys[peer.id] = peer.publicKey;
    return key;
  }

  async function decryptMessage(msg) {
    const peerId = msg.from === me.id ? msg.to : msg.from;
    let pub = peerKeys[peerId];
    if (!pub) {
      const r = await LinkoApi.req('/api/users/' + peerId);
      pub = r.user.publicKey;
      peerKeys[peerId] = pub;
    }
    const aes = await LinkoCrypto.deriveAesKey(privKey, pub);
    aesCache[peerId] = aes;
    try {
      if (msg.type === 'text') {
        return { kind: 'text', text: await LinkoCrypto.decryptText(aes, msg.iv, msg.ciphertext) };
      }
      const meta = msg.meta
        ? await LinkoCrypto.decryptJson(aes, msg.meta.iv, msg.meta.ciphertext).catch(() => ({}))
        : {};
      if (!msg.mediaId) return { kind: 'text', text: '[media missing]' };
      const enc = await LinkoApi.downloadMedia(msg.mediaId);
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: LinkoCrypto.unb64(msg.iv) },
        aes,
        enc
      );
      const bytes = new Uint8Array(plain);
      if (msg.type === 'image') {
        const blob = new Blob([bytes], { type: meta.mime || 'image/jpeg' });
        return { kind: 'image', url: URL.createObjectURL(blob), meta };
      }
      if (msg.type === 'voice') {
        const blob = new Blob([bytes], { type: meta.mime || 'audio/webm' });
        return { kind: 'voice', url: URL.createObjectURL(blob), meta };
      }
      const blob = new Blob([bytes], { type: meta.mime || 'application/octet-stream' });
      return { kind: 'file', url: URL.createObjectURL(blob), name: meta.name || 'file', meta };
    } catch (e) {
      console.warn('decrypt fail', e);
      return { kind: 'text', text: 'Unable to decrypt' };
    }
  }

  function ticks(msg) {
    if (msg.from !== me.id) return '';
    if (msg.readAt) return '<span class="ticks read">✓✓</span>';
    if (msg.deliveredAt) return '<span class="ticks">✓✓</span>';
    return '<span class="ticks">✓</span>';
  }

  async function renderMessages(chatId) {
    const box = $('#messages');
    box.innerHTML = '';
    const list = messageCache[chatId] || [];
    for (const msg of list) {
      const div = document.createElement('div');
      div.className = 'bubble ' + (msg.from === me.id ? 'me' : 'you');
      div.dataset.id = msg.id;
      const body = document.createElement('div');
      body.className = 'body';
      body.textContent = '…';
      div.appendChild(body);
      const stamp = document.createElement('div');
      stamp.className = 'stamp';
      stamp.innerHTML = `<span>${fmtTime(msg.createdAt)}</span>${ticks(msg)}`;
      div.appendChild(stamp);
      box.appendChild(div);
      decryptMessage(msg).then(content => {
        body.innerHTML = '';
        if (content.kind === 'text') body.textContent = content.text;
        else if (content.kind === 'image') {
          const img = document.createElement('img');
          img.className = 'media';
          img.src = content.url;
          img.alt = 'image';
          body.appendChild(img);
        } else if (content.kind === 'voice') {
          const a = document.createElement('audio');
          a.controls = true;
          a.src = content.url;
          body.appendChild(a);
        } else if (content.kind === 'file') {
          const chip = document.createElement('a');
          chip.className = 'file-chip';
          chip.href = content.url;
          chip.download = content.name;
          chip.textContent = '📄 ' + content.name;
          body.appendChild(chip);
        }
      });
      if (msg.to === me.id && !msg.readAt) {
        LinkoApi.send({ type: 'receipt', messageId: msg.id, chatId, status: 'read' });
      }
    }
    box.scrollTop = box.scrollHeight;
  }

  function renderChatList() {
    const list = $('#chat-list');
    list.innerHTML = '';
    $('#empty-chats').classList.toggle('hidden', chats.length > 0);
    for (const c of chats) {
      if (!c.peer) continue;
      const row = document.createElement('div');
      row.className = 'chat-item';
      row.innerHTML = `
        <div class="avatar">${initials(c.peer.displayName)}</div>
        <div class="meta">
          <div class="name">${escapeHtml(c.peer.displayName)}</div>
          <div class="preview">${c.lastMessage ? (c.lastMessage.type + ' · ' + fmtTime(c.lastMessage.createdAt)) : 'No messages yet'}</div>
        </div>
        <div class="time">${c.updatedAt ? fmtTime(c.updatedAt) : ''}</div>`;
      row.onclick = () => openChat(c.peer);
      list.appendChild(row);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  async function refreshChats() {
    const data = await LinkoApi.req('/api/chats');
    chats = data.chats || [];
    renderChatList();
  }

  async function openChat(peer) {
    currentPeer = peer;
    peerKeys[peer.id] = peer.publicKey;
    show('screen-chat');
    $('#peer-name').textContent = peer.displayName;
    updatePeerStatus();
    const chatId = [me.id, peer.id].sort().join(':');
    try {
      const data = await LinkoApi.req('/api/chats/' + encodeURIComponent(chatId) + '/messages');
      messageCache[chatId] = data.messages || [];
    } catch {
      messageCache[chatId] = messageCache[chatId] || [];
    }
    await renderMessages(chatId);
  }

  function updatePeerStatus() {
    if (!currentPeer) return;
    const p = presence[currentPeer.id];
    const el = $('#peer-status');
    if (p?.online) el.textContent = 'online';
    else el.textContent = fmtLastSeen(p?.lastSeen || currentPeer.lastSeen);
  }

  async function sendText() {
    const input = $('#msg-input');
    const text = input.value.trim();
    if (!text || !currentPeer) return;
    input.value = '';
    autoSize(input);
    const aes = await getAes(currentPeer);
    const { iv, ciphertext } = await LinkoCrypto.encryptText(aes, text);
    LinkoApi.send({
      type: 'chat',
      to: currentPeer.id,
      typeMsg: 'text',
      iv, ciphertext
    });
  }

  async function sendMediaFile(file, typeHint) {
    if (!currentPeer || !file) return;
    const aes = await getAes(currentPeer);
    const buf = new Uint8Array(await file.arrayBuffer());
    const enc = await LinkoCrypto.encryptBytes(aes, buf);
    // Upload binary ciphertext (decoded from b64)
    const ctBytes = LinkoCrypto.unb64(enc.ciphertext);
    const up = await LinkoApi.uploadMedia(ctBytes.buffer);
    const meta = await LinkoCrypto.encryptJson(aes, {
      name: file.name, mime: file.type, size: file.size
    });
    const typeMsg = typeHint || (file.type.startsWith('image/') ? 'image' : file.type.startsWith('audio/') ? 'voice' : 'file');
    LinkoApi.send({
      type: 'chat',
      to: currentPeer.id,
      typeMsg,
      iv: enc.iv,
      ciphertext: 'media', // placeholder; body lives in media store
      mediaId: up.mediaId,
      meta: { iv: meta.iv, ciphertext: meta.ciphertext }
    });
  }

  // Patch decryptMessage for media path using subtle directly (already does)
  // Fix: for text, ciphertext is b64; for media, download binary and decrypt with iv.

  function autoSize(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(120, ta.scrollHeight) + 'px';
  }

  async function bootSession() {
    const token = LinkoStore.getToken();
    const user = LinkoStore.getUser();
    const privB64 = LinkoStore.getPriv();
    if (!token || !user || !privB64) {
      show('screen-auth');
      $('#server-url').value = LinkoStore.getServer();
      return;
    }
    me = user;
    privKey = await LinkoCrypto.importPrivate(privB64);
    try {
      const meRes = await LinkoApi.req('/api/me');
      me = meRes.user;
      LinkoStore.saveSession({ token, user: me, privateKeyPkcs8B64: privB64, publicKeySpkiB64: LinkoStore.getPub() });
    } catch (e) {
      LinkoStore.clearSession();
      show('screen-auth');
      toastError($('#auth-error'), 'Session expired — log in again');
      return;
    }
    $('#me-line').textContent = me.displayName + ' · ' + me.linkoId;
    $('#set-name').textContent = me.displayName;
    $('#set-phone').textContent = me.phone;
    $('#set-linko').textContent = me.linkoId;
    $('#set-server').value = LinkoStore.getServer();
    wireSocket();
    LinkoApi.connect();
    await refreshChats();
    show('screen-chats');
  }

  function wireSocket() {
    LinkoApi.on('hello', () => {});
    LinkoApi.on('chat', async (msg) => {
      const m = msg.message;
      if (!messageCache[m.chatId]) messageCache[m.chatId] = [];
      messageCache[m.chatId].push(m);
      if (currentPeer && (m.from === currentPeer.id || m.to === currentPeer.id)) {
        await renderMessages(m.chatId);
      }
      LinkoApi.send({ type: 'receipt', messageId: m.id, chatId: m.chatId, status: 'delivered' });
      refreshChats().catch(() => {});
    });
    LinkoApi.on('chat_ack', async (msg) => {
      const m = msg.message;
      if (!messageCache[m.chatId]) messageCache[m.chatId] = [];
      if (!messageCache[m.chatId].find(x => x.id === m.id)) messageCache[m.chatId].push(m);
      if (currentPeer) await renderMessages(m.chatId);
      refreshChats().catch(() => {});
    });
    LinkoApi.on('receipt', (msg) => {
      const arr = messageCache[msg.chatId] || [];
      const m = arr.find(x => x.id === msg.messageId);
      if (m) {
        if (msg.status === 'delivered') m.deliveredAt = msg.at;
        if (msg.status === 'read') m.readAt = msg.at;
        if (currentPeer) renderMessages(msg.chatId);
      }
    });
    LinkoApi.on('typing', (msg) => {
      if (!currentPeer || msg.from !== currentPeer.id) return;
      $('#typing-line').classList.remove('hidden');
      clearTimeout(typingTimers[msg.from]);
      typingTimers[msg.from] = setTimeout(() => $('#typing-line').classList.add('hidden'), 1500);
    });
    LinkoApi.on('presence', (msg) => {
      presence[msg.userId] = { online: msg.online, lastSeen: msg.lastSeen };
      updatePeerStatus();
    });
    LinkoApi.on('call_invite', (msg) => {
      showCallIncoming(msg.from, msg.callType);
    });
    LinkoApi.on('call_accept', async (msg) => {
      await LinkoCall.onAccepted();
      $('#call-state').textContent = 'Encrypted call connected';
      $('#btn-call-mute').classList.remove('hidden');
      if (LinkoCall.getType() === 'video') $('#btn-call-cam').classList.remove('hidden');
    });
    LinkoApi.on('call_reject', () => {
      LinkoCall.hangup(false);
      hideCall();
    });
    LinkoApi.on('call_hangup', () => {
      LinkoCall.hangup(false);
      hideCall();
    });
    LinkoApi.on('call_unavailable', () => {
      $('#call-state').textContent = 'User unavailable';
      setTimeout(() => { LinkoCall.hangup(false); hideCall(); }, 1200);
    });
    LinkoApi.on('webrtc_offer', async (msg) => {
      await LinkoCall.onOffer(msg.from, msg.sdp);
    });
    LinkoApi.on('webrtc_answer', async (msg) => {
      await LinkoCall.onAnswer(msg.sdp);
    });
    LinkoApi.on('webrtc_ice', async (msg) => {
      await LinkoCall.onIce(msg.candidate);
    });
  }

  function showCallIncoming(fromId, callType) {
    show('screen-call');
    $('#btn-call-accept').classList.remove('hidden');
    $('#btn-call-mute').classList.add('hidden');
    $('#btn-call-cam').classList.add('hidden');
    $('#call-state').textContent = (callType === 'video' ? 'Incoming video call' : 'Incoming voice call');
    LinkoApi.req('/api/users/' + fromId).then(r => {
      $('#call-peer').textContent = r.user.displayName;
      $('#screen-call').dataset.from = fromId;
      $('#screen-call').dataset.callType = callType || 'voice';
    }).catch(() => { $('#call-peer').textContent = 'Linko user'; });
  }

  function showCallOutgoing(peer, callType) {
    show('screen-call');
    $('#btn-call-accept').classList.add('hidden');
    $('#call-peer').textContent = peer.displayName;
    $('#call-state').textContent = 'Calling… (DTLS-SRTP)';
    $('#btn-call-mute').classList.add('hidden');
    $('#btn-call-cam').classList.add('hidden');
  }

  function hideCall() {
    if (currentPeer) show('screen-chat');
    else show('screen-chats');
    $('#remote-video').srcObject = null;
    $('#local-video').srcObject = null;
    $('#remote-audio').srcObject = null;
  }

  LinkoCall.on('local', (stream) => {
    $('#local-video').srcObject = stream;
    $('#local-video').style.display = LinkoCall.getType() === 'video' ? 'block' : 'none';
  });
  LinkoCall.on('remote', (stream) => {
    $('#remote-video').srcObject = stream;
    $('#remote-audio').srcObject = stream;
    $('#remote-video').style.display = LinkoCall.getType() === 'video' ? 'block' : 'none';
  });
  LinkoCall.on('state', (st) => {
    if (st === 'connected') $('#call-state').textContent = 'Encrypted · connected';
    else if (st === 'connecting') $('#call-state').textContent = 'Encrypting media…';
  });
  LinkoCall.on('ui', (u) => {
    if (u.phase === 'idle') hideCall();
  });

  // Auth UI
  $$('.tab').forEach(tab => {
    tab.onclick = () => {
      $$('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const login = tab.dataset.tab === 'login';
      $('#form-login').classList.toggle('hidden', !login);
      $('#form-register').classList.toggle('hidden', login);
      toastError($('#auth-error'), '');
    };
  });

  $('#btn-save-server').onclick = () => {
    const v = $('#server-url').value.trim();
    if (v) LinkoStore.setServer(v);
    toastError($('#auth-error'), 'Server saved: ' + LinkoStore.getServer());
    $('#auth-error').style.color = 'var(--accent)';
  };

  $('#form-login').onsubmit = async (e) => {
    e.preventDefault();
    toastError($('#auth-error'), '');
    const fd = new FormData(e.target);
    try {
      // Ensure we have local identity keys; login does not create them — must exist from register
      let priv = LinkoStore.getPriv();
      let pub = LinkoStore.getPub();
      if (!priv || !pub) {
        const id = await LinkoCrypto.generateIdentity();
        priv = id.privateKeyPkcs8B64;
        pub = id.publicKeySpkiB64;
      }
      const out = await LinkoApi.req('/api/login', {
        method: 'POST', auth: false,
        body: { phone: fd.get('phone'), pin: fd.get('pin') }
      });
      // Refresh server public key if we rotated locally
      if (pub !== out.user.publicKey) {
        await LinkoApi.req('/api/keys', {
          method: 'POST',
          body: { publicKey: pub },
          auth: false // need token — fix
        }).catch(() => {});
      }
      LinkoStore.saveSession({
        token: out.token,
        user: out.user,
        privateKeyPkcs8B64: priv,
        publicKeySpkiB64: pub
      });
      // If key mismatch, push new public key with auth
      if (pub && pub !== out.user.publicKey) {
        try {
          const updated = await LinkoApi.req('/api/keys', { method: 'POST', body: { publicKey: pub } });
          LinkoStore.saveSession({
            token: out.token, user: updated.user,
            privateKeyPkcs8B64: priv, publicKeySpkiB64: pub
          });
        } catch {}
      }
      await bootSession();
    } catch (err) {
      toastError($('#auth-error'), err.message);
      $('#auth-error').style.color = 'var(--danger)';
    }
  };

  $('#form-register').onsubmit = async (e) => {
    e.preventDefault();
    toastError($('#auth-error'), '');
    const fd = new FormData(e.target);
    try {
      const id = await LinkoCrypto.generateIdentity();
      const out = await LinkoApi.req('/api/register', {
        method: 'POST', auth: false,
        body: {
          displayName: fd.get('displayName'),
          phone: fd.get('phone'),
          pin: fd.get('pin'),
          publicKey: id.publicKeySpkiB64
        }
      });
      LinkoStore.saveSession({
        token: out.token,
        user: out.user,
        privateKeyPkcs8B64: id.privateKeyPkcs8B64,
        publicKeySpkiB64: id.publicKeySpkiB64
      });
      await bootSession();
    } catch (err) {
      toastError($('#auth-error'), err.message);
      $('#auth-error').style.color = 'var(--danger)';
    }
  };

  // Navigation
  $$('[data-back]').forEach(btn => {
    btn.onclick = () => {
      const t = btn.dataset.back;
      if (t === 'chats') { currentPeer = null; show('screen-chats'); refreshChats(); }
    };
  });
  $('#btn-search').onclick = () => { show('screen-search'); $('#search-input').value = ''; $('#search-results').innerHTML = ''; $('#search-input').focus(); };
  $('#btn-settings').onclick = () => show('screen-settings');
  $('#btn-set-server').onclick = () => {
    const v = $('#set-server').value.trim();
    if (v) {
      LinkoStore.setServer(v);
      LinkoApi.disconnect();
      LinkoApi.connect();
      alert('Reconnecting to ' + v);
    }
  };
  $('#btn-logout').onclick = () => {
    LinkoApi.disconnect();
    LinkoStore.clearSession();
    me = null; privKey = null; aesCache = {};
    show('screen-auth');
  };

  let searchTimer;
  $('#search-input').oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const q = $('#search-input').value.trim();
      if (q.length < 2) { $('#search-results').innerHTML = ''; return; }
      try {
        const data = await LinkoApi.req('/api/search?q=' + encodeURIComponent(q));
        const box = $('#search-results');
        box.innerHTML = '';
        for (const u of data.users || []) {
          const row = document.createElement('div');
          row.className = 'user-item';
          row.innerHTML = `<div class="avatar">${initials(u.displayName)}</div>
            <div class="meta"><div class="name">${escapeHtml(u.displayName)}</div>
            <div class="preview">${escapeHtml(u.phone)} · ${escapeHtml(u.linkoId)}</div></div>`;
          row.onclick = () => openChat(u);
          box.appendChild(row);
        }
        if (!(data.users || []).length) box.innerHTML = '<p class="empty">No users found</p>';
      } catch (e) {
        $('#search-results').innerHTML = `<p class="empty">${escapeHtml(e.message)}</p>`;
      }
    }, 250);
  };

  $('#btn-send').onclick = () => sendText();
  $('#msg-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
  });
  $('#msg-input').addEventListener('input', (e) => {
    autoSize(e.target);
    if (currentPeer) LinkoApi.send({ type: 'typing', to: currentPeer.id });
  });

  $('#btn-attach').onclick = () => $('#file-input').click();
  $('#file-input').onchange = async () => {
    const f = $('#file-input').files?.[0];
    $('#file-input').value = '';
    if (f) await sendMediaFile(f);
  };

  // Voice note: press/hold
  const vn = $('#btn-voice-note');
  async function startRec() {
    if (recording || !currentPeer) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordChunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = (e) => { if (e.data.size) recordChunks.push(e.data); };
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(recordChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        const file = new File([blob], 'voice.webm', { type: blob.type });
        await sendMediaFile(file, 'voice');
      };
      mediaRecorder.start();
      recording = true;
      $('.composer').classList.add('recording');
    } catch (e) {
      alert('Microphone permission needed for voice notes');
    }
  }
  function stopRec() {
    if (!recording) return;
    recording = false;
    $('.composer').classList.remove('recording');
    try { mediaRecorder.stop(); } catch {}
  }
  vn.addEventListener('mousedown', startRec);
  vn.addEventListener('mouseup', stopRec);
  vn.addEventListener('mouseleave', stopRec);
  vn.addEventListener('touchstart', (e) => { e.preventDefault(); startRec(); }, { passive: false });
  vn.addEventListener('touchend', stopRec);

  $('#btn-voice').onclick = async () => {
    if (!currentPeer) return;
    showCallOutgoing(currentPeer, 'voice');
    try { await LinkoCall.startOutgoing(currentPeer.id, 'voice'); }
    catch (e) { alert(e.message); hideCall(); }
  };
  $('#btn-video').onclick = async () => {
    if (!currentPeer) return;
    showCallOutgoing(currentPeer, 'video');
    try { await LinkoCall.startOutgoing(currentPeer.id, 'video'); }
    catch (e) { alert(e.message); hideCall(); }
  };
  $('#btn-call-accept').onclick = async () => {
    const from = $('#screen-call').dataset.from;
    const type = $('#screen-call').dataset.callType || 'voice';
    $('#btn-call-accept').classList.add('hidden');
    try {
      await LinkoCall.acceptIncoming(from, type);
      $('#call-state').textContent = 'Encrypted call connecting…';
      $('#btn-call-mute').classList.remove('hidden');
      if (type === 'video') $('#btn-call-cam').classList.remove('hidden');
    } catch (e) { alert(e.message); hideCall(); }
  };
  $('#btn-call-reject').onclick = () => {
    const from = $('#screen-call').dataset.from || LinkoCall.getPeer();
    if (LinkoCall.getPolarity() === 'in' && $('#btn-call-accept') && !$('#btn-call-accept').classList.contains('hidden')) {
      LinkoCall.reject(from);
    } else {
      LinkoCall.hangup(true);
    }
    hideCall();
  };
  $('#btn-call-mute').onclick = () => LinkoCall.toggleMute();
  $('#btn-call-cam').onclick = () => LinkoCall.toggleCam();

  // Boot
  show('screen-boot');
  $('#server-url').value = LinkoStore.getServer();
  setTimeout(() => bootSession().catch(err => {
    console.error(err);
    show('screen-auth');
    toastError($('#auth-error'), err.message);
  }), 400);
})();
