const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

/**
 * Derives a 32-byte key from ENCRYPTION_KEY env var (any length string) so
 * operators don't have to hand-generate a hex key — sha256 gives us exactly
 * the 32 bytes aes-256-gcm needs either way.
 */
function getKey() {
  const secret = process.env.ENCRYPTION_KEY || 'dev_encryption_key_change_me_in_prod';
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypts a plaintext string. Returns "iv:authTag:ciphertext" (all hex),
 * safe to store in a single String field.
 */
function encrypt(plainText) {
  if (plainText === null || plainText === undefined || plainText === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/** Reverses encrypt(). Returns null if given null/empty/malformed input. */
function decrypt(payload) {
  if (!payload) return null;
  const parts = payload.split(':');
  if (parts.length !== 3) return null;

  try {
    const [ivHex, authTagHex, dataHex] = parts;
    const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch (err) {
    return null; // corrupted payload or wrong key — treat as "no key configured"
  }
}

module.exports = { encrypt, decrypt };
