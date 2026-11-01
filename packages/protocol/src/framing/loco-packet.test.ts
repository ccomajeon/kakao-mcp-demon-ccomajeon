import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeLocoPacket, decodeLocoHeader, decodeLocoPacket, LOCO_HEADER_SIZE } from './loco-packet.js';
import { LocoError } from '../errors/loco-error.js';

test('wire bytes match an independently specified little-endian empty BSON frame', () => {
  const expected = Buffer.from('78563412000050494e470000000000000000050000000500000000', 'hex');
  assert.deepEqual(Buffer.from(encodeLocoPacket(0x12345678, 0, 'PING', {})), expected);
  const storage = Buffer.concat([Buffer.from([99]), expected, Buffer.from([88])]);
  assert.deepEqual(decodeLocoPacket(storage.subarray(1, -1)).data, {});
});

test('outgoing fields reject overflow, fractional numbers and non-ASCII method bytes', () => {
  for (const id of [-1, 2 ** 32, 1.5, NaN, Infinity]) {
    assert.throws(() => encodeLocoPacket(id, 0, 'PING', {}), { code: 'INVALID_ARGUMENT' });
  }
  for (const status of [-32769, 65536, 0.5, NaN]) {
    assert.throws(() => encodeLocoPacket(1, status, 'PING', {}), { code: 'INVALID_ARGUMENT' });
  }
  for (const type of [-1, 256, 0.5, NaN]) {
    assert.throws(() => encodeLocoPacket(1, 0, 'PING', {}, type), { code: 'INVALID_ARGUMENT' });
  }
  for (const method of ['A\0B', '한글', '\nPING']) {
    assert.throws(() => encodeLocoPacket(1, 0, method, {}), { code: 'INVALID_ARGUMENT' });
  }
});

test('signed failure status preserves the original two-complement wire representation', () => {
  const packet = encodeLocoPacket(1, -1, 'MPOST', {});
  assert.deepEqual([...packet.subarray(4, 6)], [255, 255]);
  assert.equal(decodeLocoHeader(packet).status, 65535);
});

test('truncated raw bodies and corrupt BSON fail with a protocol error', () => {
  const raw = Buffer.from('01000000000050494e47000000000000000104000000aabb', 'hex');
  assert.throws(() => decodeLocoPacket(raw), { code: 'MALFORMED' });
  const corrupt = Buffer.from('01000000000050494e470000000000000000050000000000000000', 'hex');
  assert.throws(() => decodeLocoPacket(corrupt), (err: unknown) => err instanceof LocoError && err.code === 'MALFORMED');
});

test('raw payload and trailing transport bytes remain bounded to the declared body', () => {
  const raw = Buffer.from('01000000000050494e47000000000000000102000000aabbcc', 'hex');
  assert.deepEqual([...decodeLocoPacket<Uint8Array>(raw).data], [0xaa, 0xbb]);
});

test('LOCO Packet Encoding and Decoding Roundtrip', () => {
  const payload = {
    MCCMNC: '999',
    model: '',
    os: 'win32',
    count: 42
  };

  const encoded = encodeLocoPacket(101, 0, 'GETCONF', payload);
  assert.equal(encoded.length >= LOCO_HEADER_SIZE, true);

  const header = decodeLocoHeader(encoded.subarray(0, LOCO_HEADER_SIZE));
  assert.equal(header.id, 101);
  assert.equal(header.status, 0);
  assert.equal(header.method, 'GETCONF');
  assert.equal(header.dataType, 0);

  const decoded = decodeLocoPacket<typeof payload>(encoded);
  assert.equal(decoded.header.id, 101);
  assert.equal(decoded.header.method, 'GETCONF');
  assert.equal(decoded.data.MCCMNC, '999');
  assert.equal(decoded.data.os, 'win32');
  assert.equal(decoded.data.count, 42);
});

test('LOCO Method length validation', () => {
  assert.throws(() => {
    encodeLocoPacket(1, 0, 'TOOLONGMETHODNAME', {});
  }, /exceeds 11 bytes/);
});
