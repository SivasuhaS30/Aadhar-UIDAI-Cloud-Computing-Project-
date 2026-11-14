const crypto = require('crypto');

/**
 * Generates a cryptographically random 6-digit OTP string.
 */
function generateOtp() {
  return crypto.randomInt(100000, 1000000).toString();
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function computeHmac(secret, payload) {
  return crypto.createHmac('sha256', secret).update(String(payload)).digest('hex');
}

/**
 * Constant-time comparison of two hex strings to prevent timing side-channels.
 */
function safeEqualHex(hexA, hexB) {
  if (typeof hexA !== 'string' || typeof hexB !== 'string') return false;
  if (!/^[0-9a-fA-F]+$/.test(hexA) || !/^[0-9a-fA-F]+$/.test(hexB)) return false;
  if (hexA.length !== hexB.length) return false;

  const bufA = Buffer.from(hexA, 'hex');
  const bufB = Buffer.from(hexB, 'hex');
  if (bufA.length !== bufB.length) return false;

  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Encrypts a JSON-serializable assertion using AES-256-GCM with a fresh
 * cryptographically random 96-bit (12-byte) IV per transaction, addressing
 * the legacy timestamp-based IV reuse vulnerability (Tiwari et al., Sec. 6.4).
 */
function encryptAesGcm(keyBuffer, payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, iv);
  const plaintext = JSON.stringify(payload);

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

function decryptAesGcm(keyBuffer, encryptedEnvelope) {
  const { iv, authTag, ciphertext } = encryptedEnvelope;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    keyBuffer,
    Buffer.from(iv, 'hex')
  );
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'hex')),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString('utf8'));
}

module.exports = {
  generateOtp,
  sha256Hex,
  computeHmac,
  safeEqualHex,
  encryptAesGcm,
  decryptAesGcm,
};
