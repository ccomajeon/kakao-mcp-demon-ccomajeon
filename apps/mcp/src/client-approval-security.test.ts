import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentSendJournal, ApprovalStore, ApproverRegistry, RecipientPermissions } from '@kakao-mcp/core';
import { ElicitationApprovals } from './client-approval.ts';

function fixture(t: { after(fn: () => void): void }, action = 'send_media', enabled = true, ceiling: string[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-replay-'));
  const journal = AgentSendJournal.open(root);
  t.after(() => { journal.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const store = new ApprovalStore(journal, new ApproverRegistry(root), Date.now, { clientConfirmations: enabled });
  const recipients = new RecipientPermissions(journal, { dailyLimit: 50, timeZone: 'UTC' });
  const id = randomUUID(), chatId = '123456789', expiresAt = Date.now() + 60_000;
  journal.prepare({ request_id: id, payload_digest: 'fixture', room_digest: 'fixture', context_digest: 'fixture', policy_digest: 'fixture',
    created_at: Date.now(), expires_at: expiresAt, state: 'prepared', category: 'message-as-you', message_id: null, attempted_at: null });
  const args = { requestId: id, chatId };
  const signingText = JSON.stringify({ action, accountId: '111111111', requestId: id,
    message: { chatId, text: 'fixture', sha256: 'a'.repeat(64), type: 2 } });
  const client = { name: 'fixture-client', elicitation: true };
  const reads: string[] = [];
  const gate = new ElicitationApprovals(store, Date.now, recipients, { allowRead: id => { reads.push(id); } }, id => !ceiling.length || ceiling.includes(id));
  const ask = gate.request(action, args, { requestId: id, expiresAt, signingText }, client)!;
  const code = ask ? /확인 코드 ([A-Z2-9]{4}) 를 입력하세요\. 거절/.exec(ask.inputRequests.approve.params.message as string)![1] : '';
  const answer = () => gate.answer(action, args, ask.requestState, { approve: { action: 'accept', content: { code, remember: true } } }, client);
  return { journal, recipients, id, chatId, answer, ask, reads };
}

for (const state of ['sent_unverified', 'rejected'] as const) test(`photo approval replay after ${state} cannot resurrect a revoked room grant`, t => {
  const f = fixture(t);
  assert.equal(f.answer(), 'approved');
  assert.ok(f.recipients.get(f.chatId));
  f.journal.transition(f.id, 'prepared', state);
  assert.equal(f.recipients.revoke(f.chatId), true);
  assert.throws(f.answer, { code: 'APPROVAL_REQUIRED' });
  assert.equal(f.recipients.get(f.chatId), undefined);
});

for (const action of ['send_media', 'send_message']) test(`a pending ${action} confirmation cannot be replayed to restore a revoked grant`, t => {
  const f = fixture(t, action);
  assert.equal(f.answer(), 'approved');
  assert.equal(f.recipients.revoke(f.chatId), true);
  assert.equal(f.answer(), 'approved', 'retries retain the original confirmation without widening permissions again');
  assert.equal(f.recipients.get(f.chatId), undefined);
});

test('disabled client confirmations cannot create a photo room grant', t => {
  const f = fixture(t, 'send_media', false);
  assert.throws(f.answer, { code: 'APPROVAL_REQUIRED' });
  assert.equal(f.recipients.get(f.chatId), undefined);
});

for (const action of ['send_message', 'send_media']) test(`the dialog never stores a ${action} room permission outside the operator ceiling`, t => {
  const f = fixture(t, action, true, ['555555555']);
  const schema = f.ask?.inputRequests.approve.params.requestedSchema as { properties: Record<string, unknown> } | undefined;
  // A photo outside the ceiling cannot be asked as a room permission; a message is asked without "remember".
  if (action === 'send_media') { assert.equal(f.ask, undefined); return; }
  assert.equal(schema!.properties.remember, undefined);
  assert.equal(f.answer(), 'approved');
  assert.equal(f.recipients.get(f.chatId), undefined);
});

test('a read dialog never remembers a room outside the operator ceiling, even with a forged answer', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-ceiling-'));
  const journal = AgentSendJournal.open(root);
  t.after(() => { journal.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const store = new ApprovalStore(journal, new ApproverRegistry(root), Date.now, { clientConfirmations: true });
  const recipients = new RecipientPermissions(journal, { dailyLimit: 50, timeZone: 'UTC' });
  const reads: string[] = [];
  for (const [chatId, inside] of [['123456789', false], ['555555555', true]] as const) {
    const id = randomUUID(), expiresAt = Date.now() + 60_000;
    journal.prepare({ request_id: id, payload_digest: 'fixture', room_digest: 'fixture', context_digest: 'fixture', policy_digest: 'fixture',
      created_at: Date.now(), expires_at: expiresAt, state: 'prepared', category: 'message-as-you', message_id: null, attempted_at: null });
    const gate = new ElicitationApprovals(store, Date.now, recipients, { allowRead: room => { reads.push(room); } }, room => room === '555555555');
    const args = { requestId: id, chatId }, client = { name: 'fixture-client', elicitation: true };
    const signingText = JSON.stringify({ action: 'read_room', accountId: '111111111', requestId: id, request: { chatId, maxMessages: 20, ttlMinutes: 10, uses: 1, tools: ['read_messages'] } });
    const ask = gate.request('read_room', args, { requestId: id, expiresAt, signingText }, client)!;
    const props = (ask.inputRequests.approve.params.requestedSchema as { properties: Record<string, unknown> }).properties;
    assert.equal('remember' in props, inside); assert.equal('reply' in props, inside);
    const code = /확인 코드 ([A-Z2-9]{4}) 를 입력하세요\. 거절/.exec(ask.inputRequests.approve.params.message as string)![1];
    assert.equal(gate.answer('read_room', args, ask.requestState, { approve: { action: 'accept', content: { code, remember: true, reply: true } } }, client), 'approved');
    assert.equal(!!recipients.get(chatId), inside);
  }
  assert.deepEqual(reads, ['555555555']);
});
