import crypto from 'node:crypto';

export interface EncryptedPayload {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

/**
 * Encrypts an arbitrary object using AES-256-GCM envelope encryption per ADR 0002.
 * Generates a unique 96-bit IV and produces a 128-bit authentication tag.
 */
export function encryptPayload(payload: unknown, masterKey: Buffer): EncryptedPayload {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);

  const jsonString = JSON.stringify(payload);
  const ciphertext = Buffer.concat([
    cipher.update(jsonString, 'utf-8'),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  return { ciphertext, iv, tag };
}

/**
 * Decrypts an AES-256-GCM encrypted payload and verifies its 128-bit authentication tag.
 * Throws an error if ciphertext or tag was tampered with or corrupted on disk.
 */
export function decryptPayload<T = unknown>(
  ciphertext: Buffer,
  iv: Buffer,
  tag: Buffer,
  masterKey: Buffer
): T {
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return JSON.parse(decrypted.toString('utf-8')) as T;
}
