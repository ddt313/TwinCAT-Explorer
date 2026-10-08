// Optional trace for diagnosing event timing; enabled with the TWINCAT_DEBUG_LOG environment variable.
import * as fs from 'fs';

const target = process.env.TWINCAT_DEBUG_LOG;

export function debugLog(message: string): void {
  if (!target) return;
  try {
    fs.appendFileSync(target, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // ignore
  }
}
