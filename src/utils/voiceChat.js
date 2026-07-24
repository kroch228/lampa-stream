// src/utils/voiceChat.js — voice chat disabled.
// The previous version implemented either WebRTC+ICE or an HTTP relay for
// Opus audio. Both required configuration that proved fragile in practice
// (STUN/TURN for WebRTC, persistent storage for the relay). The microphone
// UI was removed from WatchTogetherPage and this module is kept as a stub so
// any leftover imports resolve without throwing.

export class VoiceChat {
  constructor(_opts) {
    this._started = false;
    this._closed = true;
  }
  get myPeerId() { return null; }
  async start() { throw new Error("voice chat: disabled"); }
  async stop() {}
  setMute() {}
  setPeers() {}
  resumePlayback() {}
}

export default VoiceChat;