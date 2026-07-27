import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const encryptedTokenPrefix = 'v1';
const ivByteLength = 12;
const authTagByteLength = 16;

export class TokenCryptoError extends Error {
  constructor() {
    super('token crypto operation failed');
    this.name = 'TokenCryptoError';
  }
}

export class TokenCrypto {
  readonly #key: Buffer;

  constructor(key: Buffer | string) {
    const keyBytes = Buffer.isBuffer(key) ? key : Buffer.from(key, 'base64');
    if (keyBytes.length !== 32) {
      throw new TokenCryptoError();
    }
    this.#key = keyBytes;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(ivByteLength);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final()
    ]);
    const tag = cipher.getAuthTag();
    return [
      encryptedTokenPrefix,
      iv.toString('base64url'),
      tag.toString('base64url'),
      encrypted.toString('base64url')
    ].join('.');
  }

  decrypt(ciphertext: string): string {
    const [version, ivPart, tagPart, encryptedPart] = ciphertext.split('.');
    if (
      version !== encryptedTokenPrefix ||
      !ivPart ||
      !tagPart ||
      !encryptedPart
    ) {
      throw new TokenCryptoError();
    }
    try {
      const iv = Buffer.from(ivPart, 'base64url');
      const tag = Buffer.from(tagPart, 'base64url');
      const encrypted = Buffer.from(encryptedPart, 'base64url');
      if (iv.length !== ivByteLength || tag.length !== authTagByteLength) {
        throw new TokenCryptoError();
      }
      const decipher = createDecipheriv('aes-256-gcm', this.#key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(encrypted),
        decipher.final()
      ]).toString('utf8');
    } catch (error) {
      if (error instanceof TokenCryptoError) {
        throw error;
      }
      throw new TokenCryptoError();
    }
  }
}
