// Runs link-scanning cases off the main thread, so a case that never ends can
// be stopped (the worker is terminated) and named. Posts { i } before each case.
import { parentPort, workerData } from 'node:worker_threads';
import { collectLinks, scan, unlink } from '../../extension/lib/links.js';

for (const [i, text] of workerData.cases.entries()) {
  parentPort.postMessage({ i });
  let last = -1;
  scan(text, (kind, url, start, end) => {
    if (!(start > last && end > start)) throw new Error(`case ${i}: no progress at ${start}..${end}`);
    last = start;
  });
  collectLinks([text]);
  unlink(text, new Set());
}
parentPort.postMessage({ done: true });
