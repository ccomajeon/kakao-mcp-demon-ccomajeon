// Bounded live event stream. Sequence numbers never depend on physical ring positions.
import type { IncomingMessage, ReadReceipt } from '@kakao-mcp/protocol';
import { KakaoError } from './errors.ts';

export interface BufferedMessage extends IncomingMessage {
  seq: number;
  authorName?: string;
}
export const MESSAGE_BUFFER_MAX = 500;

export class MessageFeed {
  private readonly slots: BufferedMessage[] = [];
  private readonly capacity: number;
  private start = 0;
  private size = 0;
  private sequence = 0;
  private readonly waiters = new Set<() => void>();
  private readonly listeners = new Set<(chatId: string) => void>();

  constructor(max = MESSAGE_BUFFER_MAX) {
    if (!Number.isSafeInteger(max) || max < 1) {
      throw new KakaoError('CONFIG_INVALID', 'Message feed capacity must be a positive safe integer');
    }
    this.capacity = max;
  }

  get cursor(): number { return this.sequence; }

  onMessage(listener: (chatId: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  push(message: IncomingMessage & { authorName?: string }): BufferedMessage {
    const item = { ...message, seq: ++this.sequence };
    this.append(item);
    for (const listener of [...this.listeners]) listener(String(item.chatId));
    return item;
  }

  pushReadReceipt(receipt: ReadReceipt): BufferedMessage | undefined {
    if (!receipt.chatId || !receipt.watermark) return undefined;
    const item: BufferedMessage = {
      seq: ++this.sequence, chatId: String(receipt.chatId), authorId: receipt.userId || '',
      type: -1, text: '', sendAt: Math.floor(Date.now() / 1000),
      raw: { isReadReceipt: true, watermark: String(receipt.watermark), userId: receipt.userId }
    };
    this.append(item);
    return item;
  }

  recent(sinceSeq = 0, chatId?: string): BufferedMessage[] {
    const result: BufferedMessage[] = [];
    for (let offset = 0; offset < this.size; offset++) {
      const item = this.slots[(this.start + offset) % this.capacity];
      if (item.seq > sinceSeq && (!chatId || item.chatId === chatId)) result.push(item);
    }
    return result;
  }

  async wait(sinceSeq: number, timeoutMs: number, chatId?: string): Promise<BufferedMessage[]> {
    const available = this.recent(sinceSeq, chatId);
    if (available.length) return available;
    return new Promise(resolve => {
      const complete = (items: BufferedMessage[]) => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve(items);
      };
      const wake = () => {
        const items = this.recent(sinceSeq, chatId);
        if (items.length) complete(items);
      };
      const timer = setTimeout(() => complete(this.recent(sinceSeq, chatId)), Math.max(0, timeoutMs));
      this.waiters.add(wake);
    });
  }

  private append(item: BufferedMessage): void {
    if (this.size < this.capacity) {
      this.slots[(this.start + this.size) % this.capacity] = item;
      this.size++;
    } else {
      this.slots[this.start] = item;
      this.start = (this.start + 1) % this.capacity;
    }
    for (const wake of [...this.waiters]) wake();
  }
}
