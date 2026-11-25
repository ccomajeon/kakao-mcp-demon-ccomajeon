import { decryptLocoV2Frame } from '../crypto/loco-crypto.js';
import { LOCO_HEADER_SIZE } from '../framing/loco-packet.js';
import { LocoError } from '../errors/loco-error.js';

/**
 * Largest LocoV2SL frame payload (IV + ciphertext + tag) accepted from a server. The length
 * prefix arrives before anything is authenticated, so it must be bounded: the server splits large
 * responses (LOGINLIST, chat log pages) into many GCM frames, so a single frame stays far below
 * this, while a forged prefix can no longer make the reader buffer gigabytes.
 */
export const MAX_LOCO_FRAME_BYTES = 16 * 1024 * 1024;
/**
 * Largest LOCO packet body accepted. A LOGINLIST for an account with many rooms or a chat log
 * page is at most a few MiB; this leaves ample headroom while bounding the reassembly buffer.
 */
export const MAX_LOCO_BODY_BYTES = 32 * 1024 * 1024;
/** A frame payload holds at least the 12-byte IV and the 16-byte GCM tag. */
export const MIN_LOCO_FRAME_BYTES = 28;

/**
 * A FIFO of received bytes that copies each byte a bounded number of times: chunks are only
 * merged once enough bytes are buffered to read a header or take a whole frame, instead of
 * re-concatenating the whole buffer on every socket read.
 */
export class ByteQueue {
  private chunks: Buffer[] = [];
  private size = 0;

  get length(): number {
    return this.size;
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    this.size += chunk.length;
  }

  /** The first `n` bytes without consuming them, or null when fewer are buffered. */
  peek(n: number): Buffer | null {
    if (this.size < n) return null;
    this.coalesce(n);
    return this.chunks[0].subarray(0, n);
  }

  /** Remove and return the first `n` bytes, or null when fewer are buffered. */
  take(n: number): Buffer | null {
    if (this.size < n) return null;
    if (n === 0) return Buffer.alloc(0);
    this.coalesce(n);
    const first = this.chunks[0];
    const out = first.subarray(0, n);
    if (first.length === n) this.chunks.shift();
    else this.chunks[0] = first.subarray(n);
    this.size -= n;
    return out;
  }

  clear(): void {
    this.chunks = [];
    this.size = 0;
  }

  /** Make the first chunk at least `n` bytes long (requires size >= n). */
  private coalesce(n: number): void {
    if (this.chunks[0].length >= n) return;
    let total = 0;
    let count = 0;
    while (total < n) total += this.chunks[count++].length;
    this.chunks.splice(0, count, Buffer.concat(this.chunks.slice(0, count), total));
  }
}

/** Validate a frame length prefix before waiting for (and buffering) that many bytes. */
export function checkLocoFrameLength(frameLen: number, max = MAX_LOCO_FRAME_BYTES): void {
  if (frameLen < MIN_LOCO_FRAME_BYTES) throw new LocoError('MALFORMED', 'LocoV2 frame is shorter than its IV and tag');
  if (frameLen > max) throw new LocoError('MALFORMED', 'LocoV2 frame exceeds the size limit');
}

/** Validate a LOCO body length before waiting for (and buffering) that many bytes. */
export function checkLocoBodyLength(bodyLen: number): void {
  if (bodyLen > MAX_LOCO_BODY_BYTES) throw new LocoError('MALFORMED', 'LOCO packet body exceeds the size limit');
}

/**
 * Take the next complete plaintext LOCO packet (header + body) from `plain`, or null when it is
 * not complete yet. Throws a MALFORMED LocoError when the announced body is over the limit.
 */
export function takeLocoPacket(plain: ByteQueue): Buffer | null {
  const header = plain.peek(LOCO_HEADER_SIZE);
  if (!header) return null;
  const bodyLen = header.readUInt32LE(18);
  checkLocoBodyLength(bodyLen);
  return plain.take(LOCO_HEADER_SIZE + bodyLen);
}

/**
 * Turns a LocoV2SL ciphertext stream into complete LOCO packets. A large LOCO response is split
 * by the server across several GCM frames, each `[4-byte len][12-byte IV][ciphertext][16-byte tag]`;
 * their plaintexts concatenate to form the LOCO packet byte stream.
 *
 * `push` throws a MALFORMED LocoError on a frame that is too short, too
 * long, fails authentication, or announces an oversized packet. The stream cannot be resynchronised
 * after that, so the caller must drop the connection.
 */
export class LocoStreamDecoder {
  private readonly cipher = new ByteQueue();
  private readonly plain = new ByteQueue();
  private readonly aesKey: Uint8Array;

  constructor(aesKey: Uint8Array) {
    this.aesKey = aesKey;
  }

  /** Bytes received but not yet returned as packets. */
  get bufferedBytes(): number {
    return this.cipher.length + this.plain.length;
  }

  /** Feed received bytes; returns every LOCO packet completed by them, in order. */
  push(chunk: Uint8Array): Buffer[] {
    this.cipher.push(chunk);
    for (;;) {
      const prefix = this.cipher.peek(4);
      if (!prefix) break;
      const frameLen = prefix.readUInt32LE(0);
      checkLocoFrameLength(frameLen);
      const frame = this.cipher.take(4 + frameLen);
      if (!frame) break;
      let plain: Uint8Array;
      try {
        plain = decryptLocoV2Frame(frame.subarray(4), this.aesKey);
      } catch (cause) {
        throw cause instanceof LocoError ? cause : new LocoError('MALFORMED', 'LocoV2 frame failed authentication', { cause });
      }
      this.plain.push(plain);
    }
    const packets: Buffer[] = [];
    for (let packet = takeLocoPacket(this.plain); packet; packet = takeLocoPacket(this.plain)) packets.push(packet);
    return packets;
  }
}
