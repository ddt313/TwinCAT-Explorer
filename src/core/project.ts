// Parsing of TwinCAT project files: .tsproj (system project) and .plcproj (PLC project).

import * as path from 'path';
import { XmlElement, parseXml, child, elementText } from './xml';

export interface PlcProjectRef {
  name: string;
  plcprojPath: string;
}

export interface TsProject {
  path: string;
  name: string;
  plcProjects: PlcProjectRef[];
}

export interface LibraryRef {
  /** Include attribute (placeholder name or library spec). */
  include: string;
  /** Library name without version/vendor. */
  name: string;
  namespace: string;
  resolution?: string;
  system: boolean;
}

export interface PlcProject {
  path: string;
  dir: string;
  name: string;
  title?: string;
  /** Relative paths (backslash separated, as in the .plcproj) of source files. */
  compile: string[];
  /** Relative folder paths declared by <Folder Include>. */
  folders: string[];
  libraries: LibraryRef[];
}

function findAll(el: XmlElement, name: string, out: XmlElement[] = []): XmlElement[] {
  for (const c of el.children) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

export function parseTsProject(filePath: string, text: string): TsProject {
  const doc = parseXml(text);
  const plcProjects: PlcProjectRef[] = [];
  for (const plc of findAll(doc, 'Plc')) {
    for (const proj of plc.children.filter(c => c.name === 'Project')) {
      const prj = proj.attrs.get('PrjFilePath');
      if (!prj) continue;
      plcProjects.push({
        name: proj.attrs.get('Name') ?? path.basename(prj, path.extname(prj)),
        plcprojPath: path.resolve(path.dirname(filePath), prj.replace(/\\/g, path.sep)),
      });
    }
  }
  return { path: filePath, name: path.basename(filePath, path.extname(filePath)), plcProjects };
}

function libraryName(include: string): string {
  // "Tc2_Standard, * (Beckhoff Automation GmbH)" -> "Tc2_Standard"
  return include.split(',')[0].trim();
}

export function parsePlcProject(filePath: string, text: string): PlcProject {
  const doc = parseXml(text);
  const project: PlcProject = {
    path: filePath,
    dir: path.dirname(filePath),
    name: path.basename(filePath, path.extname(filePath)),
    compile: [],
    folders: [],
    libraries: [],
  };
  for (const pg of findAll(doc, 'PropertyGroup')) {
    const name = elementText(text, child(pg, 'Name'));
    if (name) project.name = name;
    const title = elementText(text, child(pg, 'Title'));
    if (title) project.title = title;
  }
  for (const c of findAll(doc, 'Compile')) {
    const inc = c.attrs.get('Include');
    if (inc) project.compile.push(inc);
  }
  for (const f of findAll(doc, 'Folder')) {
    const inc = f.attrs.get('Include');
    if (inc) project.folders.push(inc.replace(/[\\/]+$/, ''));
  }
  for (const tag of ['PlaceholderReference', 'LibraryReference']) {
    for (const r of findAll(doc, tag)) {
      const inc = r.attrs.get('Include');
      if (!inc) continue;
      const name = libraryName(inc);
      project.libraries.push({
        include: inc,
        name,
        namespace: elementText(text, child(r, 'Namespace')) || name,
        resolution: elementText(text, child(r, 'DefaultResolution')),
        system: (elementText(text, child(r, 'SystemLibrary')) ?? '').toLowerCase() === 'true',
      });
    }
  }
  return project;
}

/** Library name of a placeholder resolution such as "[Components], * (Acme)" or "Tc2_Standard, * (...)". */
export function resolutionLibraryName(lib: LibraryRef): string {
  const res = lib.resolution ?? lib.include;
  const m = /^\s*\[?([^\],]+)\]?/.exec(res);
  return (m ? m[1] : lib.name).trim();
}
