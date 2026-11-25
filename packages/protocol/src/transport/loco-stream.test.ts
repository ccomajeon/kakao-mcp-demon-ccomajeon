import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { BSON } from 'bson';
import { ByteQueue, LocoStreamDecoder, MAX_LOCO_BODY_BYTES, MAX_LOCO_FRAME_BYTES, takeLocoPacket } from './loco-stream.js';
import { LocoSession } from './loco-session.js';
import { LocoClient } from './loco-client.js';
import { uploadMediaToTrailer } from './trailer-client.js';
import { LocoError } from '../errors/loco-error.js';
import { encodeLocoPacket, decodeLocoPacket, LOCO_HEADER_SIZE } from '../framing/loco-packet.js';
import { createLocoV2Handshake, encryptLocoV2Frame } from '../crypto/loco-crypto.js';

const isLoco = (code: string) => (e: unknown) => e instanceof LocoError && e.code === code;
const frameOf = (key: Uint8Array, plain: Uint8Array) => Buffer.from(encryptLocoV2Frame(plain, key));
const lengthPrefix = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };

/** Malformed byte streams a hostile or broken peer could send in place of a valid frame. */
const malformed: Record<string, Buffer> = {
  'a frame shorter than its IV and tag': Buffer.from([5, 0, 0, 0, 1, 2, 3, 4, 5]),
  'a zero-length frame': lengthPrefix(0),
  'a frame that fails authentication': Buffer.concat([lengthPrefix(40), Buffer.alloc(40, 7)]),
  'an oversized length prefix': Buffer.concat([lengthPrefix(0xfffffff0), Buffer.alloc(8)])
};

test('ByteQueue returns frames split across many reads and keeps the remainder', () => {
  const q = new ByteQueue();
  const data = Buffer.from(Array.from({ length: 50 }, (_, i) => i));
  for (let i = 0; i < data.length; i += 3) q.push(data.subarray(i, i + 3));
  assert.equal(q.length, 50);
  assert.deepEqual(q.peek(5), data.subarray(0, 5));
  assert.equal(q.take(60), null);
  assert.deepEqual(q.take(20), data.subarray(0, 20));
  assert.deepEqual(q.take(30), data.subarray(20));
  assert.equal(q.length, 0);
  assert.equal(q.peek(1), null);
});

test('the stream decoder reassembles a packet split over frames and reads, and rejects malformed streams', () => {
  const { aesKey } = createLocoV2Handshake();
  const packet = Buffer.from(encodeLocoPacket(7, 0, 'LOGINLIST', { status: 0, chatDatas: [{ c: 1 }] }));
  const wire = Buffer.concat([frameOf(aesKey, packet.subarray(0, 10)), frameOf(aesKey, packet.subarray(10)), frameOf(aesKey, packet)]);
  const decoder = new LocoStreamDecoder(aesKey);
  const out: Buffer[] = [];
  for (let i = 0; i < wire.length; i += 7) out.push(...decoder.push(wire.subarray(i, i + 7)));
  assert.equal(out.length, 2);
  for (const p of out) assert.equal(decodeLocoPacket(p).header.method, 'LOGINLIST');
  assert.equal(decoder.bufferedBytes, 0);

  for (const [name, bytes] of Object.entries(malformed)) {
    assert.throws(() => new LocoStreamDecoder(aesKey).push(bytes), isLoco('MALFORMED'), name);
  }
  // An oversized LOCO body is refused as soon as its header is decrypted, before buffering the body.
  const header = Buffer.alloc(LOCO_HEADER_SIZE);
  header.writeUInt32LE(MAX_LOCO_BODY_BYTES + 1, 18);
  assert.throws(() => new LocoStreamDecoder(aesKey).push(frameOf(aesKey, header)), isLoco('MALFORMED'));
  assert.throws(() => new LocoStreamDecoder(aesKey).push(lengthPrefix(MAX_LOCO_FRAME_BYTES + 1)), isLoco('MALFORMED'));
});

/** A loopback carriage that answers the first read with `reply(key)`; the test reads the session key in-process. */
async function hostileCarriage(reply: () => Buffer, after?: (socket: net.Socket) => void, allowHalfOpen = false) {
  const sockets: net.Socket[] = [];
  let closed = 0;
  const server = net.createServer({ allowHalfOpen }, (socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
    socket.on('close', () => { closed++; });
    socket.once('data', () => { socket.write(reply()); after?.(socket); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: (server.address() as net.AddressInfo).port,
    get closed() { return closed; },
    get sockets() { return sockets; },
    stop: () => { for (const s of sockets) s.destroy(); server.close(); }
  };
}

const waitFor = (cond: () => boolean, ms: number, what: string) => new Promise<void>((resolve, reject) => {
  const started = Date.now();
  const tick = () => (cond() ? resolve() : Date.now() - started > ms ? reject(new Error(`${what} did not happen within ${ms}ms`)) : setTimeout(tick, 5));
  tick();
});

for (const [name, bytes] of Object.entries(malformed)) {
  test(`${name} during login fails the connect cleanly and drops the socket instead of ending the process`, async (t) => {
    const carriage = await hostileCarriage(() => bytes);
    const session = new LocoSession({ connectTimeoutMs: 5000, requestTimeoutMs: 5000 });
    t.after(() => { session.close(); carriage.stop(); });
    const started = Date.now();
    await assert.rejects(session.connect('127.0.0.1', carriage.port, '1', 'fixture-token', 'fixture-device'), isLoco('CLOSED'));
    assert.ok(Date.now() - started < 2000, 'fails at once, not at a timeout');
    assert.equal(session.isClosed, true);
    await waitFor(() => carriage.closed > 0, 2000, 'socket drop');
  });
}

test('garbage after a valid login closes the live session, rejects pending requests and reports the error', async (t) => {
  let session!: LocoSession;
  const key = () => (session as any).aesKey as Uint8Array;
  const carriage = await hostileCarriage(() => frameOf(key(), encodeLocoPacket(1, 0, 'LOGINLIST', { status: 0, revision: 0, chatDatas: [] })));
  session = new LocoSession({ requestTimeoutMs: 5000 });
  t.after(() => { session.close(); carriage.stop(); });
  const errors: Error[] = [];
  session.on('error', (e) => errors.push(e));
  const login = await session.connect('127.0.0.1', carriage.port, '1', 'fixture-token', 'fixture-device');
  assert.equal(login.status, 0);
  const closed = new Promise<void>((resolve) => session.once('close', () => resolve()));
  const pending = session.request('PING', {});
  // The carriage answers with a frame that fails authentication.
  carriage.sockets[0].write(Buffer.concat([lengthPrefix(64), Buffer.alloc(64, 1)]));
  await assert.rejects(pending, (e: unknown) => isLoco('CLOSED')(e) && isLoco('MALFORMED')((e as Error).cause));
  await closed;
  assert.equal(session.isClosed, true);
  assert.equal(errors.length, 1);
  await assert.rejects(session.sendText('1', 'fixture'), isLoco('NOT_CONNECTED'));
  await waitFor(() => carriage.closed > 0, 2000, 'socket drop');
});

test('close() does not leave a half-open socket buffering data from a peer that never closes', async (t) => {
  let session!: LocoSession;
  const key = () => (session as any).aesKey as Uint8Array;
  // The peer keeps its side open and never answers the FIN.
  const carriage = await hostileCarriage(() => frameOf(key(), encodeLocoPacket(1, 0, 'LOGINLIST', { status: 0, revision: 0, chatDatas: [] })), undefined, true);
  session = new LocoSession({ requestTimeoutMs: 5000 });
  t.after(() => carriage.stop());
  await session.connect('127.0.0.1', carriage.port, '1', 'fixture-token', 'fixture-device');
  const socket = (session as any).socket as net.Socket;
  session.close();
  assert.equal(socket.destroyed, false, 'close() first sends a FIN');
  carriage.sockets[0].write(Buffer.alloc(1024, 1)); // ignored once closed
  await waitFor(() => socket.destroyed, 3000, 'socket drop after close');
});

test('one-shot CHECKIN and LOGINLIST reject a malformed or early-closed reply instead of throwing from the socket', async () => {
  const client = new LocoClient();
  for (const bytes of Object.values(malformed)) {
    const carriage = await hostileCarriage(() => bytes);
    try {
      await assert.rejects(client.checkin('127.0.0.1', carriage.port, '1'), isLoco('MALFORMED'));
      await assert.rejects(client.loginList('127.0.0.1', carriage.port, '1', 'fixture-token', 'fixture-device'), isLoco('MALFORMED'));
    } finally {
      carriage.stop();
    }
  }
  const closing = await hostileCarriage(() => Buffer.alloc(0), (socket) => socket.end());
  try {
    await assert.rejects(client.checkin('127.0.0.1', closing.port, '1'), isLoco('CLOSED'));
  } finally {
    closing.stop();
  }
});

test('a trailer upload settles when the server closes or sends a malformed frame before COMPLETE', async () => {
  const opts = { host: '127.0.0.1', token: 'fixture', userId: 1, chatId: 2, data: new Uint8Array([1, 2, 3]), type: 2, timeoutMs: 5000 };
  const closing = await hostileCarriage(() => Buffer.alloc(0), (socket) => socket.end());
  try {
    await assert.rejects(uploadMediaToTrailer({ ...opts, port: closing.port }), isLoco('CLOSED'));
  } finally {
    closing.stop();
  }
  const hostile = await hostileCarriage(() => lengthPrefix(MAX_LOCO_FRAME_BYTES + 1));
  try {
    await assert.rejects(uploadMediaToTrailer({ ...opts, port: hostile.port }), isLoco('MALFORMED'));
  } finally {
    hostile.stop();
  }
});

test('a plaintext GETCONF reply announcing an oversized body is refused before it is buffered', () => {
  // getBookingConfig speaks TLS; exercise its reader through the same bounded packet helper.
  const q = new ByteQueue();
  const header = Buffer.alloc(LOCO_HEADER_SIZE);
  header.writeUInt32LE(MAX_LOCO_BODY_BYTES + 1, 18);
  q.push(header);
  assert.throws(() => takeLocoPacket(q), isLoco('MALFORMED'));
  const ok = new ByteQueue();
  const packet = Buffer.from(encodeLocoPacket(1, 0, 'GETCONF', { revision: BSON.Long.fromNumber(1) }));
  ok.push(packet.subarray(0, 5));
  assert.equal(takeLocoPacket(ok), null);
  ok.push(packet.subarray(5));
  assert.deepEqual(takeLocoPacket(ok), packet);
});
