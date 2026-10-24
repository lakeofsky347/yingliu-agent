/** F01/R01: remove WebRTC constructors from a frame before untrusted scene code runs. Self-contained (serialized into other worlds). */
export function lockdownWebRTC(): void {
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceCandidate', 'RTCSessionDescription', 'RTCRtpSender', 'RTCRtpReceiver', 'RTCRtpTransceiver']) {
    try { Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false }); } catch { /* already locked */ }
  }
}
export const WEBRTC_LOCKDOWN_SCRIPT = '(' + lockdownWebRTC.toString() + ')();';
