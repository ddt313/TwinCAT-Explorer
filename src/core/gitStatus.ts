// The status of the working tree against HEAD, which colors the folders of the TwinCAT tree: a folder takes the
// strongest change of what it holds (a conflict, then a deletion, a modification, an addition).

/** How a path differs from HEAD; `untracked` is new and not added to the index. */
export type PathStatus = 'conflict' | 'deleted' | 'modified' | 'added' | 'untracked';

/** The strongest first: what a folder holding several changes shows. */
export const STATUS_ORDER: readonly PathStatus[] = ['conflict', 'deleted', 'modified', 'added', 'untracked'];

const CONFLICTS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/**
 * The output of `git status --porcelain=v1 -z --untracked-files=all`: the status of each changed path
 * (repository-relative, `/`-separated). A renamed file is added where it is now and deleted where it was.
 */
export function parsePorcelainStatus(out: string): Map<string, PathStatus> {
  const result = new Map<string, PathStatus>();
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const p = entry.slice(3);
    if (CONFLICTS.has(xy)) {
      result.set(p, 'conflict');
      continue;
    }
    if (xy === '??') {
      result.set(p, 'untracked');
      continue;
    }
    // A rename or copy is followed by the path it came from.
    if (xy[0] === 'R' || xy[0] === 'C') {
      const from = tokens[++i];
      if (xy[0] === 'R' && from) result.set(from, 'deleted');
      if (xy[1] !== 'D') result.set(p, 'added');
      continue;
    }
    // Added to the index and deleted since: as in HEAD, it is not there.
    if (xy === 'AD') continue;
    if (xy.includes('D')) result.set(p, 'deleted');
    else if (xy[0] === 'A') result.set(p, 'added');
    else result.set(p, 'modified');
  }
  return result;
}

/** How many changes of each kind a folder holds; undefined when it holds none. */
export type StatusCounts = Partial<Record<PathStatus, number>>;

export function countStatuses(statuses: Iterable<PathStatus>): StatusCounts | undefined {
  const counts: StatusCounts = {};
  let any = false;
  for (const s of statuses) {
    counts[s] = (counts[s] ?? 0) + 1;
    any = true;
  }
  return any ? counts : undefined;
}

/** The status a folder shows: the strongest of what it holds. */
export function strongestStatus(counts: StatusCounts): PathStatus | undefined {
  return STATUS_ORDER.find(s => counts[s]);
}

/** `2 modified, 1 deleted`, the strongest first. */
export function describeCounts(counts: StatusCounts): string {
  return STATUS_ORDER.filter(s => counts[s]).map(s => `${counts[s]} ${s}`).join(', ');
}
