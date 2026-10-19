import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SpaceSyncSignatureMaterial {
  timestamp: string;
  syncId: string;
  rawBody: Buffer;
  secret: string;
}

export type SpaceSyncSignatureErrorCode =
  | 'space_sync_timestamp_invalid'
  | 'space_sync_timestamp_expired'
  | 'space_sync_signature_invalid';

export class SpaceSyncSignatureError extends Error {
  constructor(readonly code: SpaceSyncSignatureErrorCode) {
    super(code);
  }
}

/** Signature covers the timestamp and syncId headers plus the exact raw body bytes, in that order. */
export function computeSpaceSyncSignature(material: SpaceSyncSignatureMaterial): string {
  return createHmac('sha256', material.secret)
    .update(`${material.timestamp}.${material.syncId}.`, 'utf8')
    .update(material.rawBody)
    .digest('hex');
}

export function verifySpaceSyncSignature(input: SpaceSyncSignatureMaterial & {
  signature: string;
  nowMs: number;
  windowSeconds: number;
}): void {
  if (!/^\d+$/u.test(input.timestamp)) {
    throw new SpaceSyncSignatureError('space_sync_timestamp_invalid');
  }
  const skewSeconds = Math.abs(input.nowMs / 1_000 - Number(input.timestamp));
  if (skewSeconds > input.windowSeconds) {
    throw new SpaceSyncSignatureError('space_sync_timestamp_expired');
  }
  const expected = computeSpaceSyncSignature(input);
  if (!safeEqualHex(expected, input.signature)) {
    throw new SpaceSyncSignatureError('space_sync_signature_invalid');
  }
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]+$/iu.test(right)) return false;
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
