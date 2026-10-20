// The libraries installed for TwinCAT XAE, read from its library repositories without XAE, and the reference that
// XAE 3.1.4026's Library Manager > Add library writes for one of them (see addPlaceholderReference).

import * as fs from 'fs';
import * as path from 'path';
import { LibrarySpec, PlaceholderReferenceSpec, formatLibrarySpec, itemOrder, parseLibrarySpec, sameName } from './project';
import { fileKey } from './workspace';
import { child, elementText, findAll, parseXml } from './xml';

/** A version of a library installed in a repository: the folder `<Company>\<Title>\<Version>` with its library file. */
export interface LibraryVersion {
  version: string;
  /** The library file (`.compiled-library-ge33`, `.compiled-library`, `.library`), whose name can differ from the title. */
  file: string;
  /** Its default namespace, from the cache of the repository; its title when the cache lacks it (installed since). */
  namespace: string;
  /** Its categories, with those they are in (`Acme / Valves`), as the category files of the repositories name them. */
  categories: string[];
}

/** A library of a company, with its installed versions, the newest first. */
export interface InstalledLibrary {
  title: string;
  company: string;
  versions: LibraryVersion[];
}

/** A placeholder of a repository's profile, for one compiler version: `Tc2_Standard` is `Tc2_Standard, * (Beckhoff Automation GmbH)`. */
export interface ProfilePlaceholder {
  name: string;
  compilerVersion: string;
  library: LibrarySpec;
}

/** What library repositories hold. */
export interface Repositories {
  /** The repository folders read. */
  found: string[];
  /** The folders asked for that were not read, and why: `not found`. */
  missing: { folder: string; reason: string }[];
  /** The libraries, by title (case aside), then company. */
  libraries: InstalledLibrary[];
  /** The placeholders of their profiles. */
  placeholders: ProfilePlaceholder[];
}

/** A library of a repository's cache, at the folder its Path names. */
export interface CacheEntry {
  /** `<Company>\<Title>\<Version>`. */
  folder: string;
  title: string;
  version: string;
  company: string;
  namespace: string;
  /** Its category GUIDs, lower case, without braces. */
  categoryIds: string[];
}

/** A category of a category file: its name and the category it is in. */
export interface LibraryCategory {
  name: string;
  parent?: string;
}

/**
 * The repositories XAE installs libraries in: `%ProgramData%\Beckhoff\TwinCAT\PlcEngineering\Managed Libraries` with
 * TwinCAT 3.1.4026, `%TWINCAT3DIR%Components\Plc\Managed Libraries` with 3.1.4024 and older (with 3.1.4026,
 * TWINCAT3DIR is its folder in Program Files, which holds none). None elsewhere than on Windows, where XAE runs.
 */
export function systemRepositories(env: Record<string, string | undefined> = process.env, platform: string = process.platform): string[] {
  if (platform !== 'win32') return [];
  return [
    path.win32.join(env.ProgramData || 'C:\\ProgramData', 'Beckhoff', 'TwinCAT', 'PlcEngineering', 'Managed Libraries'),
    path.win32.join(env.TWINCAT3DIR || 'C:\\TwinCAT\\3.1\\', 'Components', 'Plc', 'Managed Libraries'),
  ];
}

/** The text of an XML file of a repository, by its BOM: `cache` is UTF-16 LE with one, `profile` UTF-8. */
export function decodeXml(bytes: Uint8Array): string {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b[0] === 0xff && b[1] === 0xfe) return b.toString('utf16le', 2);
  if (b[0] === 0xfe && b[1] === 0xff) return Buffer.from(b.subarray(2, b.length - (b.length % 2))).swap16().toString('utf16le');
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.toString('utf8', 3);
  // UTF-16 LE without a BOM: `<` and a zero byte.
  if (b[0] === 0x3c && b[1] === 0) return b.toString('utf16le');
  return b.toString('utf8');
}

/** Versions part by part, by number (`3.4.10.0` after `3.4.9.0`); a part that is not a number by its text. */
export function compareVersions(a: string, b: string): number {
  const x = a.split('.');
  const y = b.split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? '0';
    const q = y[i] ?? '0';
    const d = /^\d+$/.test(p) && /^\d+$/.test(q) ? Number(p) - Number(q) : p < q ? -1 : p > q ? 1 : 0;
    if (d) return Math.sign(d);
  }
  return 0;
}

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** The GUIDs in a text, lower case, without braces, whatever separates them. */
function guids(text: string | undefined): string[] {
  return (text?.match(GUID) ?? []).map(g => g.toLowerCase());
}

/**
 * The libraries of a repository's `cache`: `<LibraryRepository>` with a `<Library Path="Beckhoff Automation
 * GmbH\Tc2_Standard\3.4.7.0\Tc2_Standard.compiled-library" Title Version Company DefaultNamespace CategoryIds />` per
 * installed version. Its Path can name another file than the one in the folder (`.compiled-library` for a
 * `.compiled-library-ge33`): the folder is what counts.
 */
export function parseRepositoryCache(text: string): CacheEntry[] {
  return findAll(parseXml(text), 'Library').flatMap(l => {
    const parts = (l.attrs.get('Path') ?? '').split(/[\\/]/).filter(p => p);
    if (parts.length < 4) return [];
    return [{
      folder: parts.slice(-4, -1).join('\\'),
      title: l.attrs.get('Title') ?? '',
      version: l.attrs.get('Version') ?? '',
      company: l.attrs.get('Company') ?? '',
      namespace: l.attrs.get('DefaultNamespace') ?? '',
      categoryIds: guids(l.attrs.get('CategoryIds')),
    }];
  });
}

/**
 * The placeholders of a repository's `profile`: `<Resolution PlaceholderName="Tc2_Standard" CompilerVersion="3.5.4.0">
 * Tc2_Standard, * (Beckhoff Automation GmbH)</Resolution>`, one per compiler version.
 */
export function parseProfile(text: string): ProfilePlaceholder[] {
  return findAll(parseXml(text), 'Resolution').flatMap(r => {
    const name = r.attrs.get('PlaceholderName');
    const library = parseLibrarySpec(elementText(text, r) ?? '');
    return name && library ? [{ name, compilerVersion: r.attrs.get('CompilerVersion') ?? '', library }] : [];
  });
}

/**
 * The categories of a category file (`LibraryCategoryBase.libcat.xml`), by GUID: `<LibraryCategory>` with its `<Id>`,
 * `<DefaultName>` and the `<ParentCategory>` (its `<Id>`) it is in.
 */
export function parseCategories(text: string): Map<string, LibraryCategory> {
  const out = new Map<string, LibraryCategory>();
  for (const c of findAll(parseXml(text), 'LibraryCategory')) {
    const id = guids(elementText(text, child(c, 'Id')))[0];
    const name = elementText(text, child(c, 'DefaultName'));
    if (id && name) out.set(id, { name, parent: guids(elementText(text, child(child(c, 'ParentCategory'), 'Id')))[0] });
  }
  return out;
}

/** The name of a category with those it is in (`Acme / Valves`), or undefined when no category file names it. */
function categoryName(id: string, categories: Map<string, LibraryCategory>): string | undefined {
  const names: string[] = [];
  const seen = new Set<string>();
  for (let at: string | undefined = id; at && !seen.has(at); at = categories.get(at)?.parent) {
    seen.add(at);
    const category = categories.get(at);
    if (!category) break;
    names.unshift(category.name);
  }
  return names.length ? names.join(' / ') : undefined;
}

const VERSION_FOLDER = /^\d+(\.\d+)*$/;
const LIBRARY_FILE = /\.(compiled-library(-\w+)?|library)$/i;
/** Which file of a version folder is its library: a compiled one before the source. */
const fileRank = (name: string) => (/\.compiled-library-\w+$/i.test(name) ? 0 : /\.compiled-library$/i.test(name) ? 1 : 2);

async function entries(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

const folderNames = (list: fs.Dirent[]) => list.filter(e => e.isDirectory() || e.isSymbolicLink()).map(e => e.name);

/** A version folder of a repository, with its library file. */
interface Found {
  company: string;
  title: string;
  version: string;
  file: string;
}

/** The folders `<Company>\<Title>\<Version>` of a repository that hold a library file. */
async function versionFolders(repository: string, top: fs.Dirent[]): Promise<Found[]> {
  const found: Found[] = [];
  const at = (...parts: string[]) => path.join(repository, ...parts);
  await Promise.all(folderNames(top).map(async company => {
    await Promise.all(folderNames(await entries(at(company))).map(async title => {
      const versions = folderNames(await entries(at(company, title))).filter(v => VERSION_FOLDER.test(v));
      await Promise.all(versions.map(async version => {
        const files = (await entries(at(company, title, version))).filter(e => !e.isDirectory() && LIBRARY_FILE.test(e.name)).map(e => e.name);
        const file = files.sort((a, b) => fileRank(a) - fileRank(b) || itemOrder(a, b))[0];
        if (file) found.push({ company, title, version, file: at(company, title, version, file) });
      }));
    }));
  }));
  return found;
}

/** An XML file of a repository, parsed; undefined when it is not there or not what XAE writes. */
async function readXml<T>(file: string, parse: (text: string) => T): Promise<T | undefined> {
  try {
    return parse(decodeXml(await fs.promises.readFile(file)));
  } catch {
    return undefined;
  }
}

/** A version found, with the title and company its cache entry gives it. */
interface Read {
  title: string;
  company: string;
  version: LibraryVersion;
  categoryIds: string[];
}

/**
 * The libraries installed in repositories (absolute folders), read as XAE 3.1.4026 keeps them, without the library
 * files themselves:
 * - The folders `<Company>\<Title>\<Version>` that hold a library file are the installed versions; the `cache` can
 *   lack a library installed since, and name one removed since.
 * - The `cache` at the top of a repository gives the title, version, company, default namespace and categories of a
 *   version where it has its folder; else the folders give its names, and its title is its namespace.
 * - Its `profile` gives the placeholders, its category files (`*.libcat.xml`) the names of the categories.
 * A version in several repositories counts once, from the first.
 */
export async function readRepositories(folders: string[]): Promise<Repositories> {
  const result: Repositories = { found: [], missing: [], libraries: [], placeholders: [] };
  const seen = new Set<string>();
  for (const folder of folders) {
    if (!path.isAbsolute(folder)) {
      result.missing.push({ folder, reason: 'not an absolute path' });
      continue;
    }
    if (seen.has(fileKey(folder))) continue;
    seen.add(fileKey(folder));
    try {
      if ((await fs.promises.stat(folder)).isDirectory()) result.found.push(folder);
      else result.missing.push({ folder, reason: 'not a folder' });
    } catch (e) {
      result.missing.push({ folder, reason: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'not found' : (e as Error).message });
    }
  }
  const repositories = await Promise.all(result.found.map(async repository => {
    const top = await entries(repository);
    const categoryFiles = top.filter(e => !e.isDirectory() && /\.libcat\.xml$/i.test(e.name)).map(e => path.join(repository, e.name));
    const [found, cache, profile, categories] = await Promise.all([
      versionFolders(repository, top),
      readXml(path.join(repository, 'cache'), parseRepositoryCache),
      readXml(path.join(repository, 'profile'), parseProfile),
      Promise.all(categoryFiles.map(f => readXml(f, parseCategories))),
    ]);
    return { found, cache: cache ?? [], profile: profile ?? [], categories };
  }));

  const categories = new Map<string, LibraryCategory>();
  for (const r of repositories) {
    for (const file of r.categories) for (const [id, c] of file ?? []) if (!categories.has(id)) categories.set(id, c);
  }
  const byLibrary = new Map<string, Read[]>();
  for (const r of repositories) {
    result.placeholders.push(...r.profile);
    const cached = new Map(r.cache.map(e => [e.folder.toUpperCase(), e]));
    // Read in parallel: in the order of the folders again.
    r.found.sort((a, b) => itemOrder(a.company, b.company) || itemOrder(a.title, b.title) || compareVersions(b.version, a.version));
    for (const f of r.found) {
      const e = cached.get(`${f.company}\\${f.title}\\${f.version}`.toUpperCase());
      const title = e?.title || f.title;
      const company = e?.company || f.company;
      const key = `${title}\n${company}`.toUpperCase();
      const reads = byLibrary.get(key) ?? [];
      byLibrary.set(key, reads);
      const version = e?.version || f.version;
      if (reads.some(v => compareVersions(v.version.version, version) === 0)) continue;
      const categoryIds = e?.categoryIds ?? [];
      reads.push({ title, company, categoryIds, version: { version, file: f.file, namespace: e?.namespace || title, categories: [] } });
    }
  }
  for (const reads of byLibrary.values()) {
    reads.sort((a, b) => compareVersions(b.version.version, a.version.version));
    for (const r of reads) r.version.categories = r.categoryIds.flatMap(id => categoryName(id, categories) ?? []);
    // The names of the newest version: an older one can have its title in another case.
    result.libraries.push({ title: reads[0].title, company: reads[0].company, versions: reads.map(r => r.version) });
  }
  result.libraries.sort((a, b) => itemOrder(a.title, b.title) || itemOrder(a.company, b.company));
  return result;
}

/**
 * The placeholder of a new reference to a library: the one the profiles give it (Beckhoff's libraries have their
 * title), one named like the title first, spelled as for the newest compiler version (an older one can spell it in
 * another case: `tc2_system`); the title when the profiles give it none.
 */
export function placeholderName(lib: { title: string; company: string }, placeholders: ProfilePlaceholder[]): string {
  const of = placeholders.filter(p => sameName(p.library.title, lib.title) && sameName(p.library.company, lib.company));
  const named = of.filter(p => sameName(p.name, lib.title));
  const best = (named.length ? named : of).sort((a, b) => compareVersions(b.compilerVersion, a.compilerVersion)
    || Number(b.name === lib.title) - Number(a.name === lib.title))[0];
  return best?.name ?? lib.title;
}

/**
 * The reference XAE 3.1.4026's Add library writes for a library, whatever its company: its placeholder (see
 * placeholderName), resolved by default to `<Title>, <version> (<Company>)` with the version given, `*` for always
 * the newest installed, and the default namespace of that version (of the newest for `*`).
 */
export function libraryReference(lib: InstalledLibrary, version: string, placeholders: ProfilePlaceholder[]): PlaceholderReferenceSpec {
  const installed = version === '*' ? lib.versions[0] : lib.versions.find(v => v.version === version);
  if (!installed) throw new Error(`${lib.title} ${version} is not installed`);
  return {
    include: placeholderName(lib, placeholders),
    resolution: formatLibrarySpec({ title: lib.title, version, company: lib.company }),
    namespace: installed.namespace,
  };
}
