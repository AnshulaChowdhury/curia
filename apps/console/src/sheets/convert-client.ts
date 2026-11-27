// Converts a spreadsheet file by asking the sandboxed converter frame. One frame per file, removed afterwards.

import { CONVERTER_PATH, type FromConverter, type ToConverter } from './protocol.js';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const CONVERT_TIMEOUT_MS = 30_000;

/** Why a file cannot be accepted, or null. */
export function fileProblem(file: { name: string; size: number }): string | null {
  if (!/\.(xlsx|csv)$/i.test(file.name)) return 'Choose an .xlsx or .csv file. Old .xls and macro files are not accepted.';
  if (file.size === 0) return 'That file is empty.';
  if (file.size > MAX_FILE_BYTES) return 'That file is larger than 2 MB.';
  return null;
}

export async function convertFile(file: File, doc: Document = document, timeoutMs = CONVERT_TIMEOUT_MS): Promise<unknown> {
  const problem = fileProblem(file);
  if (problem) throw new Error(problem);
  const bytes = await file.arrayBuffer();
  const frame = doc.createElement('iframe');
  // Without allow-same-origin the frame cannot read cookies, storage or this page.
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('aria-hidden', 'true');
  frame.className = 'sheet-converter';
  frame.src = CONVERTER_PATH;
  const view = doc.defaultView!;
  return new Promise((resolve, reject) => {
    const end = (settle: () => void) => {
      view.clearTimeout(timer);
      view.removeEventListener('message', onMessage);
      frame.remove();
      settle();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      const message = event.data as FromConverter;
      if (message?.kind === 'ready') {
        const request: ToConverter = { kind: 'convert', name: file.name, bytes };
        frame.contentWindow!.postMessage(request, '*', [bytes]);
      } else if (message?.kind === 'done') end(() => resolve(message.workbook));
      else if (message?.kind === 'failed') end(() => reject(new Error(`That file could not be read. ${message.message}`)));
    };
    const timer = view.setTimeout(() => end(() => reject(new Error('Reading that file took too long.'))), timeoutMs);
    view.addEventListener('message', onMessage);
    doc.body.appendChild(frame);
  });
}
