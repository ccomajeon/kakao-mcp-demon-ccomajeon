import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { McpStdioServer } from './mcp-stdio.ts';
import { serveSocket } from './socket-transport.ts';
import { allowedUids, peerUid, uidFromProcNet } from './peer-user.ts';

// /proc/net/tcp rows: client 127.0.0.1:51000 -> daemon 127.0.0.1:18787 as uid 1000, plus the daemon's own row and noise.
const HEAD = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
const TCP = HEAD +
  '   0: 0100007F:4963 00000000:0000 0A 00000000:00000000 00:00000000 00000000   998        0 1 1 0 100 0 0 10 0\n' +
  '   1: 0100007F:C738 0100007F:4963 01 00000000:00000000 00:00000000 00000000  1000        0 2 1 0 20 4 30 10 -1\n' +
  '   2: 0100007F:4963 0100007F:C738 01 00000000:00000000 00:00000000 00000000   998        0 3 1 0 20 4 30 10 -1\n' +
  '   3: 0A000002:C738 0A000009:4963 01 00000000:00000000 00:00000000 00000000  1001        0 4 1 0 20 4 30 10 -1\n';

const conn = (remoteAddress: string, remotePort = 51000, localAddress = '127.0.0.1', localPort = 18787) => ({ remoteAddress, remotePort, localAddress, localPort });
const row = (sl: number, local: string, remote: string, st: string, uid: number, inode: number) =>
  `   ${sl}: ${local} ${remote} ${st} 00000000:00000000 00:00000000 00000000 ${String(uid).padStart(5)}        0 ${inode} 1 0 20 4 30 10 -1\n`;

test('the client end of a loopback connection is found by its exact endpoint', () => {
  assert.equal(uidFromProcNet(TCP, conn('127.0.0.1')), 1000);
  assert.equal(uidFromProcNet(TCP, conn('::ffff:127.0.0.1', 51000, '::ffff:127.0.0.1')), 1000);
  assert.equal(uidFromProcNet(TCP, conn('127.0.0.2')), undefined, 'same ports, other address');
  assert.equal(uidFromProcNet(TCP, conn('127.0.0.1', 51001)), undefined);
  const tcp6 = HEAD + '   0: 00000000000000000000000001000000:C738 00000000000000000000000001000000:4963 01 00000000:00000000 00:00000000 00000000  1002 0 5\n';
  assert.equal(uidFromProcNet(tcp6, conn('::1', 51000, '::1')), 1002);
  assert.deepEqual([...allowedUids([1000, 1000], 998)].sort((a, b) => a - b), [0, 998, 1000]);
});

test('a leftover TIME_WAIT row (printed as uid 0) never vouches for a connection from the same peer port', () => {
  // Another user's old connection 127.0.0.1:51000 -> 127.0.0.2:18787 in TIME_WAIT, listed before the real ESTABLISHED one.
  const timeWait = row(0, '0100007F:C738', '0200007F:4963', '06', 0, 0);
  const real = row(1, '0100007F:C738', '0100007F:4963', '01', 1001, 4242);
  assert.equal(uidFromProcNet(HEAD + timeWait + real, conn('127.0.0.1')), 1001, 'the live row decides, not the first port match');
  // Even with the right remote address, a TIME_WAIT (or any non-ESTABLISHED) row and a row without an inode are ignored.
  assert.equal(uidFromProcNet(HEAD + row(0, '0100007F:C738', '0100007F:4963', '06', 0, 0), conn('127.0.0.1')), undefined);
  assert.equal(uidFromProcNet(HEAD + row(0, '0100007F:C738', '0100007F:4963', '08', 0, 7), conn('127.0.0.1')), undefined);
  assert.equal(uidFromProcNet(HEAD + row(0, '0100007F:C738', '0100007F:4963', '01', 0, 0), conn('127.0.0.1')), undefined);
});

test('the row must point at the daemon\'s own address, and an ambiguous answer is refused', () => {
  const elsewhere = row(0, '0100007F:C738', '0200007F:4963', '01', 0, 11);
  assert.equal(uidFromProcNet(HEAD + elsewhere, conn('127.0.0.1')), undefined, 'a connection to another local listener on the same port');
  assert.equal(uidFromProcNet(HEAD + elsewhere, conn('127.0.0.1', 51000, '127.0.0.2')), 0, 'it is the daemon\'s own when the daemon listens there');
  const twice = row(0, '0100007F:C738', '0100007F:4963', '01', 1000, 12) + row(1, '0100007F:C738', '0100007F:4963', '01', 0, 13);
  assert.equal(uidFromProcNet(HEAD + twice, conn('127.0.0.1')), undefined, 'two live rows for one endpoint');
});

test('tcp6 rows match IPv6 and IPv4-mapped endpoints exactly', () => {
  const mappedPeer = '0000000000000000FFFF00000100007F', mappedOther = '0000000000000000FFFF00000200007F', loop6 = '00000000000000000000000001000000';
  const mapped = conn('::ffff:127.0.0.1', 51000, '::ffff:127.0.0.1');
  assert.equal(uidFromProcNet(HEAD + row(0, `${mappedPeer}:C738`, `${mappedPeer}:4963`, '01', 1003, 21), mapped), 1003);
  assert.equal(uidFromProcNet(HEAD + row(0, `${mappedPeer}:C738`, `${mappedOther}:4963`, '01', 0, 22), mapped), undefined, 'mapped, other remote address');
  assert.equal(uidFromProcNet(HEAD + row(0, `${mappedPeer}:C738`, `${mappedPeer}:4963`, '06', 0, 0) + row(1, `${mappedPeer}:C738`, `${mappedPeer}:4963`, '01', 1003, 23), mapped), 1003);
  assert.equal(uidFromProcNet(HEAD + row(0, `${loop6}:C738`, `${mappedPeer}:4963`, '01', 0, 24), mapped), undefined, '::1 is not the mapped peer');
  assert.equal(uidFromProcNet(HEAD + row(0, `${loop6}:C738`, `${loop6}:4963`, '01', 1004, 25), conn('::1', 51000, '0:0:0:0:0:0:0:1')), 1004);
});

test('peerUid counts matches across tcp and tcp6 and refuses duplicates', () => {
  const socket = { remoteAddress: '::ffff:127.0.0.1', remotePort: 51000, localAddress: '::ffff:127.0.0.1', localPort: 18787 } as net.Socket;
  const mapped = '0000000000000000FFFF00000100007F';
  const v4 = HEAD + row(0, '0100007F:C738', '0100007F:4963', '01', 1000, 31);
  const v6 = HEAD + row(0, `${mapped}:C738`, `${mapped}:4963`, '01', 0, 32);
  assert.equal(peerUid(socket, file => file.endsWith('6') ? HEAD : v4), 1000);
  assert.equal(peerUid(socket, file => file.endsWith('6') ? v6 : HEAD), 0);
  assert.equal(peerUid(socket, file => file.endsWith('6') ? v6 : v4), undefined);
  assert.equal(peerUid(socket, () => { throw new Error('no procfs'); }), undefined);
});

test('a connection from an OS user that is not allowed is closed before any MCP exchange', async t => {
  const server = new McpStdioServer({ name: 'peer-fixture', version: '0' });
  const logs: string[] = [];
  let uid = 1001;
  const srv = serveSocket(server, { host: '127.0.0.1', port: 0 }, { allowedUids: new Set([0, 998, 1000]), peerUid: () => uid, log: l => logs.push(l) });
  t.after(() => srv.close());
  await new Promise<void>(resolve => srv.once('listening', () => resolve()));
  const port = (srv.address() as net.AddressInfo).port;
  const exchange = () => new Promise<string>(resolve => {
    const c = net.connect(port, '127.0.0.1'); let text = '';
    c.on('data', d => { text += d; if (text.includes('\n')) c.end(); });
    c.on('close', () => resolve(text)); c.on('error', () => resolve(text));
    c.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  });
  assert.equal(await exchange(), '', 'refused user gets nothing');
  assert.ok(logs.some(l => l.includes('refused connection from OS user 1001')));
  uid = 1000;
  assert.ok(JSON.parse(await exchange()).result, 'the allowed operator is served');
});
