// samples/Demo, a TwinCAT solution saved by TwinCAT XAE (samples/Demo/README.md): the extension reads it as XAE
// builds it, and writes its files back as XAE wrote them. XAE builds it with 0 errors and 0 warnings, so a problem the
// extension finds there, outside code excluded from the build, is the extension's own.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { TcWorkspace } from '../../src/core/workspace';
import { decodeBytes, encodeText, parseTcText } from '../../src/core/tcfile';
import { applySectionEdits } from '../../src/core/splice';
import { LanguageIndex } from '../../src/lang/index';
import { analyze } from '../../src/lang/analyzer';
import { parseBody, parseDeclaration } from '../../src/lang/parser';
import { BUNDLED_STUBS } from '../../src/lang/stubs';
import { findFiles } from './helpers';

const SAMPLE = path.join(__dirname, '..', '..', '..', 'samples', 'Demo');
const SOURCE = /\.(TcPOU|TcDUT|TcGVL|TcIO|TcTTO)$/i;

function load(): TcWorkspace {
  const ws = new TcWorkspace();
  ws.load(findFiles(SAMPLE, '.tsproj'));
  return ws;
}

test('samples/Demo: both PLC projects load, with every source file on disk in them', () => {
  const ws = load();
  assert.deepEqual(ws.loadErrors, []);
  assert.deepEqual(ws.plcProjects.map(p => p.name).sort(), ['DemoLib', 'Machine']);
  const entries = ws.sourceEntries;
  const onDisk = ws.plcProjects.flatMap(p => findFiles(p.dir, '').filter(f => SOURCE.test(f)));
  assert.deepEqual(entries.map(e => path.resolve(e.path)).sort(), onDisk.map(f => path.resolve(f)).sort());
  for (const e of entries) assert.equal(ws.getFile(e.path)?.error, undefined, e.include);
});

test('samples/Demo: no syntax error in any section', () => {
  const ws = load();
  const errors: string[] = [];
  let sections = 0;
  for (const e of ws.sourceEntries) {
    for (const s of ws.getFile(e.path)!.sections.values()) {
      if (!s.editable) continue;
      sections++;
      const r = s.role === 'decl' ? parseDeclaration(s.text) : parseBody(s.text);
      errors.push(...r.errors.map(err => `${s.owner.qualifiedName} [${s.label}] ${err.message}`));
    }
  }
  assert.ok(sections > 40, `${sections} sections read`);
  assert.deepEqual(errors, []);
});

test('samples/Demo: no problem but in the code excluded from the build', () => {
  const ws = load();
  const index = new LanguageIndex(ws);
  index.setStubs(BUNDLED_STUBS);
  const problems: string[] = [];
  for (const ctx of index.allContexts()) {
    const a = analyze(index, ctx, index.sectionText(ctx.fileKey, ctx.sectionKey)!);
    problems.push(...a.problems.map(p => `${ctx.object.qualifiedName} [${ctx.label}] ${p.severity}: ${p.message}`));
  }
  // FB_Prototype is in POUs\Experimental, which Machine.plcproj excludes from the build (ExcludeFromBuild): XAE's
  // build never compiles it. The extension does not read ExcludeFromBuild yet, so it reports the unknown name there.
  assert.deepEqual(problems, ["FB_Prototype [Implementation] error: Unknown identifier 'UnknownSymbol'"]);
});

test('samples/Demo: its files have the bytes XAE wrote, and a section edited and edited back gives them again', () => {
  const ws = load();
  let edited = 0;
  for (const e of ws.sourceEntries) {
    const bytes = fs.readFileSync(e.path);
    const { text, bom } = decodeBytes(bytes);
    // A failure here: git or an editor changed the sample's line endings or BOM (.gitattributes: samples/** -text).
    assert.ok(bom, `${e.include}: BOM`);
    if (!/\.TcTTO$/i.test(e.path)) assert.ok(!/(^|[^\r])\n/.test(text), `${e.include}: CRLF line breaks only`);
    const file = parseTcText(e.path, text, bom);
    for (const [key, s] of file.sections) {
      if (!s.editable) continue;
      const changed = parseTcText(e.path, applySectionEdits(file, [{ key, text: `${s.text}\n// edited` }]).text, bom);
      assert.equal(normalize(changed.sections.get(key)!.text), normalize(`${s.text}\n// edited`), `${e.include} ${s.label}`);
      const back = applySectionEdits(changed, [{ key, text: s.text }]).text;
      assert.ok(Buffer.from(encodeText(back, bom)).equals(bytes), `${e.include} ${s.owner.qualifiedName} [${s.label}]: the bytes again`);
      edited++;
    }
  }
  assert.ok(edited > 40, `${edited} sections edited`);
});

const normalize = (s: string) => s.replace(/\r\n?/g, '\n');
