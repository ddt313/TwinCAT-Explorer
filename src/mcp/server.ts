// MCP server of Explorer for TwinCAT: the TwinCAT projects under a folder for an AI agent (Claude Code and other MCP
// clients), over stdio. Objects are named as the split editor's tabs (`FB_Valve.Open`), code is read and written per
// declaration and implementation, and the .TcPOU XML is never handed out or edited as text.
//
//   node out/mcp/server.js [--root <folder>] [--no-xae]   (root: the current folder by default)

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Session, ToolError } from './session';
import { UndoLog, defaultUndoFile } from './undo';
import { Xae } from '../core/xae';
import * as T from './tools';
import { ACCESS_KINDS } from '../lang/features';

const INSTRUCTIONS = `TwinCAT 3 PLC code under this folder. .TcPOU, .TcDUT, .TcGVL and .TcIO files are XML: never read or edit them as text; use these tools.
- Objects are named like TwinCAT XAE's tabs: FB_Valve, FB_Valve.Open (method), FB_Valve.Speed.Get (property accessor). With several PLC projects: Machine:FB_Valve.
- Code is per section: part "decl" (declaration) or "impl" (implementation); lines count from 1 within the section.
- Read before editing; pass the hash from the read to write_section (edit_section takes it optionally). A changed section is refused: read it again.
- Lines of these files in git diff or git blame: locate tells the object, part and line of code they are.
- To find a text in the code, use search_text rather than searching the XML files.
- When TwinCAT XAE has the project open, code is read and written in XAE itself: XAE shows the change and saves that object at once. A file with unsaved edits in XAE is refused unless the user agrees (saveUserEdits: true), as the change would save them too.
- Every write is saved at once and can be taken back with undo_last_edit; TwinCAT XAE's own Ctrl+Z does not undo it.
- check is the extension's syntax and name check; check with compiler: true runs TwinCAT XAE's Check all objects when XAE has the project open, which also compiles objects the PLC project does not use. build runs XAE's Build PLC project, the build status the user sees in XAE.`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const root = arg('--root') ?? process.cwd();
const tools: T.Tools = { session: new Session(root), undo: new UndoLog(root, defaultUndoFile()), xae: process.argv.includes('--no-xae') ? undefined : new Xae() };

/** Runs a tool on fresh projects; a ToolError (or any error) comes back as the tool's error text. */
function run<A>(fn: (t: T.Tools, a: A) => string) {
  return async (a: A) => {
    try {
      tools.session.refresh();
      await tools.session.installedLibraries();
      return { content: [{ type: 'text' as const, text: fn(tools, a) }] };
    } catch (e) {
      const message = e instanceof ToolError ? e.message : `${(e as Error).message ?? e}`;
      return { content: [{ type: 'text' as const, text: message }], isError: true };
    }
  };
}

const server = new McpServer({ name: 'twincat', version: '0.1.0' }, { instructions: INSTRUCTIONS });

/**
 * registerTool with a plain signature: the SDK's generic one makes TypeScript infer through zod for every tool,
 * which takes minutes and gigabytes. The handlers check their own arguments' types (tools.ts).
 */
type Register = (name: string, config: { description: string; inputSchema: Record<string, z.ZodTypeAny>; annotations?: Record<string, boolean> },
  callback: (args: never) => Promise<unknown>) => void;
const register = server.registerTool.bind(server) as unknown as Register;

const object = z.string().describe('Object name: FB_Valve, FB_Valve.Open, FB_Valve.Speed.Get, Machine:FB_Valve');
const part = z.enum(['decl', 'impl']).describe('decl: declaration, impl: implementation');
const symbolRef = {
  symbol: z.string().optional().describe('A name: FB_Valve, FB_Valve.Open, GVL_IO.bStart, E_State.Idle'),
  object: object.optional().describe('Or: the object where the name is used'),
  part: part.optional(),
  line: z.number().int().positive().optional().describe('Line in the section, from 1'),
  word: z.string().optional().describe('The name as written on that line'),
};
const readOnly = { readOnlyHint: true, openWorldHint: false };

register('status', {
  description: 'The folder, its TwinCAT and PLC projects, projects that did not load, and how many edits can be undone.',
  inputSchema: {}, annotations: readOnly,
}, run(t => T.status(t)));

register('objects', {
  description: 'The objects of the PLC projects (POUs, DUTs, GVLs, interfaces) with their methods, properties, accessors and actions, like XAE\'s tree.',
  inputSchema: {
    project: z.string().optional(), filter: z.string().optional().describe('Part of a name'),
    offset: z.number().int().min(0).optional(), limit: z.number().int().positive().optional(),
  },
  annotations: readOnly,
}, run(T.objects));

register('read', {
  description: 'The declaration and implementation of an object, with line numbers and the hash to pass when writing.',
  inputSchema: { object, part: part.optional(), from: z.number().int().positive().optional(), to: z.number().int().positive().optional() },
  annotations: readOnly,
}, run(T.read));

register('locate', {
  description: 'Which object, part and line of code are at lines of a .TcPOU, .TcDUT, .TcGVL or .TcIO file, as git diff and git blame number them (the file as it is now).',
  inputSchema: {
    file: z.string().describe('Path of the file, relative to the folder, as git shows it'), line: z.number().int().positive(),
    to: z.number().int().positive().optional().describe('Last line of a range, such as a diff hunk'),
  },
  annotations: readOnly,
}, run(T.locate));

register('search_text', {
  description: 'Finds a text, or a regular expression, in the code of the objects (declarations and implementations, as read shows them; never their XML): each line with a match, as object, part and line. Case aside unless matchCase.',
  inputSchema: {
    query: z.string(),
    regex: z.boolean().optional().describe('query is a regular expression, RE2 syntax (no lookahead, no backreferences); ^ and $ match at each line'),
    matchCase: z.boolean().optional(),
    wholeWord: z.boolean().optional().describe('Not part of a longer name'),
    skipComments: z.boolean().optional().describe('Leave out the matches in comments'),
    project: z.string().optional().describe('Only this PLC project'),
    folder: z.string().optional().describe('Only this folder of the PLC projects, with its subfolders: POUs/Valves'),
    limit: z.number().int().positive().optional().describe('Lines shown, 200 by default'),
  },
  annotations: readOnly,
}, run(T.searchText));

register('find_symbol', {
  description: 'POUs, DUTs, GVLs, methods, properties and global variables by name (fuzzy, as Ctrl+T).',
  inputSchema: { query: z.string(), limit: z.number().int().positive().optional() },
  annotations: readOnly,
}, run(T.findSymbol));

register('definition', {
  description: 'Declaration, comment and place of a symbol, given by name or by a word on a line of an object.',
  inputSchema: symbolRef, annotations: readOnly,
}, run(T.definition));

register('references', {
  description: 'Every place a symbol is declared or used in the Structured Text of the workspace, each with how it is used there: '
    + 'declaration, write (target of :=, S=, R=, REF= or =>, FOR variable, input passed in a call), readwrite (passed to a VAR_IN_OUT), '
    + 'address (ADR, BITADR, REF=), call, read, or type. A variable written, read or called through a member or index shows it: '
    + '"write .eState" for stStatus.eState := x. Only code in the workspace: not I/O mapping, ADS or HMI writes, not writes through pointers. '
    + 'Who writes a variable: access ["write", "readwrite", "address"].',
  inputSchema: {
    ...symbolRef, limit: z.number().int().positive().optional(),
    access: z.array(z.enum(ACCESS_KINDS)).optional().describe('Only the places used so'),
  }, annotations: readOnly,
}, run(T.references));

register('calls', {
  description: 'The call hierarchy of a function, program, function block (its body: an instance called), method or action: '
    + 'incoming (default), what calls it, with the tasks that call a program and, for a method, the calls through the interface '
    + 'or base method it implements or overrides ("via"); or outgoing, what it calls. Each caller or callee, its calls (·), then '
    + 'one level deeper up to depth (1 to 5). Built-in functions are left out; library POUs end the hierarchy.',
  inputSchema: {
    ...symbolRef,
    direction: z.enum(['incoming', 'outgoing']).optional(),
    depth: z.number().int().min(1).max(5).optional(),
    limit: z.number().int().positive().optional(),
  }, annotations: readOnly,
}, run(T.calls));

register('hierarchy', {
  description: 'Supertypes and subtypes of a function block or interface; for a method or property, what implements or overrides it.',
  inputSchema: symbolRef, annotations: readOnly,
}, run(T.hierarchy));

register('check', {
  description: "Syntax errors and unknown names of one object, or of all code when no object is given; with compiler: true, TwinCAT XAE's Check all objects of the object's PLC project, or of all (needs XAE open on the project). Check all objects compiles every object, also unused ones: for the build status, use build.",
  inputSchema: { object: object.optional(), limit: z.number().int().positive().optional(), compiler: z.boolean().optional() }, annotations: readOnly,
}, run(T.check));

register('build', {
  description: "TwinCAT XAE's Build PLC project of a PLC project, or of all (needs XAE open on the project): whether it succeeded, and the compiler's errors and warnings. Compiles what the PLC project uses, as XAE's Build menu does. XAE saves its unsaved files before a build, so one with unsaved edits in XAE is refused unless the user agrees (saveUserEdits: true).",
  inputSchema: {
    project: z.string().optional().describe('The PLC project; all by default'),
    limit: z.number().int().positive().optional().describe('Messages shown per project, 200 by default'),
    saveUserEdits: z.boolean().optional().describe("Also save the user's unsaved edits in XAE, as the build does, when they agreed"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, run(T.build));

register('edit_section', {
  description: 'Replaces oldText (exactly once in the section) with newText in an object\'s declaration or implementation, and saves the file. Renaming the object through its header is refused.',
  inputSchema: { object, part, oldText: z.string(), newText: z.string(), hash: z.string().optional().describe('Hash from read; refused if the section changed since'), saveUserEdits: z.boolean().optional().describe("With TwinCAT XAE open: also save the user's unsaved edits of the file, when they agreed"), },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, run(T.editSection));

register('write_section', {
  description: 'Replaces the whole declaration or implementation of an object and saves the file.',
  inputSchema: { object, part, text: z.string(), hash: z.string().describe('Hash from read; refused if the section changed since'), saveUserEdits: z.boolean().optional().describe("With TwinCAT XAE open: also save the user's unsaved edits of the file, when they agreed"), },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, run(T.writeSection));

register('add_member', {
  description: 'Adds a method, property (with Get and/or Set) or action to a POU or interface, as XAE writes it.',
  inputSchema: {
    owner: object.describe('The POU or interface'), kind: z.enum(['method', 'property', 'action']), name: z.string(),
    type: z.string().optional().describe('Return type of a method, type of a property'),
    accessors: z.array(z.enum(['Get', 'Set'])).optional(), folder: z.string().optional().describe('Folder inside the POU'), saveUserEdits: z.boolean().optional().describe("With TwinCAT XAE open: also save the user's unsaved edits of the file, when they agreed"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, run(T.addMember));

register('add_object', {
  description: 'Adds a POU, DUT, GVL or interface file to a PLC project folder and its .plcproj, as XAE writes it.',
  inputSchema: {
    project: z.string().optional(), folder: z.string().optional().describe('POUs, POUs/Valves, ...'),
    kind: z.enum(['FB', 'PRG', 'FUN', 'ITF', 'STRUCT', 'ENUM', 'UNION', 'ALIAS', 'GVL']), name: z.string(),
    extends: z.string().optional(), implements: z.string().optional(), type: z.string().optional().describe('Return type of a function, type of an alias'), saveUserEdits: z.boolean().optional().describe("With TwinCAT XAE open: also save the user's unsaved edits of the .plcproj, when they agreed"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, run(T.addObject));

register('delete_member', {
  description: 'Deletes a method, property, accessor, action or transition. What uses it is not changed.',
  inputSchema: { object, confirm: z.boolean(), saveUserEdits: z.boolean().optional().describe("With TwinCAT XAE open: also save the user's unsaved edits of the file, when they agreed"), },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
}, run(T.deleteMember));

register('undo_last_edit', {
  description: 'Takes back the last edit made through these tools (or the one with this id), if the code was not changed since.',
  inputSchema: { id: z.number().int().positive().optional() },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, run(T.undoLastEdit));

register('edit_history', {
  description: 'The edits made through these tools in this folder, newest first, with their ids.',
  inputSchema: { limit: z.number().int().positive().optional() }, annotations: readOnly,
}, run(T.editHistory));

void server.connect(new StdioServerTransport());
