// Runs the third-party spreadsheet converter, alone, in a sandboxed frame with no network and no access to the console
// (the server sends that policy with this page). It takes one file's bytes from the page that framed it and hands back
// the converted workbook. Nothing it returns is trusted: the server cleans it before storing it.

import LuckyExcel from '@zwight/luckyexcel';
import type { FromConverter, ToConverter } from './protocol.js';
import { numbersFromText } from './csv-numbers.js';
import { trimBlanks } from './trim-blanks.js';

function convert(name: string, bytes: ArrayBuffer): Promise<unknown> {
  const file = new File([bytes], name);
  const csv = name.toLowerCase().endsWith('.csv');
  return new Promise((resolve, reject) => {
    const done = (workbook: unknown) => resolve(trimBlanks(csv ? numbersFromText(workbook) : workbook));
    const failed = (error: unknown) => reject(error instanceof Error ? error : new Error(String(error)));
    if (csv) LuckyExcel.transformCsvToUniver(file, done, failed);
    else LuckyExcel.transformExcelToUniver(file, done, failed);
  });
}

function serve(port: MessagePort): void {
  const reply = (message: FromConverter) => port.postMessage(message);
  port.onmessage = event => {
    const message = event.data as ToConverter;
    if (message?.kind !== 'convert' || typeof message.name !== 'string' || !(message.bytes instanceof ArrayBuffer)) return;
    convert(message.name, message.bytes).then(
      workbook => reply({ kind: 'done', workbook: JSON.parse(JSON.stringify(workbook)) as unknown }),
      (error: Error) => reply({ kind: 'failed', message: String(error.message).slice(0, 200) }),
    );
  };
}

if (window.parent !== window) {
  const channel = new MessageChannel();
  serve(channel.port1);
  const ready: FromConverter = { kind: 'ready' };
  // The other end of the channel goes only to a page of this site. (This frame is sandboxed and has no origin of its
  // own, but location.origin still names the site it was loaded from.)
  window.parent.postMessage(ready, window.location.origin, [channel.port2]);
}
