import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectSharedLinks, trimTrailingPunctuation, MAX_URL_CHARS } from './curation-tools.ts';

const message = (text: string, n = 1) => ({ messageId: String(n), chatId: '123456789', text, sendAt: n });

test('shared links drop sentence punctuation and keep the URL itself', () => {
  const out = collectSharedLinks([message('see https://github.com/example/repo). and https://example.com/a?b=1!!')]);
  assert.deepEqual(out.allLinks.map(l => l.url), ['https://github.com/example/repo', 'https://example.com/a?b=1']);
  assert.equal(out.allLinks[0].category, 'github');
  assert.equal(trimTrailingPunctuation('https://example.com/.,;!?)>'), 'https://example.com/');
  assert.equal(trimTrailingPunctuation('...'), '');
});

test('pathological punctuation runs and giant URL tokens are handled in linear time', () => {
  const run = 'https://a/' + '.'.repeat(100_000) + 'x';
  const tailRun = 'https://a/b' + '.'.repeat(MAX_URL_CHARS - 20);
  const giant = 'https://a/' + 'b'.repeat(500_000);
  const messages = Array.from({ length: 100 }, (_, i) => message(i % 3 === 0 ? run : i % 3 === 1 ? tailRun : giant, i + 1));
  const started = performance.now();
  const out = collectSharedLinks(messages);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 100, `100 hostile messages took ${elapsed.toFixed(1)}ms`);
  assert.ok(out.allLinks.every(l => l.url.length <= MAX_URL_CHARS));
  assert.ok(out.allLinks.some(l => l.url === 'https://a/b'), 'a URL followed by a long punctuation run is still collected');
});
