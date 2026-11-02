import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { XaeInstance, solutionsWith, xaeWith } from '../../src/core/xae';

/** A solution file listing these projects, by path from the solution's folder. */
const sln = (...projects: string[]) => `Microsoft Visual Studio Solution File, Format Version 12.00
# Visual Studio 15
${projects.map((p, i) => `Project("{B1E792BE-AA5F-4E3C-8C82-674BF9C0715B}") = "${path.basename(p, '.tsproj')}", "${p}", "{1111111${i}-0000-0000-0000-000000000000}"
EndProject
`).join('')}Global
EndGlobal
`;

test('solutionsWith keeps the solutions that list the TwinCAT project, by its path from each', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twincat-sln-'));
  try {
    const write = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
      return path.join(root, rel);
    };
    const tsproj = path.join(root, 'Projects', 'Machine', 'Machine.tsproj');
    const own = write('Solutions/Machine/Machine.sln', sln('..\\..\\Projects\\Machine\\Machine.tsproj'));
    const all = write('All.sln', sln('Projects\\Simulation\\Simulation.tsproj', 'Projects\\Machine\\Machine.tsproj'));
    const other = write('Solutions/Simulation/Simulation.sln', sln('..\\..\\Projects\\Simulation\\Simulation.tsproj'));
    // A project of the same name elsewhere is another project.
    const lookalike = write('Old/Old.sln', sln('Machine\\Machine.tsproj'));
    const missing = path.join(root, 'Gone.sln');
    assert.deepEqual(solutionsWith(tsproj, [own, all, other, lookalike, missing]), [own, all]);
    assert.deepEqual(solutionsWith(tsproj, []), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('xaeWith finds the XAE that has the project open, else the one with the solution, never one without a solution', () => {
  const root = path.join(os.tmpdir(), 'repo');
  const tsproj = path.join(root, 'Projects', 'Machine', 'Machine.tsproj');
  const solution = path.join(root, 'Solutions', 'Machine', 'Machine.sln');
  const xae = (pid: number, sln: string, projects: string[]): XaeInstance => ({ pid, progId: 'TcXaeShell.DTE.15.0', solution: sln, projects });
  const empty = xae(1, '', []);
  const other = xae(2, path.join(root, 'Solutions', 'Simulation', 'Simulation.sln'), [path.join(root, 'Projects', 'Simulation', 'Simulation.tsproj')]);
  // A solution that also has the project, open in another XAE.
  const all = xae(3, path.join(root, 'All.sln'), [path.join(root, 'Projects', 'Simulation', 'Simulation.tsproj'), tsproj]);
  // The solution open, its TwinCAT project not loaded.
  const unloaded = xae(4, solution, []);

  assert.equal(xaeWith([empty, other, all, unloaded], tsproj)?.pid, 3);
  assert.equal(xaeWith([empty, other, all, unloaded], tsproj, solution)?.pid, 3);
  assert.equal(xaeWith([empty, other, unloaded], tsproj), undefined);
  assert.equal(xaeWith([empty, other, unloaded], tsproj, solution)?.pid, 4);
  assert.equal(xaeWith([empty, other], tsproj, solution), undefined);
  // An XAE with no solution open is not one with the solution, whatever the solution's path.
  assert.equal(xaeWith([empty], tsproj, process.cwd()), undefined);
  assert.equal(xaeWith([], tsproj, solution), undefined);
});
