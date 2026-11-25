import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the actual page helpers on received (untrusted) attachment and link data. Decode
// attributes as HTML does, so escaping a quote as an HTML entity cannot hide an exploit.
const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const between = (start: string, end: string) => {
  const from = source.indexOf(start);
  assert.ok(from >= 0, start);
  return source.slice(from, source.indexOf(end, from));
};
const helpers = [
  source.match(/^const esc = .*$/m)![0],
  between('function safeImageUrl(', '\n}\n') + '\n}',
  source.match(/^const cssUrl = .*$/m)![0],
  between('function photoMedia(', '\n}\n') + '\n}',
  between('function initialsOf(', '\n}\n') + '\n}',
  between('function avatarHtml(', '\n}\n') + '\n}',
  between('function renderBubbleContent(', '// Sending Messages & Clipboard Paste'),
  'globalThis.esc = esc; globalThis.cssUrl = cssUrl;'
].join('\n');
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attrsOf = (html: string) => Object.fromEntries([...html.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], decode(m[2])]));
function page() {
  const context = vm.createContext({ parseAttachment: (x: unknown) => (typeof x === 'string' && x.startsWith('{') ? JSON.parse(x) : null), linkify: String, URL, encodeURIComponent });
  vm.runInContext(helpers, context);
  return context;
}

test('esc escapes both quote kinds', () => {
  assert.equal(page().esc(`a'b"c<d>&`), 'a&#39;b&quot;c&lt;d&gt;&amp;');
});

test('photo bubbles load only daemon media, never a received URL, and carry no inline handler', () => {
  const ctx = page();
  for (const token of ["https://photo.example/a');globalThis.compromised=true;//", 'http://127.0.0.1:1/x.png', "data:image/png;base64,a');x//", 'javascript:alert(1)']) {
    const html: string = ctx.renderBubbleContent({ type: 2, chatId: '123', messageId: '9', attachment: JSON.stringify({ k: token }) });
    assert.doesNotMatch(html, /<img|on\w+=/i, token);
  }
  const html: string = ctx.renderBubbleContent({ type: 2, chatId: '123', messageId: '9', attachment: JSON.stringify({ k: "opaque');x//" }) });
  assert.doesNotMatch(html, /\son\w+=|\ssrc=|style=/i);
  const attrs = attrsOf(html);
  const full = `/api/media?chatId=123&token=${encodeURIComponent("opaque');x//")}&messageId=9`;
  assert.equal(attrs['data-full-url'], full);
  assert.equal(attrs['data-media-src'], `${full}&mini=1`);
});

test('avatars accept only https images off this machine and never build a style attribute', () => {
  const ctx = page();
  const evil = "https://cdn.example/a.png');position:fixed;inset:0;z-index:99999;background:url('https://evil.example/x";
  const html: string = ctx.avatarHtml('n', evil);
  assert.doesNotMatch(html, /style=/);
  assert.equal(new URL(attrsOf(html).src).hostname, 'cdn.example', 'the URL stays one attribute value');
  assert.equal(attrsOf(ctx.avatarHtml('n', 'http://cdn.example/p.jpg')).src, 'https://cdn.example/p.jpg', 'upgraded to https');
  for (const bad of ['http://127.0.0.1:9/a.png', 'https://localhost/a', 'javascript:alert(1)', 'data:image/svg+xml,<svg>', 'https://u:p@cdn.example/a', '/api/state']) {
    assert.doesNotMatch(ctx.avatarHtml('n', bad), /<img/, bad);
  }
  assert.equal(ctx.cssUrl("a\") ; x:url('b"), 'url("a\\") ; x:url(\'b")', 'a CSS string, quotes escaped');
});

test('the page never interpolates URLs into style attributes, never loads preview images and has no inline handlers', () => {
  assert.doesNotMatch(source, /style="[^"]*url\(/, 'no url() inside a style attribute in generated markup');
  assert.doesNotMatch(source, /url\('\$\{/, 'no url() built by string concatenation');
  assert.doesNotMatch(source, /og\.image/, 'link previews show no remote image');
  assert.doesNotMatch(source, /\son(click|error|load|mouseover)="/, 'no inline event handler (script-src \'self\')');
  assert.doesNotMatch(source, /new EventSource\(/, 'the event stream is read with the token header');
  assert.doesNotMatch(source.replace(/async function apiFetch[\s\S]*?\n}\n/, ''), /[^.\w]fetch\(/, 'every API call goes through apiFetch');
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /\son\w+="/i); assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)/i, 'no inline script');
});

test('opening a room never fetches a received link; the preview loads only on click', async () => {
  const code = [
    source.match(/^const esc = .*$/m)![0],
    between('const URL_RE = ', 'function renderBubbleContent(')
  ].join('\n');
  const calls: string[] = [];
  const element = () => {
    const el: any = { listeners: {} as Record<string, () => void>, children: [] as unknown[], disabled: false, textContent: '',
      addEventListener(type: string, fn: () => void) { el.listeners[type] = fn; },
      replaceWith(other: unknown) { el.replacedBy = other; } };
    return el;
  };
  const wrap: any = { appended: [] as any[], querySelector: () => null, appendChild(child: unknown) { wrap.appended.push(child); } };
  const row = { dataset: { msgId: '1' }, querySelector: () => wrap };
  const context = vm.createContext({
    URL, encodeURIComponent, document: { createElement: element },
    api: async (path: string) => { calls.push(path); return { url: 'https://site.example/a', title: 'Fixture <b>title</b>' }; }
  });
  vm.runInContext(code + '\nglobalThis.maybeRenderLinkPreview = maybeRenderLinkPreview;', context);
  context.maybeRenderLinkPreview(row, { type: 1, text: 'see https://site.example/a now' });
  context.maybeRenderLinkPreview(row, { type: 2, text: 'https://site.example/photo' });
  assert.equal(calls.length, 0, 'rendering a message contacts no linked site');
  assert.equal(wrap.appended.length, 1, 'one load button for the text message with a link');
  const button = wrap.appended[0];
  assert.equal(button.textContent, '미리보기 불러오기');
  button.listeners.click();
  button.listeners.click(); // a second click while loading does not fetch twice
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [`/api/og?url=${encodeURIComponent('https://site.example/a')}`]);
  assert.match(button.replacedBy.innerHTML, /Fixture &lt;b&gt;title&lt;\/b&gt;/, 'preview text is escaped');
});
