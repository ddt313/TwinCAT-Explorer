// Line blame of the split editor: the commit that last changed each line of an object view's sections as they
// are in HEAD, from `git blame` of the lines of the file that hold them. The panes map it onto their own text
// with a diff of the section texts: lines changed since HEAD are not committed yet. (Blaming the working file
// would also call the line next to an added one changed: the first and last lines of a section share their
// line of the file with the CDATA tags.)

import { BlameCommit, mergeRanges } from '../core/gitLog';
import { TcSourceFile, sectionFileLines } from '../core/tcfile';
import { BlameResult, blameLines, pathAt, userEmail } from './git';
import { GitChanges } from './gitChanges';

/** Blame of the sections of an object view. */
export interface ViewBlame {
  root: string;
  /** The configured user.email (commits by it are "You"). */
  me: string;
  /**
   * Per section: its text in HEAD ('' when not in HEAD) and, per line of it, the index of its commit in
   * `commits` (-1: unknown).
   */
  sections: { key: string; text: string; lines: number[] }[];
  commits: BlameCommit[];
}

export class BlameService {
  private readonly emails = new Map<string, Promise<string>>();
  /** Blames by file, HEAD commit and sections (they change only when HEAD moves). */
  private readonly cache = new Map<string, Promise<ViewBlame | undefined>>();

  constructor(private readonly git: GitChanges) {}

  /** Blame of sections of a file as it is in HEAD; undefined outside a repository or when HEAD cannot be read. */
  async blameView(fsPath: string, keys: string[]): Promise<ViewBlame | undefined> {
    const root = await this.git.root(fsPath);
    if (!root) return undefined;
    const head = await this.git.headVersion(fsPath);
    if (!head) return undefined;
    const key = `${fsPath.toLowerCase()}|${head.head}|${keys.join(',')}`;
    let blame = this.cache.get(key);
    if (!blame) {
      const computing = this.compute(root, fsPath, head.head, head.file, keys);
      blame = computing;
      this.cache.set(key, computing);
      // A failure is tried again the next time.
      computing.catch(() => {
        if (this.cache.get(key) === computing) this.cache.delete(key);
      });
      if (this.cache.size > 30) this.cache.delete(this.cache.keys().next().value!);
    }
    return blame;
  }

  /**
   * `file`: the file as it is in `commit`, HEAD's commit (undefined: not in it, all its lines are new). Blamed at
   * that commit, not at HEAD, which may have moved meanwhile: the line numbers are that version's.
   */
  private async compute(root: string, fsPath: string, commit: string, file: TcSourceFile | undefined, keys: string[]): Promise<ViewBlame> {
    const sections = keys.map(key => ({ key, section: file?.sections.get(key) }));
    const fileLines = sections.map(s => (s.section && file ? sectionFileLines(file, s.section) : []));
    const ranges = mergeRanges(fileLines.filter(l => l.length).map(l => [l[0], l[l.length - 1]] as [number, number]));
    const relPath = ranges.length ? await pathAt(root, fsPath, commit) : undefined;
    const result: BlameResult | undefined = relPath ? await blameLines(root, commit, relPath, ranges) : undefined;
    const commits: BlameCommit[] = [];
    const indexes = new Map<string, number>();
    const indexOf = (sha: string | undefined): number => {
      const c = sha ? result?.commits.get(sha) : undefined;
      if (!c) return -1;
      let i = indexes.get(c.sha);
      if (i === undefined) {
        i = commits.push(c) - 1;
        indexes.set(c.sha, i);
      }
      return i;
    };
    return {
      root,
      me: await this.email(root),
      sections: sections.map((s, i) => ({
        key: s.key,
        text: s.section?.text ?? '',
        lines: fileLines[i].map(line => indexOf(result?.lines.get(line))),
      })),
      commits,
    };
  }

  private email(root: string): Promise<string> {
    let email = this.emails.get(root);
    if (!email) {
      email = userEmail(root);
      this.emails.set(root, email);
    }
    return email;
  }
}
