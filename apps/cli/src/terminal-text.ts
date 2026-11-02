import { stripVTControlCharacters } from 'node:util';
export interface DisplayOptions { demo?: boolean; showRoom?: string; }
/** Titles, names and messages are data, never terminal escape sequences or commands. */
export function terminalText(value: unknown): string {
  return stripVTControlCharacters(String(value ?? ''))
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200c\u200e\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g,
      c => c === '\n' || c === '\r' ? ' ↵ ' : `⟦${c.codePointAt(0)!.toString(16)}⟧`);
}
/** Pretty JSON for the terminal: JSON already escapes C0 controls; C1, bidi and invisible characters become \u escapes too. */
export function terminalJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replace(/[\u007f-\u009f\u061c\u200b\u200c\u200e\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, c => `\\u${c.codePointAt(0)!.toString(16).padStart(4, '0')}`);
}
