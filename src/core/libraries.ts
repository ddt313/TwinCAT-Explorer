// The libraries installed for TwinCAT XAE, read from its library repositories without XAE, and the reference that
// XAE 3.1.4026's Library Manager > Add library writes for one of them (see addPlaceholderReference).

import * as fs from 'fs';
import * as path from 'path';
import {
  LibrarySpec, PlaceholderReferenceSpec, PlcProject, formatLibrarySpec, itemOrder, parseLibrarySpec, resolutionLibraryName, sameName,
} from './project';
import { fileKey } from './workspace';
import { child, elementText, findAll, parseXml } from './xml';

/** A version of a library installed in a repository: the folder `<Company>\<Title>\<Version>` with its library file. */
export interface LibraryVersion {
  version: string;
  /** The library file (`.compiled-library-ge33`, `.compiled-library`, `.library`), whose name can differ from the title. */
  file: string;
  /**
   * Its default namespace, from the cache of the repository; when the cache lacks it (installed since, or a repository
   * without a cache), from the `projectinfo` of its folder; else its title.
   */
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
  /** The repository folders read that hold no library, as asked for. */
  empty: string[];
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

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The unsigned LEB128 number at `at` of `b`, and where it ends; undefined past the end. */
function varint(b: Uint8Array, at: number): { value: number; end: number } | undefined {
  let value = 0;
  for (let shift = 0, p = at; p < b.length && shift < 35; shift += 7, p++) {
    value += (b[p] & 0x7f) * 2 ** shift;
    if (!(b[p] & 0x80)) return { value, end: p + 1 };
  }
  return undefined;
}

const leb128 = (n: number): number[] => {
  const out: number[] = [];
  do {
    out.push((n & 0x7f) | (n >= 0x80 ? 0x80 : 0));
    n = Math.floor(n / 128);
  } while (n);
  return out;
};

/**
 * The default namespace of a library version from the `projectinfo` of its folder, which XAE writes when it installs
 * the library: for a repository without a `cache` (a cloned one, such as the SPT Libraries, that XAE never indexed
 * here). The file is binary: a table of the strings it holds (`<index> <length in bytes> <UTF-16 LE>`, the indexes
 * counting from 1 and the numbers LEB128), then the properties of the library as objects naming those strings: a
 * string is `D0 00 <index of "System.String"> 2D <its index>`, a property its name's string then its value's. Undefined
 * when the file is not that, the library has no default namespace, or it is no identifier.
 */
export function parseProjectInfoNamespace(bytes: Uint8Array): string | undefined {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The table starts with "System.String", index 1.
  const first = b.indexOf(Buffer.from('System.String', 'utf16le'));
  if (first < 2 || b[first - 2] !== 1 || b[first - 1] !== 26) return undefined;
  const strings: string[] = [];
  let p = first - 2;
  for (;;) {
    const index = varint(b, p);
    if (!index || index.value !== strings.length + 1) break;
    const length = varint(b, index.end);
    if (!length || length.value % 2 || length.end + length.value > b.length) break;
    strings.push(b.toString('utf16le', length.end, length.end + length.value));
    p = length.end + length.value;
  }
  const key = strings.indexOf('DefaultNamespace') + 1;
  if (!key) return undefined;
  const string = (index: number) => [0xd0, 0x00, 0x01, 0x2d, ...leb128(index)];
  const pattern = Buffer.from([...string(key), 0xd0, 0x00, 0x01, 0x2d]);
  const at = b.indexOf(pattern, p);
  const value = at < 0 ? undefined : varint(b, at + pattern.length);
  const namespace = value && strings[value.value - 1];
  return namespace && IDENTIFIER.test(namespace) ? namespace : undefined;
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

/** A version folder's key in the cache of its repository. */
const folderKey = (f: Found) => `${f.company}\\${f.title}\\${f.version}`.toUpperCase();

/** The default namespace in a `projectinfo`; undefined when it is not there or holds none. */
async function readNamespace(file: string): Promise<string | undefined> {
  try {
    return parseProjectInfoNamespace(await fs.promises.readFile(file));
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
 *   version where it has its folder; else the folders give its names, and the `projectinfo` of its folder its
 *   namespace (see parseProjectInfoNamespace), or its title.
 * - Its `profile` gives the placeholders, its category files (`*.libcat.xml`) the names of the categories.
 * - A folder without libraries whose subfolder is a repository is read as that subfolder, which `found` then names:
 *   a clone of the SPT Libraries holds its repository in `Library Repository`. A folder that holds no library is in
 *   `empty`.
 * A version in several repositories counts once, from the first.
 */
export async function readRepositories(folders: string[]): Promise<Repositories> {
  const result: Repositories = { found: [], missing: [], libraries: [], placeholders: [], empty: [] };
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
  const repositories = await Promise.all(result.found.map(async asked => {
    let repository = asked;
    let top = await entries(repository);
    let found = await versionFolders(repository, top);
    if (!found.length) {
      // A repository in a subfolder: not in the folders of git and the like.
      const nested = await Promise.all(folderNames(top).filter(n => !n.startsWith('.')).sort(itemOrder).map(async name => {
        const folder = path.join(asked, name);
        const list = await entries(folder);
        return { folder, list, found: await versionFolders(folder, list) };
      }));
      const inner = nested.find(n => n.found.length);
      if (inner) ({ folder: repository, list: top, found } = inner);
    }
    const categoryFiles = top.filter(e => !e.isDirectory() && /\.libcat\.xml$/i.test(e.name)).map(e => path.join(repository, e.name));
    const [cache, profile, categories] = await Promise.all([
      readXml(path.join(repository, 'cache'), parseRepositoryCache),
      readXml(path.join(repository, 'profile'), parseProfile),
      Promise.all(categoryFiles.map(f => readXml(f, parseCategories))),
    ]);
    const cached = new Map((cache ?? []).map(e => [e.folder.toUpperCase(), e]));
    const namespaces = await Promise.all(found.map(f => cached.has(folderKey(f)) ? undefined
      : readNamespace(path.join(path.dirname(f.file), 'projectinfo'))));
    return { asked, repository, found: found.map((f, i) => ({ ...f, namespace: namespaces[i] })), cached, profile: profile ?? [], categories };
  }));
  result.found = repositories.map(r => r.repository);
  result.empty = repositories.filter(r => !r.found.length).map(r => r.asked);

  const categories = new Map<string, LibraryCategory>();
  for (const r of repositories) {
    for (const file of r.categories) for (const [id, c] of file ?? []) if (!categories.has(id)) categories.set(id, c);
  }
  const byLibrary = new Map<string, Read[]>();
  for (const r of repositories) {
    result.placeholders.push(...r.profile);
    // Read in parallel: in the order of the folders again.
    r.found.sort((a, b) => itemOrder(a.company, b.company) || itemOrder(a.title, b.title) || compareVersions(b.version, a.version));
    for (const f of r.found) {
      const e = r.cached.get(folderKey(f));
      const title = e?.title || f.title;
      const company = e?.company || f.company;
      const key = `${title}\n${company}`.toUpperCase();
      const reads = byLibrary.get(key) ?? [];
      byLibrary.set(key, reads);
      const version = e?.version || f.version;
      if (reads.some(v => compareVersions(v.version.version, version) === 0)) continue;
      const categoryIds = e?.categoryIds ?? [];
      reads.push({ title, company, categoryIds, version: { version, file: f.file, namespace: e?.namespace || f.namespace || title, categories: [] } });
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

/** What a library declares, as its `browsercache` names it: names and comments, without the declarations. */
export interface LibraryObject {
  name: string;
  /** A POU is a function block, program or function: the cache does not tell which. */
  kind: 'pou' | 'dut' | 'interface' | 'gvl';
  comment?: string;
  members: { name: string; kind: 'method' | 'property' | 'action'; comment?: string }[];
}

/** The TypeGUIDs of the nodes of a `browsercache` (XAE's object types); the others are folders, visualizations, ... */
const OBJECT_KINDS = new Map<string, LibraryObject['kind']>([
  ['6f9dac99-8de1-4efc-8465-68ac443b7d08', 'pou'],
  ['2db5746d-d284-4425-9f7f-2663a34b0ebc', 'dut'],
  ['40989022-e4d2-4dc7-89d2-9a412930b20e', 'dut'],
  ['6654496c-404d-479a-aad2-8551054e5f1e', 'interface'],
  ['ffbfa93a-b94d-45fc-a329-229860183b1d', 'gvl'],
]);
const MEMBER_KINDS = new Map<string, LibraryObject['members'][number]['kind']>([
  ['f8a58466-d7f6-439f-bbb8-d4600e41d099', 'method'],
  ['f89f7675-27f1-46b3-8abb-b7da8e774ffd', 'method'],
  ['62ebfd1c-d342-43e5-8efb-f22b6d8e4a04', 'method'],
  ['5a3b8626-d3e9-4f37-98b5-66420063d91e', 'property'],
  ['8ac092e5-3128-4e26-9e7e-11016c6684f2', 'action'],
]);

const typeGuid = (attrs: Map<string, string>) => guids(attrs.get('TypeGUID'))[0];
const nodeComment = (attrs: Map<string, string>) => attrs.get('Comment')?.replace(/\r\n?/g, '\n').trim() || undefined;

/**
 * The objects of a library version's `browsercache`, which XAE writes next to the library when it installs it, for the
 * libraries of every company, compiled ones too: `<Library Name="…">` with a `<Node Name TypeGUID Comment>` per
 * object (its methods, properties and actions inside, a property's Get and Set inside that), folders flat beside them.
 * Hidden objects (IsHidden) and names that are no identifier are left out.
 */
export function parseBrowserCache(text: string): LibraryObject[] {
  const root = child(parseXml(text.replace(/^﻿/, '')), 'Library');
  if (!root) return [];
  const out: LibraryObject[] = [];
  for (const node of root.children) {
    if (node.name !== 'Node' || node.attrs.get('IsHidden') === 'true') continue;
    const kind = OBJECT_KINDS.get(typeGuid(node.attrs) ?? '');
    const name = node.attrs.get('Name') ?? '';
    if (!kind || !IDENTIFIER.test(name)) continue;
    const members = kind === 'pou' || kind === 'interface' ? node.children.flatMap(m => {
      const memberKind = MEMBER_KINDS.get(typeGuid(m.attrs) ?? '');
      const memberName = m.attrs.get('Name') ?? '';
      if (m.name !== 'Node' || !memberKind || !IDENTIFIER.test(memberName) || m.attrs.get('IsHidden') === 'true') return [];
      // A property's comment is on its accessors.
      const comment = nodeComment(m.attrs) ?? m.children.map(a => nodeComment(a.attrs)).find(c => c);
      return [{ name: memberName, kind: memberKind, comment }];
    }) : [];
    out.push({ name, kind, comment: nodeComment(node.attrs), members });
  }
  return out;
}

/** The objects of an installed library version, as its `browsercache` names them. */
export interface InstalledSymbols {
  title: string;
  company: string;
  version: string;
  objects: LibraryObject[];
}

/**
 * The objects of the libraries the references name (`Tc2_Standard, * (Beckhoff Automation GmbH)`), of the version
 * they name when it is installed, else of the newest; a library not installed is left out, and so is one without a
 * `browsercache`. One per library, the first reference's.
 */
export async function readInstalledSymbols(libraries: InstalledLibrary[], references: LibrarySpec[]): Promise<InstalledSymbols[]> {
  const picked = new Map<InstalledLibrary, LibraryVersion>();
  for (const ref of references) {
    const lib = libraries.find(l => sameName(l.title, ref.title) && sameName(l.company, ref.company))
      ?? libraries.find(l => sameName(l.title, ref.title));
    if (!lib || picked.has(lib)) continue;
    picked.set(lib, lib.versions.find(v => compareVersions(v.version, ref.version) === 0) ?? lib.versions[0]);
  }
  const read = await Promise.all([...picked].map(async ([lib, version]) => {
    try {
      const text = decodeXml(await fs.promises.readFile(path.join(path.dirname(version.file), 'browsercache')));
      return [{ title: lib.title, company: lib.company, version: version.version, objects: parseBrowserCache(text) }];
    } catch {
      return [];
    }
  }));
  return read.flat();
}

/**
 * The objects of the installed libraries the PLC projects reference (see readInstalledSymbols), read from the system
 * repositories and the folders given (the setting twincatExplorer.libraryRepositories).
 */
export async function referencedLibrarySymbols(projects: PlcProject[], folders: string[]): Promise<InstalledSymbols[]> {
  const references = projects.flatMap(p => p.libraries).map(lib =>
    parseLibrarySpec(lib.resolution ?? lib.include) ?? { title: resolutionLibraryName(lib), version: '*', company: '' });
  if (!references.length) return [];
  const { libraries } = await readRepositories([...systemRepositories(), ...folders]);
  return readInstalledSymbols(libraries, references);
}
