// Snippets of Structured Text statements and of region pragmas, offered by the completion of the split editor's
// panes and of notebook cells (snippets contributed to VS Code do not reach the split editor's webview).

import { CompletionContext } from './completion';

export interface Snippet {
  label: string;
  /** What it inserts, in short. */
  detail: string;
  /** In VS Code's snippet syntax: tab stops `$1`, placeholders `${1:condition}`, the final cursor `$0`. */
  body: string;
}

/** Statements, keywords in upper case like the code TwinCAT writes; tabs become the editor's indentation. */
export const STATEMENT_SNIPPETS: Snippet[] = [
  { label: 'IF', detail: 'IF ... THEN ... END_IF', body: 'IF ${1:condition} THEN\n\t$0\nEND_IF' },
  { label: 'IF ELSE', detail: 'IF ... THEN ... ELSE ... END_IF', body: 'IF ${1:condition} THEN\n\t$2\nELSE\n\t$0\nEND_IF' },
  {
    label: 'IF ELSIF ELSE', detail: 'IF ... THEN ... ELSIF ... ELSE ... END_IF',
    body: 'IF ${1:condition} THEN\n\t$2\nELSIF ${3:condition} THEN\n\t$4\nELSE\n\t$0\nEND_IF',
  },
  { label: 'ELSIF', detail: 'ELSIF ... THEN', body: 'ELSIF ${1:condition} THEN\n\t$0' },
  { label: 'CASE', detail: 'CASE ... OF ... END_CASE', body: 'CASE ${1:expression} OF\n\t${2:0}:\n\t\t$0\nEND_CASE' },
  { label: 'FOR', detail: 'FOR ... TO ... DO ... END_FOR', body: 'FOR ${1:i} := ${2:1} TO ${3:10} DO\n\t$0\nEND_FOR' },
  { label: 'WHILE', detail: 'WHILE ... DO ... END_WHILE', body: 'WHILE ${1:condition} DO\n\t$0\nEND_WHILE' },
  { label: 'REPEAT', detail: 'REPEAT ... UNTIL ... END_REPEAT', body: 'REPEAT\n\t$0\nUNTIL ${1:condition}\nEND_REPEAT' },
];

/** The region pragmas, which fold the code between them; in declarations too. */
export const REGION_SNIPPETS: Snippet[] = [
  { label: 'region', detail: '{region "..."} ... {endregion}', body: '{region "${1:name}"}\n$0\n{endregion}' },
  { label: 'endregion', detail: '{endregion}', body: '{endregion}' },
];

export interface SnippetItem extends Snippet {
  /** The body as it looks once inserted, placeholders filled in. */
  preview: string;
  /** The text it replaces when it is not the word at the cursor: a `{` typed before it and the `}` after it. */
  range?: { start: number; end: number };
  filterText?: string;
}

/** The snippets for a place: statements where a statement starts, region pragmas on a line of their own. */
export function snippetsAt(role: 'decl' | 'impl', cc: CompletionContext): SnippetItem[] {
  const items: SnippetItem[] = [];
  if (role === 'impl' && cc.statement && !cc.inComment) {
    for (const s of STATEMENT_SNIPPETS) items.push({ ...s, preview: snippetPreview(s.body) });
  }
  // `{reg` is a pragma being typed, not a comment.
  if (cc.lineStart && (cc.brace || !cc.inComment)) {
    for (const s of REGION_SNIPPETS) {
      items.push({ ...s, preview: snippetPreview(s.body), range: cc.brace, filterText: cc.brace ? `{${s.label}` : undefined });
    }
  }
  return items;
}

/** A snippet body with its placeholders filled in and its tab stops left out. */
export function snippetPreview(body: string): string {
  return body.replace(/\$\{\d+:([^}]*)\}|\$\{\d+\}|\$\d+|\\([\\$}])/g,
    (_m, placeholder?: string, escaped?: string) => placeholder ?? escaped ?? '');
}
