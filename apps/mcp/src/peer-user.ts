// Which OS user opened a loopback TCP connection to the daemon (Linux /proc/net/tcp{,6}).
//
// Loopback keeps the network out, but not other users and services on the same host. MCP itself has no
// authentication, and the client confirmation dialog trusts the client to show it to a person: a local
// process that connects can read the code and answer the dialog itself. So the daemon accepts a TCP
// connection only from allowed OS users. An `ssh -W` tunnel arrives as the SSH login user, so client
// settings do not change. Unix sockets are limited by their private directory instead.
import fs from 'node:fs';
import type net from 'node:net';

/** Kernel hex form of an IPv4 address in /proc/net/tcp: "0100007F" for 127.0.0.1 (also from "::ffff:127.0.0.1"). */
function ipv4Hex(address: string): string | undefined {
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(address);
  if (!v4 || v4.slice(1).some(n => Number(n) > 255)) return undefined;
  return v4.slice(1).reverse().map(n => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase();
}
/** The 16 bytes of an IPv6 address (IPv4 addresses as IPv4-mapped), or undefined when it does not parse. */
function ipv6Bytes(address: string): number[] | undefined {
  const plain = address.replace(/%.*$/, '');
  if (ipv4Hex(plain) && !plain.includes(':')) return ipv6Bytes(`::ffff:${plain}`);
  const tail = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(plain);
  let text = plain;
  if (tail) {
    const v4 = tail[2].split('.').map(Number);
    if (v4.some(n => n > 255)) return undefined;
    text = `${tail[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const groups = (part: string) => part === '' ? [] : part.split(':');
  const head = groups(halves[0]), rest = halves.length === 2 ? groups(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return undefined;
  const words = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...rest];
  if (words.some(w => !/^[0-9a-f]{1,4}$/i.test(w))) return undefined;
  return words.flatMap(w => { const n = parseInt(w, 16); return [n >> 8, n & 0xff]; });
}
/** Kernel hex form of an IPv6 address in /proc/net/tcp6: four 32-bit words, each in host (little-endian) byte order. */
function ipv6Hex(address: string): string | undefined {
  const bytes = ipv6Bytes(address);
  if (!bytes) return undefined;
  let out = '';
  for (let i = 0; i < 16; i += 4) out += bytes.slice(i, i + 4).reverse().map(b => b.toString(16).padStart(2, '0')).join('');
  return out.toUpperCase();
}
const ESTABLISHED = '01';

export interface PeerConnection { remoteAddress: string; remotePort: number; localAddress: string; localPort: number }

/**
 * Every uid owning a live socket whose local endpoint is the peer's and whose remote endpoint is exactly ours.
 * Only ESTABLISHED rows with an inode count: the kernel prints uid 0 and inode 0 for TIME_WAIT rows, which
 * anyone can leave behind with the same peer port, so those must never vouch for a connection.
 */
function procNetUids(text: string, conn: PeerConnection): number[] {
  const port = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');
  const endpoints = { 8: [ipv4Hex(conn.remoteAddress), ipv4Hex(conn.localAddress)], 32: [ipv6Hex(conn.remoteAddress), ipv6Hex(conn.localAddress)] } as Record<number, Array<string | undefined>>;
  const uids: number[] = [];
  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10) continue;
    const [localAddr, localPort] = cols[1].split(':'), [remoteAddr, remotePort] = cols[2].split(':');
    if (cols[3] !== ESTABLISHED || !/^[1-9]\d*$/.test(cols[9])) continue;
    if (localPort !== port(conn.remotePort) || remotePort !== port(conn.localPort)) continue;
    const [peer, self] = endpoints[localAddr.length] ?? [];
    if (!peer || !self || localAddr.toUpperCase() !== peer || remoteAddr?.toUpperCase() !== self) continue;
    const uid = Number(cols[7]);
    if (Number.isSafeInteger(uid) && uid >= 0) uids.push(uid);
  }
  return uids;
}

/**
 * The uid owning the client end of this connection, from /proc/net/tcp text: the one ESTABLISHED row whose
 * local endpoint is the peer's and whose remote endpoint is ours. Undefined when no row, or more than one, matches.
 */
export function uidFromProcNet(text: string, conn: PeerConnection): number | undefined {
  const uids = procNetUids(text, conn);
  return uids.length === 1 ? uids[0] : undefined;
}

export function peerUid(socket: net.Socket, read: (file: string) => string = file => fs.readFileSync(file, 'utf8')): number | undefined {
  if (!socket.remoteAddress || !socket.remotePort || !socket.localAddress || !socket.localPort) return undefined;
  const conn = { remoteAddress: socket.remoteAddress, remotePort: socket.remotePort, localAddress: socket.localAddress, localPort: socket.localPort };
  const uids: number[] = [];
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string;
    try { text = read(file); } catch { continue; }
    uids.push(...procNetUids(text, conn));
  }
  // Exactly one live client socket: an ambiguous answer is refused rather than guessed.
  return uids.length === 1 ? uids[0] : undefined;
}

/** The daemon's own user and root are always allowed; `extra` comes from KAKAO_MCP_ALLOWED_UIDS. */
export function allowedUids(extra: readonly number[], self: number): Set<number> {
  return new Set([self, 0, ...extra]);
}
