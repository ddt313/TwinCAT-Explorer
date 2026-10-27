// Saving the edited sections of a source file through the TwinCAT XAE that has its PLC project open, as the MCP
// server writes: XAE shows the change at once and saves the object itself, where a file written behind it makes XAE
// ask to reload, or XAE writes its own copy back over it. Independent of the VS Code API.

import * as fs from 'fs';
import * as path from 'path';
import { Section, TcSourceFile, parseTcFile } from './tcfile';
import { viewLabel } from './objectText';
import { TcWorkspace, fileKey } from './workspace';
import { Xae, XaeError, XaeItem, XaeUnavailable } from './xae';

export interface SectionEdit {
  key: string;
  text: string;
}

export interface XaeSaveHost {
  /** Asks the user to go on; `action` names the button that does. */
  confirm(message: string, action: string): Promise<boolean>;
  /** XAE runs but cannot be asked whether it has the project open: the file is written as before. */
  warn(message: string): void;
}

/** The folders of a file in its PLC project (`POUs`, `Valves`), from its <Compile> include. */
function foldersOf(include: string): string[] {
  return include.split(/[\\/]/).slice(0, -1).filter(s => s.length > 0);
}

/**
 * The path of a section's tree item below the nested PLC project in XAE: folders, POU, folders in the POU, member,
 * accessor.
 */
export function xaePathOf(include: string, sec: Pick<Section, 'owner' | 'accessor'>): string[] {
  const o = sec.owner;
  return [...foldersOf(include), (o.parent ?? o).name, ...(o.parent ? [...o.folderPath, o.name] : []), ...(sec.accessor ? [sec.accessor] : [])];
}

/** The path of a section below its POU, as XAE's `texts` names it (`''`, `Open`, `Speed^Get`). */
function relPathOf(sec: Pick<Section, 'owner' | 'accessor'>): string {
  const o = sec.owner;
  return [...(o.parent ? [...o.folderPath, o.name] : []), ...(sec.accessor ? [sec.accessor] : [])].join('^');
}

const sectionLabel = (sec: Section) => `${viewLabel(sec.owner, sec.accessor)} ${sec.role === 'decl' ? 'declaration' : 'implementation'}`;
const listOf = (items: string[]) => items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items[0];

/**
 * Writes `edits` of the file through the XAE that has its PLC project open, through any .tsproj that lists it.
 * False when none has (or XAE cannot be asked): the caller writes the file. Throws when the save must not go on: the
 * user declined to save or replace XAE's unsaved edits, or XAE refused a section (the sections before it are saved).
 */
export async function saveThroughXae(ws: TcWorkspace, xae: Xae, file: TcSourceFile, edits: SectionEdit[], host: XaeSaveHost): Promise<boolean> {
  const entry = ws.entry(file.path);
  if (!entry || !edits.length) return false;
  const key = fileKey(entry.project.path);
  let at: Omit<XaeItem, 'path'> | undefined;
  try {
    for (const ts of ws.tsProjects) {
      const ref = ts.plcProjects.find(r => r.plcprojPath && fileKey(r.plcprojPath) === key);
      const inst = ref && await xae.instanceForAsync(ts.path);
      if (inst) {
        at = { pid: inst.pid, tsproj: ts.path, plc: ref.name, file: file.path };
        break;
      }
    }
  } catch (e) {
    // An XAE that does not answer (a dialog open in it) may have the file open: never write the file behind it.
    if (!(e instanceof XaeUnavailable)) {
      if (e instanceof XaeError) throw new Error(`Not saved: ${e.message}. Close the dialog open in TwinCAT XAE, if any, and save again.`);
      throw e;
    }
    host.warn(`${e.message}. The file was written: if TwinCAT XAE has it open, reload it there.`);
    return false;
  }
  if (!at) return false;
  const sections = edits.map(e => {
    const sec = file.sections.get(e.key);
    if (!sec) throw new Error(`A section of ${file.path} is no longer in the file`);
    return { sec, text: e.text, item: { ...at!, path: xaePathOf(entry.include, sec) } };
  });

  try {
    // XAE's text of every section of the file's POU, unsaved edits included: setting one saves the whole object.
    const root = sections[0].sec.owner.parent ?? sections[0].sec.owner;
    const texts = new Map((await xae.textsAsync({ ...at, path: xaePathOf(entry.include, { owner: root }) })).map(t => [t.path, t]));
    // XAE writes the object as it has it: its copy must have the members of the file, and no others (one it could
    // not read back, or one deleted here while XAE kept its copy).
    const inFile = new Map<string, string>();
    for (const sec of file.sections.values()) inFile.set(relPathOf(sec).toLowerCase(), viewLabel(sec.owner, sec.accessor));
    const inXaeOnly = [...texts.values()].filter(t => (t.decl !== undefined || t.impl !== undefined) && !inFile.has(t.path.toLowerCase()));
    const keys = new Set([...texts.keys()].map(k => k.toLowerCase()));
    const inFileOnly = [...inFile].filter(([k]) => !keys.has(k)).map(([, label]) => label);
    if (inFileOnly.length || inXaeOnly.length) {
      const name = root.qualifiedName;
      throw new Error(`Not saved: TwinCAT XAE's copy of ${name} ${inFileOnly.length ? `has no ${listOf(inFileOnly)}, which the file has` : ''}`
        + `${inFileOnly.length && inXaeOnly.length ? ', and ' : ''}${inXaeOnly.length ? `has ${listOf(inXaeOnly.map(t => `${name}.${t.path.replace(/\^/g, '.')}`))}, which the file has not` : ''}, `
        + 'and XAE would save the object that way. Reload the project in TwinCAT XAE, then save again.');
    }
    const edited = new Map(sections.map(s => [s.sec.key, s.text]));
    const replaced: string[] = [];
    const alsoSaved: string[] = [];
    for (const sec of file.sections.values()) {
      if (!sec.editable) continue;
      const inXae = texts.get(relPathOf(sec))?.[sec.role];
      if (inXae === undefined || inXae === sec.text) continue;
      const mine = edited.get(sec.key);
      if (mine === undefined) alsoSaved.push(sectionLabel(sec));
      else if (inXae !== mine) replaced.push(sectionLabel(sec));
    }
    const said: string[] = [];
    if (replaced.length) said.push(`${listOf(replaced)} ${replaced.length > 1 ? 'have' : 'has'} unsaved changes in TwinCAT XAE, which this save replaces with the text from VS Code.`);
    if (alsoSaved.length) said.push(`${listOf(alsoSaved)} ${alsoSaved.length > 1 ? 'have' : 'has'} unsaved changes in TwinCAT XAE, which XAE saves along with this change.`);
    if (said.length && !(await host.confirm(said.join(' '), replaced.length ? 'Replace and Save' : 'Save Them Too'))) {
      throw new Error('Not saved. Save or undo the changes in TwinCAT XAE, then save here again.');
    }
  } catch (e) {
    if (e instanceof XaeError) throw new Error(`TwinCAT XAE did not take the change: ${e.message}`);
    throw e;
  }

  const done: string[] = [];
  for (const s of sections) {
    const label = sectionLabel(s.sec);
    try {
      const r = await xae.getAsync(s.item, s.sec.role);
      if (r.text !== s.text) {
        const res = await xae.setAsync(s.item, s.sec.role, s.text, r.hash);
        if (res.conflict) throw new XaeError(`${label} changed in TwinCAT XAE meanwhile`);
        if (res.dirty) await xae.saveAsync(at, file.path);
      }
    } catch (e) {
      if (!(e instanceof XaeError)) throw e;
      throw new Error(`TwinCAT XAE did not take ${label}: ${e.message}.${done.length ? ` ${listOf(done)} ${done.length > 1 ? 'are' : 'is'} saved.` : ''} Save again to retry.`);
    }
    done.push(label);
  }
  // XAE saves an object it sets, except after its "Reload the new file?" was answered No.
  const onDisk = parseTcFile(file.path, fs.readFileSync(file.path));
  if (sections.some(s => onDisk.sections.get(s.sec.key)?.text !== s.text)) {
    try {
      await xae.forceSaveAsync(at, file.path);
    } catch (e) {
      if (!(e instanceof XaeError)) throw e;
      throw new Error(`TwinCAT XAE has the change but did not save ${path.basename(file.path)}: ${e.message}. Save it in XAE.`);
    }
  }
  return true;
}
