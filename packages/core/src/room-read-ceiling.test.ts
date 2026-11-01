import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setup, CHAT, SELF } from './kakao-session-fixture.test-helper.ts';
import type { KakaoSession } from './kakao-session.ts';

const OTHER = '111111111';
const deniedByCeiling = (error: unknown) => !!error && typeof error === 'object' &&
  'code' in error && error.code === 'POLICY_DENIED' && 'message' in error && /operator ceiling/.test(String(error.message));

function fixture(t: { after(fn: () => void): void }, ceiling: string, mode = 'trust') {
  const f = setup({ KAKAO_AGENT_MODE: mode, KAKAO_ROOM_CEILING: ceiling, KAKAO_PAUSED: '1' }, [], false, () => {});
  t.after(() => { f.kakao.stop(); fs.rmSync(f.dir, { recursive: true, force: true }); });
  f.fake.connect();
  f.fake.emit('message', { chatId: CHAT, authorId: SELF, messageId: '9001', type: 2,
    text: 'ceiling fixture', attachment: { k: 'fixture-token' }, sendAt: 1, raw: {} });
  return f;
}

const reads: Array<[string, (kakao: KakaoSession) => Promise<unknown>]> = [
  ['search', kakao => kakao.searchMessages('ceiling fixture', { chatId: CHAT })],
  ['history', kakao => kakao.getHistory(CHAT)],
  ['recent', kakao => kakao.recentMessages(0, CHAT)],
  ['attachment', kakao => kakao.downloadMedia(CHAT, { token: 'fixture-token', messageId: '9001' })],
  ['vault export', kakao => kakao.exportChatHistory(CHAT, { format: 'json' })],
  ['vault search', kakao => kakao.searchVault({ chatIds: [CHAT], query: 'ceiling fixture' })],
  ['extension read', kakao => kakao.extensionHost().beginContentRead(CHAT)]
];

for (const [name, read] of reads) test(`${name} cannot expose a trust room outside the operator ceiling`, async t => {
  const { kakao, fake } = fixture(t, OTHER);
  await assert.rejects(read(kakao), deniedByCeiling);
  assert.equal(fake.calls.length, 0, 'refuse before fetching any room content');
});

test('a scoped read grant and an explicit immediate rule cannot override the operator ceiling', async t => {
  const { kakao } = fixture(t, OTHER, 'ask');
  const grant = kakao.createReadGrant({ grantId: randomUUID(), chatId: CHAT, tools: ['read_messages'],
    maxMessages: 20, uses: 1, expiresAt: Date.now() + 60_000 });
  await assert.rejects(kakao.searchMessages('ceiling fixture', { chatId: CHAT,
    readGrant: { id: grant.grantId, tool: 'read_messages' } }), deniedByCeiling);
  assert.equal(kakao.listReadGrants()[0]?.usesLeft, 1, 'refusal must not spend the grant');
  kakao.setRoomAccess(CHAT, { mode: 'immediate' });
  await assert.rejects(kakao.searchMessages('ceiling fixture', { chatId: CHAT }), deniedByCeiling);
});

test('unread preview cannot expose a room outside the operator ceiling', async t => {
  const { kakao, fake } = fixture(t, OTHER);
  kakao.setRoomAccess(CHAT, { mode: 'manual', unreadPreviewAfterLogId: '9000', maxMessages: 20,
    expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const grant = kakao.createReadGrant({ grantId: randomUUID(), chatId: CHAT, tools: ['preview_unread'],
    maxMessages: 20, uses: 1, expiresAt: Date.now() + 60_000 });
  await assert.rejects(kakao.previewUnreadMessages(CHAT,
    { readGrant: { id: grant.grantId, tool: 'preview_unread' } }), deniedByCeiling);
  assert.equal(kakao.listReadGrants()[0]?.usesLeft, 1);
  assert.equal(fake.calls.length, 0);
});

for (const ceiling of ['', CHAT]) test(`content reads remain allowed with ${ceiling ? 'a matching' : 'an empty'} ceiling while sends start paused`, async t => {
  const { kakao } = fixture(t, ceiling);
  assert.equal(kakao.config.policy.pausedAtStart, true);
  assert.deepEqual((await kakao.searchMessages('ceiling fixture', { chatId: CHAT })).map(m => m.text), ['ceiling fixture']);
});
