import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup, phoneRead, CHAT, isCode } from './kakao-session-fixture.test-helper.ts';
import { removeTestDir } from './temp-dir.test-helper.ts';

const MiB = 1024 * 1024;

test('a one-time read grant caps how many live messages recent and wait return', async t => {
  const { kakao, fake, dir } = setup({}, [], false); // ask mode: the room has no rule, so it is denied
  t.after(() => { kakao.stop(); removeTestDir(dir); });
  fake.connect(); phoneRead(kakao);
  for (let i = 0; i < 30; i++) fake.emit('message', { chatId: CHAT, authorId: '42', messageId: String(8000 + i), type: 1, text: `fixture ${i}`, sendAt: 80 + i, raw: {} });
  const grant = (maxMessages: number) => ({ readGrant: { id: kakao.createReadGrant({ grantId: randomUUID(), chatId: CHAT, tools: ['read_messages'],
    maxMessages, uses: 1, expiresAt: Date.now() + 600_000 }).grantId, tool: 'read_messages' as const } });

  const one = grant(1);
  assert.equal(kakao.liveReadLimit(CHAT, one), 1);
  assert.equal((await kakao.recentMessages(0, CHAT, one)).length, 1);
  await assert.rejects(kakao.recentMessages(0, CHAT, one), isCode('POLICY_DENIED'), 'the grant has no second use');

  assert.equal((await kakao.recentMessages(0, CHAT, grant(4))).length, 4);
  assert.equal((await kakao.waitForMessages(0, 1000, CHAT, grant(3))).length, 3);
  assert.equal(kakao.liveReadLimit(CHAT), 50, 'without a grant the room limit applies');
});

test('agent attachment download keeps the 16 MiB limit: early refusal from stored size and a byte cap for the transfer', async t => {
  const { kakao, fake, dir } = setup();
  t.after(() => { kakao.stop(); removeTestDir(dir); });
  fake.connect(); phoneRead(kakao);
  fake.emit('message', { chatId: CHAT, authorId: '42', messageId: '9001', type: 18, text: 'fixture', sendAt: 1,
    attachment: JSON.stringify({ k: 'fixture-large-token', tk: 'fixture-thumb-token', s: 16 * MiB + 1 }), raw: {} });
  fake.emit('message', { chatId: CHAT, authorId: '42', messageId: '9002', type: 2, text: 'fixture', sendAt: 2,
    attachment: JSON.stringify({ k: 'fixture-small-token', s: 3 }), raw: {} });

  await assert.rejects(kakao.downloadMedia(CHAT, { token: 'fixture-large-token', messageId: '9001' }), isCode('INVALID_ARGUMENT'));
  assert.equal(fake.calls.filter(c => c.method === 'downloadMedia').length, 0, 'refused before any transfer');

  fake.replies.downloadMedia = [{ status: 0, data: Buffer.from('abc'), size: 3 }, { status: 0, data: Buffer.from('t'), size: 1 }];
  assert.equal(Buffer.from((await kakao.downloadMedia(CHAT, { token: 'fixture-small-token', messageId: '9002' })).data).toString(), 'abc');
  // A thumbnail of a large original is still allowed; the transfer cap bounds it.
  await kakao.downloadMedia(CHAT, { token: 'fixture-thumb-token', messageId: '9001' });
  const downloads = fake.calls.filter(c => c.method === 'downloadMedia');
  assert.equal(downloads.length, 2);
  for (const call of downloads) assert.equal((call.args[1] as { maxBytes?: number }).maxBytes, 16 * MiB);
});
