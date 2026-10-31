// The TwinCAT licenses of the runtimes on this machine, read from their license files (*.tclrs): the 7-day trial
// license XAE generates, and license response files. TwinCAT 3.1.4026 keeps them per runtime under
// %ProgramData%\Beckhoff\TwinCAT\3.1\Runtimes\<runtime>\3.1\Target\License, 4024 under C:\TwinCAT\3.1\Target\License.
// Only read: a new trial license comes from XAE, whose dialog asks the user for a typed security code.

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { children, child, elementText, findAll, parseXml } from './xml';
import { decodeXml } from './libraries';

export interface TcLicense {
  id: string;
  name: string;
  orderNo?: string;
  instances?: number;
}

export interface LicenseFile {
  file: string;
  /** The runtime the file belongs to: `UmRT_Default`, or `TwinCAT` for 4024's single one. */
  runtime: string;
  trial: boolean;
  issued?: Date;
  /** Undefined: the file names no end. */
  expires?: Date;
  licenses: TcLicense[];
}

export interface LicenseFolder {
  runtime: string;
  folder: string;
}

/** A time of a license file: UTC without a zone (a trial generated at 11:41 UTC+7 is issued at 04:41). */
function utc(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const d = new Date(/(Z|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** A license file's content; undefined when it is not one. */
export function parseLicenseFile(text: string, file: string, runtime: string): LicenseFile | undefined {
  let info;
  try {
    info = child(parseXml(text), 'TcLicenseInfo');
  } catch {
    return undefined;
  }
  if (!info) return undefined;
  const blocks = children(info, 'LicenseInfo');
  const times = (name: string) => blocks.map(b => utc(elementText(text, child(b, name)))).filter((d): d is Date => !!d);
  const expires = times('ExpireTime').sort((a, b) => a.getTime() - b.getTime())[0];
  const issued = times('IssueTime').sort((a, b) => a.getTime() - b.getTime())[0];
  const licenses = findAll(info, 'License').map(l => {
    const instances = Number(elementText(text, child(l, 'Instances')));
    return {
      id: elementText(text, child(l, 'LicenseId')) ?? '',
      name: elementText(text, child(l, 'Name')) || elementText(text, child(l, 'LicenseId')) || '?',
      orderNo: elementText(text, child(l, 'OrderNo')) || undefined,
      instances: Number.isFinite(instances) && instances > 0 ? instances : undefined,
    };
  });
  return { file, runtime, trial: /trial/i.test(path.basename(file)), issued, expires, licenses };
}

/** The license folders of the runtimes installed here, whether or not they hold a file yet. */
export function licenseFolders(env: Record<string, string | undefined> = process.env, platform: string = process.platform): LicenseFolder[] {
  if (platform !== 'win32') return [];
  const out: LicenseFolder[] = [];
  const runtimes = path.win32.join(env.ProgramData || 'C:\\ProgramData', 'Beckhoff', 'TwinCAT', '3.1', 'Runtimes');
  let names: string[] = [];
  try {
    names = fs.readdirSync(runtimes, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
  } catch {
    // no 4026 runtime
  }
  for (const runtime of names) out.push({ runtime, folder: path.win32.join(runtimes, runtime, '3.1', 'Target', 'License') });
  const legacy = path.win32.join(env.TWINCAT3DIR || 'C:\\TwinCAT\\3.1\\', 'Target', 'License');
  if (fs.existsSync(legacy)) out.push({ runtime: 'TwinCAT', folder: legacy });
  return out;
}

/** An AMS Net ID from its 6 bytes in hex (`0A01B4160101`: 10.1.180.22.1.1). */
function netIdOfHex(hex: string): string | undefined {
  const digits = hex.replace(/\s/g, '');
  return /^[0-9a-f]{12}$/i.test(digits) ? digits.match(/../g)!.map(b => parseInt(b, 16)).join('.') : undefined;
}

/** The AMS Net ID in a runtime's TcRegistry.xml (4026): `<Value Name="AmsNetId" Type="BIN">` of its System key. */
export function netIdOfRegistryXml(text: string): string | undefined {
  const m = /<Value\s+Name="AmsNetId"\s+Type="BIN"\s*>([^<]*)</i.exec(text);
  return m ? netIdOfHex(m[1]) : undefined;
}

/**
 * The AMS Net ID of a runtime, which a trial license is generated for: 4026's in TcRegistry.xml beside its Target
 * folder, 4024's in the Windows registry.
 */
export function runtimeNetId(folder: LicenseFolder): string | undefined {
  try {
    if (folder.runtime !== 'TwinCAT') {
      return netIdOfRegistryXml(fs.readFileSync(path.join(folder.folder, '..', '..', 'TcRegistry.xml'), 'utf8'));
    }
    const out = cp.execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\WOW6432Node\\Beckhoff\\TwinCAT3\\System', '/v', 'AmsNetId'],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /REG_BINARY\s+([0-9a-f]+)/i.exec(out);
    return m ? netIdOfHex(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

/** When a license file of the folder was last written, 0 without one: a new trial license writes TrialLicense.tclrs. */
export function lastLicenseWrite(folder: string): number {
  let latest = 0;
  try {
    for (const f of fs.readdirSync(folder)) {
      if (/\.tclrs$/i.test(f)) latest = Math.max(latest, fs.statSync(path.join(folder, f)).mtimeMs);
    }
  } catch {
    // no folder yet
  }
  return latest;
}

/** The license files of these folders, the trial licenses first. */
export function readLicenses(folders: LicenseFolder[]): LicenseFile[] {
  const out: LicenseFile[] = [];
  for (const { runtime, folder } of folders) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(folder).filter(f => /\.tclrs$/i.test(f)).sort();
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(folder, f);
      try {
        const parsed = parseLicenseFile(decodeXml(fs.readFileSync(file)), file, runtime);
        if (parsed) out.push(parsed);
      } catch {
        // unreadable: left out
      }
    }
  }
  return out.sort((a, b) => Number(b.trial) - Number(a.trial));
}

/** The license file that ends first; undefined when none ends. */
export function firstToExpire(files: LicenseFile[]): LicenseFile | undefined {
  return files.filter(f => f.expires).sort((a, b) => a.expires!.getTime() - b.expires!.getTime())[0];
}

/** `6 d 4 h`, `5 h 12 min`, `3 min`: how long until a time, or `expired`. */
export function timeLeft(expires: Date, now: Date): string {
  const minutes = Math.floor((expires.getTime() - now.getTime()) / 60_000);
  if (minutes < 0) return 'expired';
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d) return h ? `${d} d ${h} h` : `${d} d`;
  if (h) return m ? `${h} h ${m} min` : `${h} h`;
  return `${m} min`;
}
