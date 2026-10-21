// The review threads of a pull or merge request, read-only, in one shape whatever the host (gitlab.ts and github.ts
// read them), and where each goes in a file's TwinCAT view: under the section line its XML line is on (the view's
// lines know their XML line from sectionFileLines, on the base file for a line of the base and on the head file for
// a line of the head), under a section without lines (graphical code), in the list of comments on the XML (a line in
// no section, such as LineIds or the XML around the code, and a comment on the whole file), or in the list of
// outdated ones (made on other commits than the page compares). Platform-free.

import { FileView } from './model';

export type Side = 'L' | 'R';

export interface ReviewNote {
  id: string;
  author: string;
  /** ISO 8601. */
  created: string;
  /** The note's Markdown, shown as text. */
  body: string;
}

/** Where a thread is: a line of the file's diff, on the commits the diff compared. */
export interface ThreadPosition {
  /** Paths at the base and at the head (GitHub gives one path). */
  oldPath?: string;
  newPath?: string;
  /** Line of the XML file at the base (a removed or unchanged line) and at the head (an added or unchanged line). */
  oldLine?: number;
  newLine?: number;
  /** The first line of a comment on several lines. */
  start?: { side: Side; line: number };
  /** The commits of the diff; no base: the one the page compares with (GitHub says the head only). */
  base?: string;
  head?: string;
  /** On the file as a whole, not on a line. */
  file?: boolean;
}

export interface ReviewThread {
  id: string;
  /** The id of its element in the host's page (`note_12` on GitLab, `discussion_r12` on GitHub). */
  anchor: string;
  /** The thread on the host's site, for a new tab. */
  url?: string;
  /** The first note, then the replies. */
  notes: ReviewNote[];
  /** Undefined when the host does not say (GitHub without a token) or the thread cannot be resolved. */
  resolved?: boolean;
  /** Where it is, on the commits each position was made or carried to, the current one first. */
  positions: ThreadPosition[];
}

/** The threads of a review page, or why there are none. */
export interface ThreadsResult {
  threads: ReviewThread[];
  /** Where they were read, for the diagnostics. */
  source?: string;
  /** Why they could not be read (signed out, a token needed). */
  problem?: string;
}

/** The threads on a file, by its path at the head (for a deleted file: at the base) and at the base. */
export function threadsOfFile(threads: ReviewThread[], path: string, oldPath?: string): ReviewThread[] {
  const base = oldPath ?? path;
  return threads.filter(t => t.positions.some(p => p.newPath === path || p.oldPath === base));
}

/** The position of a thread on the commits the page compares, if it has one: the others are outdated. */
export function currentPosition(t: ReviewThread, commits: { base: string; head: string }): ThreadPosition | undefined {
  return t.positions.find(p => p.head === commits.head && (p.base === undefined || p.base === commits.base));
}

export interface PlacedThread {
  thread: ReviewThread;
  /** The position used: the current one (the first one for an outdated thread). */
  position?: ThreadPosition;
  /** The XML line it is on, in the version of that side. */
  side?: Side;
  line?: number;
  /** For a comment on the XML: the object view whose XML the line is in. */
  object?: number;
}

/** A section line of a view: object, section and line indexes. */
export interface LineRef {
  o: number;
  s: number;
  k: number;
}

export interface Placement {
  /** Under a section line, by `o:s:k`. */
  lines: Map<string, PlacedThread[]>;
  /** Under a section without lines (graphical code), by `o:s`. */
  sections: Map<string, PlacedThread[]>;
  /** On the XML: a line in no section, or the whole file. */
  xml: PlacedThread[];
  /** On other commits than the page compares. */
  outdated: PlacedThread[];
  /** The threads under the lines and sections of each object view. */
  perObject: number[];
  /** Where each thread went: its object view, and its line or section (`o:s:k`, `o:s`). */
  where: Map<string, { o: number; key: string }>;
}

export const lineKey = (r: LineRef) => `${r.o}:${r.s}:${r.k}`;

/**
 * The section lines of a view by their XML line, on each side: a line of the base (removed or unchanged) by its line
 * in the base file, a line of the head (added or unchanged) by its line in the head file. The first one when two
 * share an XML line.
 */
export function xmlLineIndex(view: FileView): Record<Side, Map<number, LineRef>> {
  const index: Record<Side, Map<number, LineRef>> = { L: new Map(), R: new Map() };
  view.objects.forEach((obj, o) => obj.sections.forEach((sec, s) => sec.lines.forEach((l, k) => {
    if (l.kind !== 'add' && l.oldXml !== undefined && !index.L.has(l.oldXml)) index.L.set(l.oldXml, { o, s, k });
    if (l.kind !== 'del' && l.newXml !== undefined && !index.R.has(l.newXml)) index.R.set(l.newXml, { o, s, k });
  })));
  return index;
}

/** The object view whose XML has this line (the innermost one: a member starts after its POU), if any. */
function objectAt(view: FileView, side: Side, line: number): number | undefined {
  let best: number | undefined;
  let bestStart = 0;
  view.objects.forEach((o, i) => {
    const span = side === 'L' ? o.oldXmlSpan : o.newXmlSpan;
    if (span && span[0] <= line && line <= span[1] && span[0] > bestStart) {
      best = i;
      bestStart = span[0];
    }
  });
  return best;
}

/** The section without lines (graphical code) whose XML has this line, if any. */
function graphicalAt(view: FileView, side: Side, line: number): { o: number; s: number } | undefined {
  for (let o = 0; o < view.objects.length; o++) {
    const sections = view.objects[o].sections;
    for (let s = 0; s < sections.length; s++) {
      const sec = sections[s];
      const [from, to] = side === 'L' ? [sec.oldXml, sec.oldXmlEnd] : [sec.newXml, sec.newXmlEnd];
      if (!sec.text && from !== undefined && to !== undefined && from <= line && line <= to) return { o, s };
    }
  }
  return undefined;
}

/** Where the threads of a file go in its view, for the commits the page compares. */
export function placeThreads(view: FileView, threads: ReviewThread[], commits: { base: string; head: string }): Placement {
  const out: Placement = { lines: new Map(), sections: new Map(), xml: [], outdated: [], perObject: view.objects.map(() => 0), where: new Map() };
  const index = xmlLineIndex(view);
  const put = (map: Map<string, PlacedThread[]>, key: string, o: number, p: PlacedThread) => {
    map.set(key, [...(map.get(key) ?? []), p]);
    out.perObject[o]++;
    out.where.set(p.thread.id, { o, key });
  };
  for (const thread of threads) {
    const position = currentPosition(thread, commits);
    if (!position) {
      out.outdated.push({ thread, position: thread.positions[0] });
      continue;
    }
    // An unchanged line has both: the head's line first, as the view's unchanged lines show the head's text.
    const sides = ([['R', position.newLine], ['L', position.oldLine]] as const).filter((x): x is readonly [Side, number] => x[1] !== undefined);
    if (position.file || sides.length === 0) {
      out.xml.push({ thread, position });
      continue;
    }
    const hit = sides.map(([side, line]) => ({ side, line, ref: index[side].get(line) })).find(x => x.ref);
    if (hit?.ref) {
      put(out.lines, lineKey(hit.ref), hit.ref.o, { thread, position, side: hit.side, line: hit.line });
      continue;
    }
    const [side, line] = sides[0];
    const graphical = graphicalAt(view, side, line);
    if (graphical) {
      put(out.sections, `${graphical.o}:${graphical.s}`, graphical.o, { thread, position, side, line });
      continue;
    }
    out.xml.push({ thread, position, side, line, object: objectAt(view, side, line) });
  }
  return out;
}

/** The threads that are unresolved, of those that can be resolved. */
export function unresolvedCount(threads: ReviewThread[]): number {
  return threads.filter(t => t.resolved === false).length;
}
