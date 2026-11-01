// ----------------------------------------------------------------------------
// OpenGraph link-preview scraper for the chat feed.
//
// KakaoTalk's PC client renders a preview card (title / description / image) for
// URLs shared in a chat. That scraping is a *client* concern here (not a LOCO
// command), so the local dev server fetches the target page and extracts its
// OpenGraph / basic meta tags. Binds nothing new — just an HTTP GET with a short
// timeout and a size cap, reachable only from the localhost-only web UI.
// Link URLs come from received messages (untrusted): every hop, redirects included,
// must resolve only to public addresses, so a message cannot make this machine
// request its own loopback or LAN services.
// ----------------------------------------------------------------------------
import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

export interface OgPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

const MAX_BYTES = 512 * 1024; // only need the <head>; cap the download
const TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 3;

// Loopback, private, shared (CGNAT), link-local, benchmark, multicast/reserved, and IPv4-mapped IPv6.
const NON_PUBLIC = new net.BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]] as const) NON_PUBLIC.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 127], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) NON_PUBLIC.addSubnet(address, prefix, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  // IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:7f00:1) is judged by its IPv4 address.
  const mapped = family === 6 ? address.toLowerCase().match(/^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/) : null;
  if (mapped) {
    const v4 = mapped[1] ?? [parseInt(mapped[2], 16) >> 8, parseInt(mapped[2], 16) & 255, parseInt(mapped[3], 16) >> 8, parseInt(mapped[3], 16) & 255].join('.');
    return isPublicAddress(v4);
  }
  return family !== 0 && !NON_PUBLIC.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

export interface OgDeps {
  lookup?: (host: string) => Promise<string[]>;
  fetch?: typeof fetch;
}
const systemLookup = async (host: string) => (await dnsLookup(host, { all: true, verbatim: true })).map(a => a.address);

/** Refuse a URL unless it is http(s) and its host resolves only to public addresses. */
async function assertPublicUrl(u: URL, lookup: (host: string) => Promise<string[]>): Promise<string[]> {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('unsupported scheme');
  if (u.username || u.password) throw new Error('URL credentials are not supported');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase(); // IPv6 literals keep their brackets in URL.hostname
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('blocked host');
  const addresses = net.isIP(host) ? [host] : await lookup(host).catch(() => []);
  if (!addresses.length || !addresses.every(isPublicAddress)) throw new Error('blocked host');
  return addresses;
}

/** Keep the original hostname for Host, TLS SNI and certificate checks, but connect only to
 * the address we checked. A second DNS lookup here would let a rebinding host reach the LAN. */
function fetchPinned(u: URL, addresses: string[], init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = u.protocol === 'https:' ? https.request : http.request;
    const req = request(u, {
      agent: false,
      signal: init.signal ?? undefined,
      headers: init.headers as Record<string, string>,
      lookup: (_host, options, callback) => {
        const records = addresses.map(address => ({ address, family: net.isIP(address) }));
        if (options.all) callback(null, records);
        else callback(null, records[0].address, records[0].family);
      }
    }, res => {
      try {
        const headers = new Headers();
        for (let i = 0; i < res.rawHeaders.length; i += 2) headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
        const status = res.statusCode ?? 502;
        const noBody = status === 204 || status === 205 || status === 304;
        if (noBody) res.resume();
        resolve(new Response(noBody ? null : Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, headers }));
      } catch (error) { res.destroy(); reject(error); }
    });
    req.on('error', reject);
    req.end();
  });
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

/** Extract a single meta tag's content by property/name, order-independent on attributes. */
function metaContent(html: string, key: string): string | undefined {
  // matches <meta property="og:title" content="..."> and the reversed attribute order
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${key}["']`, 'i')
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return decodeEntities(m[1]).trim();
  }
  return undefined;
}

export function parseOg(html: string, url: string): OgPreview {
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const preview: OgPreview = {
    url,
    title: metaContent(html, 'og:title') || (titleTag ? decodeEntities(titleTag[1]).trim() : undefined),
    description: metaContent(html, 'og:description') || metaContent(html, 'description'),
    image: metaContent(html, 'og:image'),
    siteName: metaContent(html, 'og:site_name')
  };
  // Resolve a relative og:image against the page URL.
  if (preview.image && !/^https?:\/\//i.test(preview.image)) {
    try {
      preview.image = new URL(preview.image, url).toString();
    } catch {
      delete preview.image;
    }
  }
  return preview;
}

export async function fetchOg(rawUrl: string, deps: OgDeps = {}): Promise<OgPreview> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('invalid url');
  }
  const lookup = deps.lookup ?? systemLookup;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let res: Response | undefined;
    // Follow redirects by hand so each target is checked before it is requested.
    for (let hop = 0; ; hop++) {
      const addresses = await assertPublicUrl(u, lookup);
      const init: RequestInit = {
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          // some sites gate OG tags on a browser-ish UA
          'User-Agent': 'Mozilla/5.0 (compatible; kakao-mcp-web-preview/1.0)',
          'Accept-Encoding': 'identity',
          Accept: 'text/html,application/xhtml+xml'
        }
      };
      res = deps.fetch ? await deps.fetch(u.toString(), init) : await fetchPinned(u, addresses, init);
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) break;
      await res.body?.cancel();
      if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
      u = new URL(location, u);
    }
    if (!res) return { url: u.toString() };
    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('html')) { await res.body?.cancel(); return { url: u.toString() }; }
    const encoding = res.headers.get('content-encoding')?.toLowerCase();
    if (encoding && encoding !== 'identity') {
      await res.body?.cancel();
      throw new Error('unsupported content encoding');
    }
    // read at most MAX_BYTES
    const reader = res.body?.getReader();
    if (!reader) return { url: u.toString() };
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.length;
        if (total >= MAX_BYTES) {
          await reader.cancel();
          break;
        }
      }
    }
    const html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf-8');
    return parseOg(html, u.toString());
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
