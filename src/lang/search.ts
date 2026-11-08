// Text search in the Structured Text of the TwinCAT objects, as the split editor shows it: in each section (declaration,
// implementation) of the POUs, methods, property accessors, actions, transitions, DUTs, GVLs and interfaces of the PLC
// projects, never in their XML. A text, whole word or not, is found with JavaScript's regular expressions, escaped; a
// regular expression the user types runs on re2js (re2.ts), in linear time whatever it is, with RE2's syntax.
// Shared by the TwinCAT Search view and the MCP server's search_text. Independent of the VS Code API.

import { RE2JS } from './re2';
import { lex } from './lexer';
import { sameName } from '../core/project';
import { Section, TcObject, TcSourceFile } from '../core/tcfile';
import { SourceEntry, fileKey } from '../core/workspace';

export interface SearchQuery {
  text: string;
  /** Upper and lower case differ; by default they do not, as in Structured Text. */
  matchCase?: boolean;
  /** Only where the text is not part of a longer name: no letter, digit or `_` joins it before or after. */
  wholeWord?: boolean;
  /** The text is a regular expression (RE2's syntax: no lookahead, no backreferences). */
  regex?: boolean;
  /** Leave out the matches in comments (`//`, `(* *)`); those in pragmas and strings stay. */
  skipComments?: boolean;
}

/** A query that cannot run: an invalid regular expression, an empty text. */
export class QueryError extends Error {}

/** A match in a section's text: offsets, end excluded. */
export interface Match {
  start: number;
  end: number;
}

/** A query ready to run on the texts of sections. */
export interface Matcher {
  /** The matches in a text, in order, at most `limit`. */
  matches(text: string, limit?: number): Match[];
}

/** Finds the matches in a text that `accept` takes, at most `limit`. */
type Finder = (text: string, accept: (start: number, end: number) => boolean, limit: number) => Match[];

/** A character of a name: `A`-`Z`, `a`-`z`, `0`-`9` and `_`. */
function isWordChar(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

/** Whether no character of a name joins a match from outside, before or after it. */
function isWholeWord(text: string, start: number, end: number): boolean {
  const joined = (at: number) => at > 0 && at < text.length && isWordChar(text.charCodeAt(at - 1)) && isWordChar(text.charCodeAt(at));
  return !joined(start) && !joined(end);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A text: a JavaScript regular expression, escaped, which cannot backtrack. */
function textFinder(q: SearchQuery): Finder {
  let source = escapeRegExp(q.text);
  if (q.wholeWord) {
    // A boundary is needed only where the text starts or ends with a character of a name.
    if (isWordChar(q.text.charCodeAt(0))) source = `(?<![A-Za-z0-9_])${source}`;
    if (isWordChar(q.text.charCodeAt(q.text.length - 1))) source = `${source}(?![A-Za-z0-9_])`;
  }
  const re = new RegExp(source, q.matchCase ? 'g' : 'gi');
  return (text, accept, limit) => {
    const out: Match[] = [];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    // Never empty: each match moves lastIndex on.
    while (out.length < limit && (m = re.exec(text))) {
      const end = m.index + m[0].length;
      if (accept(m.index, end)) out.push({ start: m.index, end });
    }
    return out;
  };
}

/** The message of an invalid regular expression, with what RE2 lacks that JavaScript has. */
function regexError(pattern: string, e: unknown): string {
  const message = `Invalid regular expression: ${String((e as Error).message ?? e).replace(/^error parsing regexp: /, '')}`;
  if (/\(\?[=!]/.test(pattern)) return `${message} (lookahead is not supported)`;
  if (/\\[1-9]/.test(pattern)) return `${message} (backreferences are not supported)`;
  return message;
}

/** A regular expression the user typed: re2js, in linear time; `^` and `$` at the start and end of each line. */
function regexFinder(q: SearchQuery): Finder {
  let re: RE2JS;
  try {
    re = RE2JS.compile(q.text, (q.matchCase ? 0 : RE2JS.CASE_INSENSITIVE) | RE2JS.MULTILINE | RE2JS.LOOKBEHINDS);
  } catch (e) {
    throw new QueryError(regexError(q.text, e));
  }
  return (text, accept, limit) => {
    const out: Match[] = [];
    const m = re.matcher(text);
    let from = 0;
    while (out.length < limit && from <= text.length && m.find(from)) {
      const start = m.start();
      const end = m.end();
      // Empty matches (`x*`) are no result. A match that is not a whole word, or is in a comment, is looked for again
      // one character further: a whole word may start there.
      if (end > start && (!q.wholeWord || isWholeWord(text, start, end)) && accept(start, end)) {
        out.push({ start, end });
        from = end;
      } else {
        from = start + 1;
      }
    }
    return out;
  };
}

/** Whether a match is outside the comments of a text, asked for matches in order; the text is lexed on the first one. */
function outsideComments(text: string): (start: number) => boolean {
  let comments: { start: number; end: number }[] | undefined;
  let i = 0;
  return start => {
    comments ??= lex(text).trivia.filter(t => t.kind === 'comment');
    while (i < comments.length && comments[i].end <= start) i++;
    return !(i < comments.length && comments[i].start <= start);
  };
}

/** Makes a query ready to run; a QueryError when it cannot. */
export function compileQuery(q: SearchQuery): Matcher {
  if (!q.text) throw new QueryError('Type the text to search for');
  const find = q.regex ? regexFinder(q) : textFinder(q);
  return {
    matches(text, limit = Number.MAX_SAFE_INTEGER) {
      return find(text, q.skipComments ? outsideComments(text) : () => true, limit);
    },
  };
}

// ------------------------------------------------------------------ where to search

export type SearchScope =
  | { kind: 'all' }
  /** PLC projects, by the path of their .plcproj. */
  | { kind: 'projects'; plcprojPaths: string[] }
  /** A folder of a PLC project (`POUs\Valves`, `/` too), with its subfolders; of every PLC project without plcprojPath. */
  | { kind: 'folder'; plcprojPath?: string; folder: string }
  /** A folder inside a POU (`Methods`, `States`): its methods, properties, actions and transitions, subfolders included. */
  | { kind: 'objectFolder'; fsPath: string; folderPath: string[] };

/** Whether a member of a POU is in a folder inside it, or in a subfolder of that folder (names compared case aside). */
function inObjectFolder(obj: TcObject, folderPath: string[]): boolean {
  return !!obj.parent && folderPath.length <= obj.folderPath.length && folderPath.every((f, i) => sameName(f, obj.folderPath[i]));
}

/** Which source files are in a scope. */
export function entryFilter(scope: SearchScope): (entry: SourceEntry) => boolean {
  switch (scope.kind) {
    case 'all':
      return () => true;
    case 'projects': {
      const keys = new Set(scope.plcprojPaths.map(fileKey));
      return e => keys.has(fileKey(e.project.path));
    }
    case 'folder': {
      const project = scope.plcprojPath && fileKey(scope.plcprojPath);
      const folder = scope.folder.split(/[\\/]+/).filter(s => s).join('\\');
      const prefix = `${folder}\\`;
      return e => (!project || fileKey(e.project.path) === project)
        && (!folder || (e.include.length > prefix.length && sameName(e.include.slice(0, prefix.length), prefix)));
    }
    case 'objectFolder': {
      const key = fileKey(scope.fsPath);
      return e => e.key === key;
    }
  }
}

// ------------------------------------------------------------------ searching

/** The sections a search goes through, and the text of each. */
export interface SearchSource {
  entries: readonly SourceEntry[];
  file(entry: SourceEntry): TcSourceFile | undefined;
  /** The text to search in a section, when not the file's: an editor's with unsaved edits. */
  text?(entry: SourceEntry, section: Section): string | undefined;
}

/** A section with matches. */
export interface SearchHit {
  entry: SourceEntry;
  file: TcSourceFile;
  section: Section;
  /** The text the matches are in. */
  text: string;
  matches: Match[];
}

export interface SearchCount {
  matches: number;
  /** The search stopped at its limit: there may be more. */
  capped: boolean;
}

/**
 * The sections of a scope with matches, in the order of the PLC projects, their files and the sections of a file
 * (Structured Text only), at most `limit` matches in all. Yields undefined after each section without a match, so that
 * the caller can pause between sections; `count` adds up the matches as they come.
 */
export function* searchSections(source: SearchSource, scope: SearchScope, matcher: Matcher, limit: number,
  count: SearchCount = { matches: 0, capped: false }): Generator<SearchHit | undefined, void> {
  const inScope = entryFilter(scope);
  for (const entry of source.entries) {
    if (!inScope(entry)) continue;
    const file = source.file(entry);
    if (!file) continue;
    for (const section of file.sections.values()) {
      if (!section.editable || (scope.kind === 'objectFolder' && !inObjectFolder(section.owner, scope.folderPath))) continue;
      const text = source.text?.(entry, section) ?? section.text;
      // One match more than the limit leaves: whether there are more.
      const room = limit - count.matches;
      const matches = matcher.matches(text, room + 1);
      if (matches.length > room) {
        count.capped = true;
        matches.length = room;
      }
      count.matches += matches.length;
      yield matches.length ? { entry, file, section, text, matches } : undefined;
      if (count.capped) return;
    }
  }
}

// ------------------------------------------------------------------ showing

/** The line of a match, as a list of results shows it. */
export interface MatchLine {
  /** Line and column of the match in its section, from 0. */
  line: number;
  character: number;
  /** The line without its indentation (tabs as spaces), shortened around the match when long. */
  preview: string;
  /** Where the match is in the preview, end excluded; to the end of the line for a match over several lines. */
  highlight: [number, number];
}

/**
 * The line of each match of a section's text (matches in order). `before`: how much of the line before a match the
 * preview keeps at most, from the start of a word, so that a narrow list shows the match (VS Code's search keeps 26).
 */
export function matchLines(text: string, matches: readonly Match[], maxLength = 250, before = Number.MAX_SAFE_INTEGER): MatchLine[] {
  const out: MatchLine[] = [];
  let line = 0;
  let lineStart = 0;
  for (const m of matches) {
    for (let nl = text.indexOf('\n', lineStart); nl >= 0 && nl < m.start; nl = text.indexOf('\n', lineStart)) {
      line++;
      lineStart = nl + 1;
    }
    let lineEnd = text.indexOf('\n', m.start);
    if (lineEnd < 0) lineEnd = text.length;
    const raw = text.slice(lineStart, lineEnd).replace(/\t/g, ' ');
    // The indentation goes, unless the match is in it.
    const indent = Math.min(raw.length - raw.trimStart().length, m.start - lineStart);
    let preview = raw.slice(indent);
    let from = m.start - lineStart - indent;
    let to = Math.min(m.end, lineEnd) - lineStart - indent;
    if (from > before) {
      let cut = from - before;
      const space = preview.indexOf(' ', cut);
      if (space >= 0 && space < from) cut = space + 1;
      preview = `…${preview.slice(cut)}`;
      from = from - cut + 1;
      to = to - cut + 1;
    }
    if (preview.length > maxLength) {
      // Some context before the match, the rest after it.
      const begin = Math.max(0, Math.min(from - 40, preview.length - maxLength));
      const end = Math.min(preview.length, begin + maxLength);
      const head = begin > 0 ? '…' : '';
      preview = head + preview.slice(begin, end) + (end < preview.length ? '…' : '');
      from = from - begin + head.length;
      to = Math.min(to - begin, end - begin) + head.length;
    }
    out.push({ line, character: m.start - lineStart, preview, highlight: [from, Math.max(from, to)] });
  }
  return out;
}
