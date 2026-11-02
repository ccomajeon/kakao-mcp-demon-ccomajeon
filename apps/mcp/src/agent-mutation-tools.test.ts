import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { AgentMutationService, AgentSendJournal, ApprovalStore, ApproverRegistry, KakaoError, SendPolicy, type KakaoSession } from '@kakao-mcp/core';
import { setup, CHAT, SELF } from '../../../packages/core/src/kakao-session-fixture.test-helper.ts';
import { ApprovalCenter, setApprovalCenter } from './approval-center.ts';
import { approvalMessage } from './client-approval.ts';
import { agentMutationAdapter, registerAgentMutationTools } from './tools/agent-mutations.ts';
import { McpStdioServer } from './mcp-stdio.ts';
import { fixtureApprovals } from './approval-fixture.test-helper.ts';

test('MCP mutations bind exact inspected targets, require human approval and never replay after success or lost response',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-mutation-')),journal=AgentSendJournal.open(root),approvals=fixtureApprovals(journal,root);
  t.after(()=>{journal.close();fs.rmSync(root,{recursive:true,force:true});});
  let executions=0,fail=false,sourceType=20;
  const session={selfUserId:'123456789',getState:()=>({connected:true}),listChats:()=>[{id:'123456789',maxLogId:'9007199254740993',memberCount:2}],
    inspectAgentStoredMessage:async(chatId:string,logId:string)=>({target:{chatId,messageId:logId,authorId:'123456789',type:sourceType,revision:null,text:'fixture source',attachment:'{"name":"fixture","path":"fixture/path"}'},emoticonSupported:true,validate:()=>{},
      sendEmoticonTo:async()=>{executions++;if(fail)throw new Error('fixture response loss');return {status:0,logId:'9007199254740994'};},edit:async()=>{executions++;return {status:0};},delete:async()=>{executions++;return {status:0};}}),
    getMyProfile:async()=>({profile:{profileId:'123456789',nickname:'fixture',statusMessage:'fixture before'},profiles:[{profileId:'123456789'}]}),updateMyProfile:async()=>{executions++;return {status:0};}} as unknown as KakaoSession;
  const service=new AgentMutationService({principal:'local-mcp',journal,approvals:approvals.store,adapter:agentMutationAdapter(session),policy:new SendPolicy({ceiling: ['123456789'],pausedAtStart:false,auditLogPath:path.join(root,'audit')})});
  const server=new McpStdioServer({name:'fixture',version:'1',toolGroups:['chats','friends']});registerAgentMutationTools(server,()=>service);
  const call=async(name:string,args:object)=>{const input=new PassThrough();let text='';const output=new Writable({write(c,_e,done){text+=c.toString();done();}});const done=new Promise<void>(r=>server.serveConnection(input,output,r));input.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})+'\n');await done;return JSON.parse(text).result;};
  const asked=async(name:string,args:object)=>{const r=await call(name,args);assert.equal(r.structuredContent.error.code,'APPROVAL_REQUIRED');return r.structuredContent.error.details.approval;};
  // The exact envelope a human channel shows (the agent only gets a copy with stored content redacted).
  const reviewed=(name:string,args:Record<string,any>)=>{const {requestId,action,...request}=args;
    return service.prepare(name==='edit_or_delete_message'?(action==='edit'?'edit_message':'delete_message'):name as 'send_emoticon'|'update_my_profile',requestId,request);};
  for(const [tool,payload,emoticon] of [
    ['send_emoticon',{chatId:'123456789',fromChatId:'123456789',fromLogId:'9007199254740993'},true],
    ['edit_or_delete_message',{action:'edit',chatId:'123456789',logId:'9007199254740993',text:'fixture after'},false],
    ['edit_or_delete_message',{action:'delete',chatId:'123456789',logId:'9007199254740993'},false],
    ['update_my_profile',{profileId:'123456789',statusMessage:''},false]
  ] as const){
    sourceType=emoticon?20:1;
    const args={...payload,requestId:randomUUID()},before=executions;
    const approval=await asked(tool,args);assert.equal(executions,before);
    if(tool==='update_my_profile')assert.equal(JSON.parse(approval.signingText).requestId,args.requestId);
    else{
      // Stored message content is for the person's review only: the agent sees it redacted before approval.
      assert.equal(approval.signingText,undefined);assert.deepEqual(approval.redacted,['context.target.text','context.target.attachment']);
      const review=JSON.parse(approval.reviewText);assert.equal(review.requestId,args.requestId);assert.ok(!approval.reviewText.includes('fixture source')&&!approval.reviewText.includes('fixture/path'));
      const exact=await reviewed(tool,args);assert.equal(JSON.parse(exact.signingText!).context.target.text,'fixture source');
    }
    assert.equal((await call(tool,{...args,confirm:true})).structuredContent.error.code,'INVALID_ARGUMENT');
    approvals.approve(await reviewed(tool,args));const result=await call(tool,args);
    assert.equal(JSON.parse(result.content[0].text).state,'applied_unverified');await call(tool,args);assert.equal(executions,before+1);
  }
  assert.equal((await call('edit_or_delete_message',{action:'edit',requestId:randomUUID(),chatId:'123456789',logId:'9007199254740993'})).structuredContent.error.code,'INVALID_ARGUMENT');
  fail=true;sourceType=20;const args={requestId:randomUUID(),chatId:'123456789',fromChatId:'123456789',fromLogId:'9007199254740993'};
  await asked('send_emoticon',args);approvals.approve(await reviewed('send_emoticon',args));
  const uncertain=await call('send_emoticon',args);
  assert.equal(uncertain.structuredContent.error.code,'MUTATION_OUTCOME_UNKNOWN');assert.equal(uncertain.structuredContent.error.retryable,false);
  await call('send_emoticon',args);assert.equal(executions,5);
});

test('a read refusal while checking the target says what to do next for manual and closed rooms',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-mutation-hint-')),journal=AgentSendJournal.open(root),approvals=fixtureApprovals(journal,root);
  t.after(()=>{journal.close();fs.rmSync(root,{recursive:true,force:true});});
  let mode='manual';
  const session={selfUserId:'123456789',getState:()=>({connected:true}),listChats:()=>[{id:'123456789',maxLogId:'9',memberCount:2}],
    getRoomAccess:()=>({rule:{mode}}),
    inspectAgentStoredMessage:async()=>{throw new KakaoError('POLICY_DENIED','fixture read refused');}} as unknown as KakaoSession;
  const service=new AgentMutationService({principal:'local-mcp',journal,approvals:approvals.store,adapter:agentMutationAdapter(session),policy:new SendPolicy({ceiling:[],pausedAtStart:false,auditLogPath:path.join(root,'audit')})});
  const request={chatId:'123456789',logId:'9'};
  await assert.rejects(service.prepare('delete_message',randomUUID(),request),(e:Error)=>/confirmRead=true/.test(e.message));
  mode='deny';
  await assert.rejects(service.prepare('delete_message',randomUUID(),request),(e:Error)=>/closed to reading/.test(e.message)&&!/confirmRead=true/.test(e.message));
});

test('a manual-room message read for review reaches the person, never the agent before approval', async t => {
  const { kakao, fake, dir } = setup({}, [], false);
  const journal = AgentSendJournal.open(path.join(dir, 'journal')), store = new ApprovalStore(journal, new ApproverRegistry(dir));
  const center = new ApprovalCenter({ store, origin: 'http://localhost:8788' });
  setApprovalCenter(center, store);
  t.after(() => { setApprovalCenter(undefined); center.close(); journal.close(); kakao.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  fake.connect();
  fake.emit('message', { chatId: CHAT, authorId: SELF, messageId: '9100', type: 1, text: 'fixture-stored-only-for-review', sendAt: 91, raw: {} });
  kakao.setRoomAccess(CHAT, { mode: 'manual' });
  const service = new AgentMutationService({ principal: 'local-mcp', journal, approvals: store, adapter: agentMutationAdapter(kakao),
    policy: new SendPolicy({ ceiling: [], pausedAtStart: false, auditLogPath: path.join(dir, 'audit') }) });
  const server = new McpStdioServer({ name: 'fixture', version: '1' }); registerAgentMutationTools(server, () => service);
  const input = new PassThrough(); let text = '';
  const output = new Writable({ write(c, _e, done) { text += c.toString(); done(); } });
  const finished = new Promise<void>(r => server.serveConnection(input, output, r));
  const args = { requestId: randomUUID(), action: 'delete', chatId: CHAT, logId: '9100', confirmRead: true };
  input.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'edit_or_delete_message', arguments: args } }) + '\n');
  await finished;
  // Everything the agent receives: no stored content anywhere, only a redacted review copy and the passkey link.
  assert.equal(text.includes('fixture-stored-only-for-review'), false);
  const error = JSON.parse(text).result.structuredContent.error;
  assert.equal(error.code, 'APPROVAL_REQUIRED');
  assert.equal(error.details.approval.signingText, undefined);
  assert.equal(JSON.parse(error.details.approval.reviewText).context.target.text, '[redacted until the person approves]');
  // The passkey page still shows the person the exact envelope, including the message being deleted.
  const token = String(error.details.passkey.approvalUrl).split('#')[1];
  const pending = center.get(args.requestId, token);
  assert.equal(JSON.parse(pending.signingText).context.target.text, 'fixture-stored-only-for-review');
  assert.ok(approvalMessage(pending.signingText)?.includes('fixture-stored-only-for-review'), 'and so does the client dialog');
  assert.equal(fake.calls.filter(c => c.method === 'deleteMessage').length, 0);
});
