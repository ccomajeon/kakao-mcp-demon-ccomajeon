import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the actual photo renderer and its generated event handler. Decode attributes as HTML
// does before compiling the handler, so escaping a quote as an HTML entity cannot hide an exploit.
const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const renderer = source.slice(source.indexOf('function renderBubbleContent('), source.indexOf('// Sending Messages & Clipboard Paste'));
const escape = source.match(/^const esc = .*$/m)![0];
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

test('photo clicks treat received attachment URLs as data, never JavaScript', () => {
  for (const token of ["https://photo.example/a');globalThis.compromised=true;//", "data:image/png;base64,a');globalThis.compromised=true;//", "opaque');globalThis.compromised=true;//"]) {
    const context = vm.createContext({ parseAttachment: JSON.parse, linkify: String, compromised: false, opened: undefined });
    vm.runInContext(escape + '\n' + renderer + '\nfunction openLightbox(url) { globalThis.opened = url; }', context);
    const html: string = context.renderBubbleContent({ type: 2, chatId: '123', attachment: JSON.stringify({ k: token }) });
    const attrs = Object.fromEntries([...html.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], decode(m[2])]));
    context.element = { dataset: { fullUrl: attrs['data-full-url'] } };
    vm.runInContext(`(function () { ${attrs.onclick}
}).call(element)`, context);
    assert.equal(context.compromised, false, 'clicking an untrusted image must not execute its token');
    assert.equal(context.opened, token.startsWith('http') || token.startsWith('data:') ? token : `/api/media?chatId=123&token=${encodeURIComponent(token)}`);
  }
});
