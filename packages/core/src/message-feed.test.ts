import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFeed } from './message-feed.ts';

const m = (chatId: string, text: string) => ({ chatId, authorId: '2', text, type: 1, sendAt: 1, raw: {} });

test('invalid capacity cannot create an unbounded or unusable message feed', () => {
  for (const capacity of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => new MessageFeed(capacity), { code: 'CONFIG_INVALID' });
  }
});

test('multiple wraps preserve order, room filters and monotonic cursors', () => {
  const feed = new MessageFeed(3);
  for (let i = 1; i <= 10; i++) feed.push(m(i % 2 ? 'a' : 'b', String(i)));
  assert.equal(feed.cursor, 10);
  assert.deepEqual(feed.recent().map(v => v.seq), [8, 9, 10]);
  assert.deepEqual(feed.recent(8, 'a').map(v => v.text), ['9']);
  assert.deepEqual(feed.recent(10), []);
});

test('independent waiters wake only for their own room and unsubscribe stops notifications', async () => {
  const feed = new MessageFeed(2), seen: string[] = [];
  const unsubscribe = feed.onMessage(room => seen.push(room));
  const a = feed.wait(0, 1000, 'a'), b = feed.wait(0, 1000, 'b');
  feed.push(m('a', 'first'));
  assert.deepEqual((await a).map(v => v.text), ['first']);
  unsubscribe();
  feed.push(m('b', 'second'));
  assert.deepEqual((await b).map(v => v.text), ['second']);
  assert.deepEqual(seen, ['a']);
});

test('push assigns increasing seq; recent filters by cursor and chat', () => {
  const f = new MessageFeed();
  assert.equal(f.cursor, 0);
  f.push(m('a', '1'));
  f.push(m('b', '2'));
  f.push(m('a', '3'));
  assert.equal(f.cursor, 3);
  assert.deepEqual(f.recent(1).map((x) => x.text), ['2', '3']);
  assert.deepEqual(f.recent(0, 'a').map((x) => x.seq), [1, 3]);
});

test('ring buffer keeps only the newest `max` events', () => {
  const f = new MessageFeed(2);
  for (const t of ['1', '2', '3']) f.push(m('a', t));
  assert.deepEqual(f.recent().map((x) => x.text), ['2', '3']);
});

test('read receipts become type -1 events; incomplete ones are ignored', () => {
  const f = new MessageFeed();
  assert.equal(f.pushReadReceipt({ chatId: 'a', watermark: '', userId: '2' } as any), undefined);
  const r = f.pushReadReceipt({ chatId: 'a', watermark: '99', userId: '2' } as any);
  assert.equal(r?.type, -1);
  assert.deepEqual(r?.raw, { isReadReceipt: true, watermark: '99', userId: '2' });
});

test('wait resolves immediately, on a matching push, or empty on timeout', async () => {
  const f = new MessageFeed();
  f.push(m('a', 'old'));
  assert.equal((await f.wait(0, 1000)).length, 1);

  const pending = f.wait(f.cursor, 1000, 'b');
  f.push(m('a', 'other chat'));
  f.push(m('b', 'mine'));
  assert.deepEqual((await pending).map((x) => x.text), ['mine']);

  const t0 = Date.now();
  assert.deepEqual(await f.wait(f.cursor, 30), []);
  assert.ok(Date.now() - t0 >= 25);
});
