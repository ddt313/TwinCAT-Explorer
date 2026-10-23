// Language features of a section and an offset that do not depend on an editor: the analysis of a section (cached
// per index version), definition, references, implementations, and where a symbol is declared. The VS Code layer
// (vscode/language.ts) and the MCP server both build on it. Independent of the VS Code API.

import { LanguageIndex, SectionContext } from './index';
import { Analysis, Occurrence, analyze } from './analyzer';
import { Loc, Sym } from './symbols';
import { implementations } from './hierarchy';

/** Where a symbol is declared, for hovers. */
export function describeOwner(s: Sym): string {
  if (s.scope.isLibrary) return s.kind === 'builtin' ? 'Built-in' : `Library ${s.scope.name}`;
  switch (s.kind) {
    case 'var': {
      const owner = s.owner.kind === 'method' || s.owner.kind === 'property' || s.owner.kind === 'action' || s.owner.kind === 'transition'
        ? `${s.owner.owner.name}.${s.owner.name}${s.accessor ? '.' + s.accessor : ''}` : s.owner.name;
      return `${s.section} of ${owner}`;
    }
    case 'method': return `Method of ${s.owner.name}`;
    case 'property': return `Property of ${s.owner.name}`;
    case 'action': return `Action of ${s.owner.name}`;
    case 'transition': return `Transition of ${s.owner.name}`;
    case 'pou': return `${{ FB: 'Function block', PRG: 'Program', FUN: 'Function', ITF: 'Interface' }[s.pouKind]} in ${s.scope.name}`;
    case 'type': return `${s.dutKind === 'enum' ? 'Enumeration' : s.dutKind === 'alias' ? 'Alias' : s.dutKind === 'union' ? 'Union' : 'Structure'} in ${s.scope.name}`;
    case 'enumValue': return `Value of ${s.owner.name}`;
    case 'gvl': return `Global variable list in ${s.scope.name}`;
    case 'namespace': return 'Library namespace';
    case 'builtin': return 'Built-in';
  }
}

interface CachedAnalysis {
  text: string;
  analysis: Analysis;
}

export class SectionFeatures {
  /** Analyses per section, of the index version `cacheVersion`. */
  private readonly cache = new Map<string, CachedAnalysis>();
  private cacheVersion = -1;

  /** `ignore`: identifiers never reported as unknown (upper case), read on every analysis. */
  constructor(readonly index: LanguageIndex, private readonly ignore: () => Set<string> = () => new Set()) {}

  /** Drops cached analyses, e.g. after the identifiers to ignore changed. */
  clear(): void {
    this.cache.clear();
  }

  analysisOf(ctx: SectionContext, text: string): Analysis {
    // Analyses of an older build are never used again, and they keep its symbols in memory.
    if (this.cacheVersion !== this.index.version) {
      this.cache.clear();
      this.cacheVersion = this.index.version;
    }
    const key = `${ctx.fileKey}|${ctx.sectionKey}`;
    const cached = this.cache.get(key);
    if (cached?.text === text) return cached.analysis;
    const analysis = analyze(this.index, ctx, text, { ignore: this.ignore() });
    this.cache.set(key, { text, analysis });
    return analysis;
  }

  occurrenceAt(analysis: Analysis, offset: number): Occurrence | undefined {
    return analysis.occurrences.find(o => o.start <= offset && offset <= o.end);
  }

  /** Where the symbol at an offset is declared (itself when the offset is on a declaration). */
  definitionAt(ctx: SectionContext, text: string, offset: number): Loc | undefined {
    const o = this.occurrenceAt(this.analysisOf(ctx, text), offset);
    if (!o?.sym.loc) return undefined;
    if (o.decl) return { fileKey: ctx.fileKey, sectionKey: ctx.sectionKey, start: o.start, end: o.end };
    return o.sym.loc;
  }

  /** References of the symbol at an offset, across all sections (unsaved edits included). */
  referencesAt(ctx: SectionContext, text: string, offset: number, includeDeclaration: boolean): Loc[] {
    const o = this.occurrenceAt(this.analysisOf(ctx, text), offset);
    return o ? this.referenceLocs(o.sym, includeDeclaration) : [];
  }

  referenceLocs(target: Sym, includeDeclaration: boolean): Loc[] {
    const out: Loc[] = [];
    for (const ctx of this.index.allContexts()) {
      const text = this.index.sectionText(ctx.fileKey, ctx.sectionKey);
      if (text === undefined) continue;
      const a = this.analysisOf(ctx, text);
      for (const occ of a.occurrences) {
        if (occ.sym.id === target.id && (includeDeclaration || !occ.decl)) {
          out.push({ fileKey: ctx.fileKey, sectionKey: ctx.sectionKey, start: occ.start, end: occ.end });
        }
      }
    }
    return out;
  }

  /**
   * Where the implementations of the symbol at an offset are declared (see implementations): the function blocks
   * that implement an interface or extend a function block, the methods and properties that implement or override one.
   */
  implementationsAt(ctx: SectionContext, text: string, offset: number): Loc[] {
    const o = this.occurrenceAt(this.analysisOf(ctx, text), offset);
    return o ? implementations(this.index, o.sym).flatMap(s => (s.loc ? [s.loc] : [])) : [];
  }
}
