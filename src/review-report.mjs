import fs from 'node:fs';

const pause = new Int32Array(new SharedArrayBuffer(4));

export function writeReviewReport(filename, report) {
  const temporary = filename + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(report, null, 2));
  // On Windows a concurrent reader/virus scanner can briefly hold the destination.
  // Keep the previous complete snapshot visible and bound retries to 200 ms.
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(temporary, filename); return; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 20) throw error;
      Atomics.wait(pause, 0, 0, 10);
    }
  }
}
