// Optional "chats" group: room details and local-only actions. Account-visible room changes
// (leave, notice, read receipt, CREATE) are named operations in agent-operations.ts.
import { HIDE_DAILY_LIMIT, HIDE_PER_CALL, KakaoError, type KakaoSession, type SendPolicy } from '@kakao-mcp/core';
import { markUntrusted, UNTRUSTED_TOOL_NOTE } from '../untrusted.ts';
import { readGrant } from '../read-grant.ts';
import type { McpStdioServer } from '../mcp-stdio.ts';

export function registerChatTools(server: McpStdioServer, kakao: KakaoSession, policy?: Pick<SendPolicy, 'audit'>): void {
  server.registerTool({
    name: 'open_direct_chat',
    group: 'chats',
    annotations: { readOnlyHint: true, openWorldHint: true },
    description: 'Find the 1:1 room with a friend by name (e.g. "홍길동") or numeric userId. Returns its chatId, or chatId null with needsCreate and the exact userId; ' +
      'creating it is create_direct_chat (human approval). Lookup only: never creates a room. Names match friends\' nicknames only (not status messages); ' +
      'when a name matches more than one friend the result is ambiguous: true with candidates and no chatId: ask the person which one and call again with its userId.' + UNTRUSTED_TOOL_NOTE,
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Friend name, nickname, or numeric userId.' } }, required: ['query'], additionalProperties: false },
    handler: async args => {
      const res = await kakao.openDirectChat(String(args.query), { allowCreate: false });
      if (res.ambiguous) {
        // Anyone can rename themselves: never pick one of several matching friends.
        return markUntrusted({ ok: false, ambiguous: true, chatId: null, candidates: (res.candidates ?? []).map(f => ({ userId: f.userId, nickName: f.nickName ?? null, friendNickName: f.friendNickName ?? null })),
          reason: 'several friends match this name; confirm the person and call again with their numeric userId' });
      }
      if (!res.chatId) {
        return markUntrusted({ ok: false, needsCreate: true, chatId: null, userId: res.friend?.userId ?? String(args.query), title: res.title, friend: res.friend,
          reason: 'no loaded 1:1 chat; creating one needs create_direct_chat and human approval' });
      }
      return markUntrusted({ ok: true, chatId: res.chatId, title: res.title, isNew: res.isNew, friend: res.friend });
    }
  });

  server.registerTool({
    name: 'get_members',
    group: 'chats',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    description: 'Look up specific members of a room by userId (LOCO MEMBER): display name and profile image, e.g. message authors that list_chats does not show in large groups.' + UNTRUSTED_TOOL_NOTE,
    inputSchema: { type: 'object', properties: {
      chatId: { type: 'string' }, userIds: { type: 'array', items: { type: 'string' }, description: 'At most 100 numeric userIds.' }
    }, required: ['chatId', 'userIds'], additionalProperties: false },
    handler: async args => {
      const userIds = (args.userIds as unknown[]).map(u => String(u));
      if (!userIds.length || userIds.length > 100 || userIds.some(u => !/^\d+$/.test(u))) throw new KakaoError('INVALID_ARGUMENT', 'userIds must be 1-100 numeric userIds');
      const res = await kakao.getMembers(String(args.chatId), userIds);
      return markUntrusted({ chatId: String(args.chatId), count: res.members.length, members: res.members, raw: res.raw });
    }
  });

  server.registerTool({
    name: 'get_chat_meta',
    group: 'chats',
    annotations: { readOnlyHint: true, openWorldHint: true },
    description: 'Read shared room metadata (LOCO GETMETA) such as the notice. `types` are numeric ChatMetaType values. Room read rules apply.' + UNTRUSTED_TOOL_NOTE,
    inputSchema: { type: 'object', properties: {
      chatId: { type: 'string' }, types: { type: 'array', items: { type: 'number' } },
      readGrantId: { type: 'string', description: 'Manual rooms only: readGrantId covering get_chat_meta.' }
    }, required: ['chatId', 'types'], additionalProperties: false },
    handler: async args => {
      const res = await kakao.getMeta(String(args.chatId), (args.types as unknown[]).map(t => Number(t)), readGrant(args, 'get_chat_meta'));
      return markUntrusted({ status: res.status, raw: res.raw });
    }
  });

  server.registerTool({
    name: 'self_delete_messages',
    group: 'chats',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Hide messages only in this daemon\'s local store ("나에게서만 삭제"). Nothing is sent to KakaoTalk; other members and devices still see them. ' +
      'Hidden messages are left out of read_messages, previews and the person\'s own local history; stored rows are kept, and no tool unhides them. ' +
      `Only messages stored in a room you may read now (room rule and operator ceiling), at most ${HIDE_PER_CALL} logIds per call and ${HIDE_DAILY_LIMIT} per day; each call is audited. ` +
      'To remove a message for everyone use edit_or_delete_message.',
    inputSchema: { type: 'object', properties: { chatId: { type: 'string' }, logIds: { type: 'array', items: { type: 'string' }, maxItems: HIDE_PER_CALL } }, required: ['chatId', 'logIds'], additionalProperties: false },
    handler: args => {
      const chatId = String(args.chatId), res = kakao.hideMessages(chatId, args.logIds as unknown[]);
      // Metadata only: the room is keyed in the audit log, never message IDs or content.
      policy?.audit({ ts: new Date().toISOString(), chatId, category: 'message-as-you', decision: 'allowed',
        reason: `self_delete_messages hid ${res.hidden.length} stored message(s) locally`, textLength: 0 });
      return { local: true, ...res };
    }
  });
}
