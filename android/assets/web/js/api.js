'use strict';
const LinkoApi = (() => {
  let ws = null;
  let handlers = {};
  let reconnectTimer = null;
  let intentionalClose = false;

  function base() { return LinkoStore.getServer().replace(/\/$/, ''); }

  async function req(path, { method = 'GET', body, auth = true } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth) {
      const t = LinkoStore.getToken();
      if (t) headers.Authorization = 'Bearer ' + t;
    }
    const res = await fetch(base() + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  async function uploadMedia(arrayBuffer) {
    const t = LinkoStore.getToken();
    const res = await fetch(base() + '/api/media', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + t },
      body: arrayBuffer
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    return data;
  }

  async function downloadMedia(mediaId) {
    const t = LinkoStore.getToken();
    const res = await fetch(base() + '/api/media/' + mediaId, {
      headers: { Authorization: 'Bearer ' + t }
    });
    if (!res.ok) throw new Error('Media download failed');
    return new Uint8Array(await res.arrayBuffer());
  }

  function on(type, fn) {
    if (!handlers[type]) handlers[type] = [];
    handlers[type].push(fn);
  }
  function emit(msg) {
    const list = handlers[msg.type] || [];
    for (const fn of list) try { fn(msg); } catch (e) { console.error(e); }
    const any = handlers['*'] || [];
    for (const fn of any) try { fn(msg); } catch (e) { console.error(e); }
  }

  function connect() {
    intentionalClose = false;
    const token = LinkoStore.getToken();
    if (!token) return;
    const u = base().replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(token);
    if (ws) { try { ws.close(); } catch {} }
    ws = new WebSocket(u);
    ws.onopen = () => emit({ type: '_open' });
    ws.onclose = () => {
      emit({ type: '_close' });
      if (!intentionalClose) {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 2000);
      }
    };
    ws.onerror = () => {};
    ws.onmessage = (ev) => {
      try { emit(JSON.parse(ev.data)); } catch {}
    };
  }

  function disconnect() {
    intentionalClose = true;
    clearTimeout(reconnectTimer);
    if (ws) try { ws.close(); } catch {}
    ws = null;
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  return { req, uploadMedia, downloadMedia, connect, disconnect, send, on };
})();
