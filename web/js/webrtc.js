'use strict';
/**
 * Linko calls — WebRTC with mandatory DTLS-SRTP (browser default).
 * Signaling (offer/answer/ICE) goes over authenticated WebSocket.
 * Audio/video media is encrypted peer-to-peer; the Linko server never receives media plaintext.
 */
const LinkoCall = (() => {
  // Public STUN only (free). TURN would need a host; without TURN some NATs fail — documented limit.
  const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };

  let pc = null;
  let localStream = null;
  let remoteStream = null;
  let peerId = null;
  let callType = 'voice'; // voice | video
  let polarity = null; // out | in
  let listeners = {};

  function on(ev, fn) { listeners[ev] = fn; }
  function fire(ev, data) { if (listeners[ev]) listeners[ev](data); }

  async function ensureMedia(video) {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: video ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } : false
    });
    return localStream;
  }

  function wirePc() {
    pc = new RTCPeerConnection(ICE);
    remoteStream = new MediaStream();
    pc.ontrack = (ev) => {
      ev.streams[0]?.getTracks().forEach(t => remoteStream.addTrack(t));
      if (!ev.streams[0]) remoteStream.addTrack(ev.track);
      fire('remote', remoteStream);
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate && peerId) {
        LinkoApi.send({
          type: 'webrtc_ice',
          to: peerId,
          candidate: ev.candidate
        });
      }
    };
    pc.onconnectionstatechange = () => {
      fire('state', pc.connectionState);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
        // soft: UI may hang up
      }
    };
    if (localStream) {
      localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    }
  }

  async function startOutgoing(toUserId, type) {
    await hangup(false);
    peerId = toUserId;
    callType = type;
    polarity = 'out';
    await ensureMedia(type === 'video');
    fire('local', localStream);
    wirePc();
    LinkoApi.send({ type: 'call_invite', to: peerId, callType: type });
    fire('ui', { phase: 'outing', peerId, callType });
  }

  async function acceptIncoming(fromUserId, type) {
    peerId = fromUserId;
    callType = type || 'voice';
    polarity = 'in';
    await ensureMedia(callType === 'video');
    fire('local', localStream);
    wirePc();
    LinkoApi.send({ type: 'call_accept', to: peerId, callType });
    fire('ui', { phase: 'active', peerId, callType });
  }

  async function onAccepted() {
    // We are caller; create offer after peer accepted
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: callType === 'video' });
    await pc.setLocalDescription(offer);
    LinkoApi.send({ type: 'webrtc_offer', to: peerId, sdp: offer });
  }

  async function onOffer(from, sdp) {
    if (!pc) return;
    await pc.setRemoteDescription(sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    LinkoApi.send({ type: 'webrtc_answer', to: from, sdp: answer });
    fire('ui', { phase: 'active', peerId: from, callType });
  }

  async function onAnswer(sdp) {
    if (!pc) return;
    await pc.setRemoteDescription(sdp);
    fire('ui', { phase: 'active', peerId, callType });
  }

  async function onIce(candidate) {
    if (!pc || !candidate) return;
    try { await pc.addIceCandidate(candidate); } catch (e) { console.warn(e); }
  }

  function reject(to) {
    LinkoApi.send({ type: 'call_reject', to: to || peerId });
    hangup(false);
  }

  async function hangup(notify = true) {
    if (notify && peerId) LinkoApi.send({ type: 'call_hangup', to: peerId });
    if (pc) { try { pc.close(); } catch {} }
    pc = null;
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }
    remoteStream = null;
    peerId = null;
    polarity = null;
    fire('ui', { phase: 'idle' });
  }

  function toggleMute() {
    if (!localStream) return false;
    const t = localStream.getAudioTracks()[0];
    if (!t) return false;
    t.enabled = !t.enabled;
    return !t.enabled;
  }

  function toggleCam() {
    if (!localStream) return false;
    const t = localStream.getVideoTracks()[0];
    if (!t) return false;
    t.enabled = !t.enabled;
    return !t.enabled;
  }

  function getPeer() { return peerId; }
  function getType() { return callType; }
  function getPolarity() { return polarity; }

  // DTLS-SRTP note for diagnostics
  async function securityNote() {
    if (!pc) return null;
    const stats = await pc.getStats();
    let srtp = false;
    stats.forEach(r => {
      if (r.type === 'transport' && r.dtlsState === 'connected') srtp = true;
    });
    return { dtlsConnected: srtp };
  }

  return {
    on, startOutgoing, acceptIncoming, onAccepted, onOffer, onAnswer, onIce,
    reject, hangup, toggleMute, toggleCam, getPeer, getType, getPolarity, securityNote
  };
})();
