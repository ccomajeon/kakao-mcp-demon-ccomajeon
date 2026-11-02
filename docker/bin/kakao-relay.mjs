// Relays the container's published port to the web GUI, which only binds 127.0.0.1.
// Usage: node kakao-relay.mjs <listen-port> <target-port>
import net from 'node:net';

const [listenPort, targetPort] = process.argv.slice(2).map(Number);
if (!Number.isInteger(listenPort) || !Number.isInteger(targetPort)) {
  console.error('usage: kakao-relay.mjs <listen-port> <target-port>');
  process.exit(2);
}

net.createServer((client) => {
  const upstream = net.connect(targetPort, '127.0.0.1');
  client.pipe(upstream).pipe(client);
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
}).listen(listenPort, '0.0.0.0');
