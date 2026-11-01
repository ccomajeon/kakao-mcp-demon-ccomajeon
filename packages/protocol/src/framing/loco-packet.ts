import { BSON } from 'bson';
import { LocoError } from '../errors/loco-error.js';

export interface LocoHeader {
  id: number;
  status: number;
  method: string;
  dataType: number;
  bodyLength: number;
}
export interface LocoPacket<T = Record<string, unknown>> {
  header: LocoHeader;
  data: T;
}
export const LOCO_HEADER_SIZE = 22;

function unsigned(value: number, max: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new LocoError('INVALID_ARGUMENT', `LOCO ${field} must be an unsigned integer <= ${max}`);
  }
}

export function encodeLocoPacket<T extends Record<string, unknown>>(
  id: number, status: number, method: string, data: T, dataType = 0
): Uint8Array {
  unsigned(id, 0xffffffff, 'id');
  // Server failures can be signed int16 values; callers also pass raw uint16 codes.
  if (!Number.isInteger(status) || status < -0x8000 || status > 0xffff) {
    throw new LocoError('INVALID_ARGUMENT', 'LOCO status must fit a signed or unsigned 16-bit integer');
  }
  unsigned(dataType, 0xff, 'dataType');
  if (Buffer.byteLength(method, 'utf8') > 11) {
    throw new LocoError('INVALID_ARGUMENT', `LOCO method exceeds 11 bytes: ${method}`);
  }
  if (!/^[\x20-\x7e]*$/.test(method)) {
    throw new LocoError('INVALID_ARGUMENT', 'LOCO method must contain printable ASCII bytes');
  }
  const body = BSON.serialize(data);
  const packet = Buffer.alloc(LOCO_HEADER_SIZE + body.length);
  packet.writeUInt32LE(id, 0);
  packet.writeUInt16LE(status & 0xffff, 4);
  packet.write(method, 6, 11, 'ascii');
  packet.writeUInt8(dataType, 17);
  packet.writeUInt32LE(body.length, 18);
  packet.set(body, LOCO_HEADER_SIZE);
  return new Uint8Array(packet.buffer, packet.byteOffset, packet.byteLength);
}

export function decodeLocoHeader(bytes: Uint8Array): LocoHeader {
  if (bytes.byteLength < LOCO_HEADER_SIZE) {
    throw new LocoError('MALFORMED', `Buffer too short for LOCO header: expected ${LOCO_HEADER_SIZE}, got ${bytes.byteLength}`);
  }
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, LOCO_HEADER_SIZE);
  const methodField = header.subarray(6, 17);
  const zero = methodField.indexOf(0);
  const method = methodField.subarray(0, zero < 0 ? 11 : zero).toString('latin1');
  return {
    id: header.readUInt32LE(0), status: header.readUInt16LE(4), method,
    dataType: header.readUInt8(17), bodyLength: header.readUInt32LE(18)
  };
}

export function decodeLocoPacket<T = Record<string, unknown>>(bytes: Uint8Array): LocoPacket<T> {
  const header = decodeLocoHeader(bytes);
  const end = LOCO_HEADER_SIZE + header.bodyLength;
  if (end > bytes.byteLength) {
    throw new LocoError('MALFORMED', `Incomplete LOCO body: expected ${header.bodyLength}, got ${bytes.byteLength - LOCO_HEADER_SIZE}`);
  }
  const body = bytes.subarray(LOCO_HEADER_SIZE, end);
  if (header.dataType !== 0) return { header, data: body as T };
  try {
    return { header, data: BSON.deserialize(body) as T };
  } catch (cause) {
    throw new LocoError('MALFORMED', 'Invalid BSON in LOCO packet', { cause, command: header.method });
  }
}
