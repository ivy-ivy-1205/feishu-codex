import { describe, expect, it } from 'vitest';
import {
  computeSpaceSyncSignature,
  verifySpaceSyncSignature,
  SpaceSyncSignatureError
} from '../src/services/space-sync-signature.js';

const secret = 'test-only-space-sync-secret';
const rawBody = Buffer.from(JSON.stringify({ hello: 'world' }));
const timestamp = '1700000000';
const syncId = 'sync_1';

describe('verifySpaceSyncSignature', () => {
  it('accepts a correctly computed signature within the time window', () => {
    const signature = computeSpaceSyncSignature({ timestamp, syncId, rawBody, secret });
    expect(() => verifySpaceSyncSignature({
      timestamp, syncId, rawBody, secret, signature,
      nowMs: 1_700_000_000_000 + 10_000, windowSeconds: 300
    })).not.toThrow();
  });

  it('rejects a non-numeric timestamp', () => {
    expect(() => verifySpaceSyncSignature({
      timestamp: 'not-a-number', syncId, rawBody, secret, signature: 'ab',
      nowMs: 1_700_000_000_000, windowSeconds: 300
    })).toThrowError(SpaceSyncSignatureError);
  });

  it('rejects a timestamp outside the configured window', () => {
    const signature = computeSpaceSyncSignature({ timestamp, syncId, rawBody, secret });
    expect(() => verifySpaceSyncSignature({
      timestamp, syncId, rawBody, secret, signature,
      nowMs: 1_700_000_000_000 + 10 * 60 * 1_000, windowSeconds: 300
    })).toThrowError(SpaceSyncSignatureError);
  });

  it('rejects a signature computed with the wrong secret', () => {
    const signature = computeSpaceSyncSignature({ timestamp, syncId, rawBody, secret: 'wrong-secret' });
    expect(() => verifySpaceSyncSignature({
      timestamp, syncId, rawBody, secret, signature,
      nowMs: 1_700_000_000_000, windowSeconds: 300
    })).toThrowError(SpaceSyncSignatureError);
  });

  it('rejects a signature computed over a different body (tamper detection)', () => {
    const signature = computeSpaceSyncSignature({ timestamp, syncId, rawBody, secret });
    const tamperedBody = Buffer.from(JSON.stringify({ hello: 'tampered' }));
    expect(() => verifySpaceSyncSignature({
      timestamp, syncId, rawBody: tamperedBody, secret, signature,
      nowMs: 1_700_000_000_000, windowSeconds: 300
    })).toThrowError(SpaceSyncSignatureError);
  });

  it('rejects a signature computed over a different syncId (replay across syncId)', () => {
    const signature = computeSpaceSyncSignature({ timestamp, syncId, rawBody, secret });
    expect(() => verifySpaceSyncSignature({
      timestamp, syncId: 'sync_2', rawBody, secret, signature,
      nowMs: 1_700_000_000_000, windowSeconds: 300
    })).toThrowError(SpaceSyncSignatureError);
  });

  it('rejects a non-hex signature without throwing an unrelated Buffer error', () => {
    expect(() => verifySpaceSyncSignature({
      timestamp, syncId, rawBody, secret, signature: 'not-hex!!',
      nowMs: 1_700_000_000_000, windowSeconds: 300
    })).toThrowError(SpaceSyncSignatureError);
  });
});
