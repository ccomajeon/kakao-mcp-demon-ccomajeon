import net from 'node:net';
import tls from 'node:tls';
import { BSON } from 'bson';
import { encodeLocoPacket, decodeLocoPacket, LocoPacket } from '../framing/loco-packet.js';
import { createLocoV2Handshake, encryptLocoV2Frame } from '../crypto/loco-crypto.js';
import { LocoError } from '../errors/loco-error.js';
import { ByteQueue, LocoStreamDecoder, takeLocoPacket } from './loco-stream.js';

/**
 * Run a one-shot LOCO exchange on `socket` (the request is written by the caller's connect callback):
 * resolve with the first complete response packet, and fail cleanly - never throw from the socket
 * listener - on a malformed or oversized frame, an error, an idle timeout or an early close.
 * `read` buffers received bytes and returns the packet bytes once complete.
 */
function exchange<T>(
  socket: net.Socket,
  command: string,
  timeoutMessage: string,
  read: (chunk: Buffer) => Buffer | null,
  build: (packet: LocoPacket) => T
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      if (err) {
        socket.destroy();
        reject(err);
      } else {
        socket.end(); // later bytes are ignored; the idle timeout destroys a peer that never closes
        resolve(value as T);
      }
    };
    socket.on('data', (chunk) => {
      if (settled) return;
      try {
        const bytes = read(chunk);
        if (bytes) finish(undefined, build(decodeLocoPacket(bytes)));
      } catch (err) {
        finish(err);
      }
    });
    socket.on('error', (err) => finish(err));
    socket.on('timeout', () => {
      socket.destroy();
      finish(new LocoError('TIMEOUT', timeoutMessage, { command }));
    });
    socket.on('close', () => finish(new LocoError('CLOSED', `${command} connection closed before a response`, { command })));
  });
}

export interface BookingTrailerConfig {
  tokenExpireTime: number;
  concurrentUpLimit: number;
}

export interface BookingResult {
  status: number;
  ticketHosts: string[];
  ports: number[];
  revision: number;
  raw: Record<string, unknown>;
}

export interface CheckinResult {
  status: number;
  chatHost?: string;
  chatPort?: number;
  raw: Record<string, unknown>;
}

export interface ConversationItem {
  id: string;
  type: string;
  unreadCount?: number;
  lastMessage?: string;
  lastSendAt?: number;
  lastMessageType?: number;
  memberCount?: number;
  raw: Record<string, unknown>;
}

export interface LoginListResult {
  status: number;
  revision: number;
  conversations: ConversationItem[];
  raw: Record<string, unknown>;
}

export class LocoClient {
  private appVersion: string;
  private os: string;

  constructor(appVersion = '26.4.0', os = 'mac') {
    this.appVersion = appVersion;
    this.os = os;
  }

  /**
   * 1. GETCONF from booking server over TLS
   */
  async getBookingConfig(host = 'booking-loco.kakao.com', port = 443): Promise<BookingResult> {
    const socket = tls.connect({ host, port, servername: host, timeout: 10000 }, () => {
      const req = {
        MCCMNC: '999',
        model: '',
        os: this.os
      };
      socket.write(encodeLocoPacket(1, 0, 'GETCONF', req));
    });
    const received = new ByteQueue();
    return exchange(socket, 'GETCONF', 'Booking connection timed out', (chunk) => {
      received.push(chunk);
      return takeLocoPacket(received);
    }, (decoded) => {
      const data = decoded.data as Record<string, any>;
      const ticketHosts = Array.isArray(data.ticket?.lsl) ? data.ticket.lsl : ['ticket-loco.kakao.com'];
      const ports = Array.isArray(data.wifi?.ports) ? data.wifi.ports : [5242];
      return {
        status: decoded.header.status,
        ticketHosts,
        ports,
        revision: Number(data.revision || 0),
        raw: data
      };
    });
  }

  /**
   * 2. CHECKIN to ticket server using LocoV2SL
   */
  async checkin(ticketHost: string, ticketPort: number, userId: string | number): Promise<CheckinResult> {
    const { handshakeBytes, aesKey } = createLocoV2Handshake();
    const socket = net.connect({ host: ticketHost, port: ticketPort, timeout: 10000 }, () => {
      const req = {
        MCCMNC: '999',
        appVer: this.appVersion,
        countryISO: 'KR',
        lang: 'ko',
        ntype: 0,
        useSub: true,
        os: this.os,
        userId: new BSON.Long(BigInt(userId))
      };
      const plainPacket = encodeLocoPacket(1, 0, 'CHECKIN', req);
      const encryptedFrame = encryptLocoV2Frame(plainPacket, aesKey);
      socket.write(Buffer.concat([Buffer.from(handshakeBytes), Buffer.from(encryptedFrame)]));
    });
    const decoder = new LocoStreamDecoder(aesKey);
    return exchange(socket, 'CHECKIN', 'Ticket checkin timed out', (chunk) => decoder.push(chunk)[0] ?? null, (decoded) => {
      const res = decoded.data as Record<string, any>;
      return {
        status: Number(res.status ?? decoded.header.status),
        chatHost: res.host,
        chatPort: res.port ? Number(res.port) : undefined,
        raw: res
      };
    });
  }

  /**
   * 3. Connect to chat carriage server and perform LOGINLIST
   */
  async loginList(
    chatHost: string,
    chatPort: number,
    userId: string | number,
    accessToken: string,
    deviceUUID: string
  ): Promise<LoginListResult> {
    const { handshakeBytes, aesKey } = createLocoV2Handshake();
    const socket = net.connect({ host: chatHost, port: chatPort, timeout: 10000 }, () => {
      const req = {
        appVer: this.appVersion,
        prtVer: '1',
        os: this.os,
        lang: 'ko',
        duuid: deviceUUID,
        oauthToken: accessToken,
        dtype: 2, // sub-device
        ntype: 0, // wifi
        MCCMNC: '999',
        revision: 0,
        chatIds: [],
        maxIds: [],
        lastTokenId: BSON.Long.ZERO,
        lbk: 0,
        bg: false
      };
      const plainPacket = encodeLocoPacket(1, 0, 'LOGINLIST', req);
      const encryptedFrame = encryptLocoV2Frame(plainPacket, aesKey);
      socket.write(Buffer.concat([Buffer.from(handshakeBytes), Buffer.from(encryptedFrame)]));
    });
    const decoder = new LocoStreamDecoder(aesKey);
    return exchange(socket, 'LOGINLIST', 'Carriage loginList timed out', (chunk) => decoder.push(chunk)[0] ?? null, (decoded) => {
      const res = decoded.data as Record<string, any>;
      const conversations: ConversationItem[] = [];
      if (Array.isArray(res.chatDatas)) {
        for (const c of res.chatDatas) {
          const last = c.l;
          const lastMsg = typeof last?.message === 'string' ? last.message : typeof last?.msg === 'string' ? last.msg : undefined;
          const lastSendAt = typeof last?.sendAt === 'number' ? last.sendAt : typeof last?.s === 'number' ? last.s : undefined;
          conversations.push({
            id: String(c.c || c.channelId || ''),
            type: String(c.t || c.type || ''),
            unreadCount: typeof c.n === 'number' ? c.n : typeof c.u === 'number' ? c.u : undefined,
            lastMessage: lastMsg,
            lastSendAt,
            lastMessageType: typeof last?.type === 'number' ? last.type : undefined,
            memberCount: typeof c.a === 'number' ? c.a : undefined,
            raw: c
          });
        }
      }
      return {
        status: Number(res.status ?? decoded.header.status),
        revision: Number(res.revision || 0),
        conversations,
        raw: res
      };
    });
  }
}
