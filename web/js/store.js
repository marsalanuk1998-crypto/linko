'use strict';
/** Local persistence for session + private key (device at-rest). */
const LinkoStore = (() => {
  const K = {
    server: 'linko.server',
    token: 'linko.token',
    user: 'linko.user',
    priv: 'linko.priv',
    pub: 'linko.pub'
  };

  function getServer() {
    return localStorage.getItem(K.server) || defaultServer();
  }
  function defaultServer() {
    return 'https://linko-018a.onbelmo.uk';
  }
  function setServer(url) {
    localStorage.setItem(K.server, String(url || '').replace(/\/$/, ''));
  }
  function saveSession({ token, user, privateKeyPkcs8B64, publicKeySpkiB64 }) {
    localStorage.setItem(K.token, token);
    localStorage.setItem(K.user, JSON.stringify(user));
    if (privateKeyPkcs8B64) localStorage.setItem(K.priv, privateKeyPkcs8B64);
    if (publicKeySpkiB64) localStorage.setItem(K.pub, publicKeySpkiB64);
  }
  function clearSession() {
    localStorage.removeItem(K.token);
    localStorage.removeItem(K.user);
    // keep keys? wipe for logout safety
    localStorage.removeItem(K.priv);
    localStorage.removeItem(K.pub);
  }
  function getToken() { return localStorage.getItem(K.token); }
  function getUser() {
    try { return JSON.parse(localStorage.getItem(K.user) || 'null'); } catch { return null; }
  }
  function getPriv() { return localStorage.getItem(K.priv); }
  function getPub() { return localStorage.getItem(K.pub); }

  return { getServer, setServer, defaultServer, saveSession, clearSession, getToken, getUser, getPriv, getPub };
})();
