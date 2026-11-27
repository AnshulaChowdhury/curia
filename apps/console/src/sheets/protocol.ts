// The messages between the sheet page and the sandboxed converter frame. The frame sends 'ready' with one end of a
// MessageChannel; everything else travels over that channel.

export const CONVERTER_PATH = '/budget/convert-frame';

export type ToConverter = { kind: 'convert'; name: string; bytes: ArrayBuffer };
export type FromConverter =
  | { kind: 'ready' }
  | { kind: 'done'; workbook: unknown }
  | { kind: 'failed'; message: string };
