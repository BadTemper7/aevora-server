import { spawn } from 'node:child_process';
import { AppError } from '../utils/AppError.js';

/** Optionally require a real ClamAV daemon / clamdscan before processing untrusted uploads. */
export async function scanUploadedFile(filename) {
  const mode = process.env.NODE_ENV === 'production' ? 'required' : (process.env.MALWARE_SCAN_MODE || 'disabled');
  if (mode === 'disabled') return;
  if (mode !== 'required') throw new AppError('Invalid malware scanner configuration.', 500);
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CLAMAV_COMMAND || 'clamdscan', ['--no-summary', filename], { stdio: ['ignore', 'pipe', 'pipe'] });
    let message = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.stdout.on('data', chunk => { message = (message + String(chunk)).slice(-500); });
    child.stderr.on('data', chunk => { message = (message + String(chunk)).slice(-500); });
    child.on('error', () => { clearTimeout(timeout); reject(new AppError('Malware scanner unavailable. Upload blocked.', 503)); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code === 0) return resolve();
      if (code === 1) return reject(new AppError('Potential malware detected. Upload rejected.', 415));
      reject(new AppError('Malware scanning failed. Upload blocked.', 503));
    });
  });
}
