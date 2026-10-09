// Syntax highlighting with the extension's own TextMate grammar and the token
// colors of the active VS Code theme (vscode-textmate + oniguruma), so the
// split editor colors Structured Text exactly like VS Code's editors.

import type * as Monaco from 'monaco-editor';
import { INITIAL, IGrammar, IRawTheme, Registry, StateStack, parseRawGrammar } from 'vscode-textmate';
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma';
import type { TokenRule } from '../shared/protocol';

class TmState implements Monaco.languages.IState {
  constructor(readonly stack: StateStack) {}

  clone(): TmState {
    return new TmState(this.stack.clone());
  }

  equals(other: Monaco.languages.IState): boolean {
    return other instanceof TmState && other.stack.equals(this.stack);
  }
}

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` or `rgba()` as [r, g, b, a], or undefined. */
export function parseColor(value: string): [number, number, number, number] | undefined {
  const v = value.trim();
  let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v);
  if (m) {
    let hex = m[1];
    if (hex.length <= 4) hex = hex.split('').map(c => c + c).join('');
    const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), hex.length === 8 ? n(6) / 255 : 1];
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+%?)\s*)?\)$/i.exec(v);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3]), Math.max(0, Math.min(1, a))];
  }
  return undefined;
}

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

export function toHex(c: [number, number, number, number], withAlpha: boolean): string {
  return '#' + hex2(c[0]) + hex2(c[1]) + hex2(c[2]) + (withAlpha && c[3] < 1 ? hex2(c[3] * 255) : '');
}

/** A token color as opaque #rrggbb (Monaco's token color map has no alpha): blended over the background. */
function opaque(value: string | undefined, background: [number, number, number, number]): string | undefined {
  if (!value) return undefined;
  const c = parseColor(value);
  if (!c) return undefined;
  const a = c[3];
  return toHex([c[0] * a + background[0] * (1 - a), c[1] * a + background[1] * (1 - a), c[2] * a + background[2] * (1 - a), 1], false);
}

export class TextMateHighlighter {
  private registry: Registry | undefined;
  private grammar: IGrammar | undefined;
  private colorMap: string[] = [];

  constructor(private readonly monaco: typeof Monaco, private readonly languageId: string) {}

  async load(onigUri: string, grammarUri: string): Promise<void> {
    const [wasm, grammarText] = await Promise.all([
      fetch(onigUri).then(r => r.arrayBuffer()),
      fetch(grammarUri).then(r => r.text()),
    ]);
    await loadWASM(wasm);
    this.registry = new Registry({
      onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
      loadGrammar: async scope => (scope === 'source.twincat-st' ? parseRawGrammar(grammarText, 'twincat-st.tmLanguage.json') : null),
    });
  }

  /** Applies the theme's token rules, defines the Monaco theme and (re)installs the tokenizer. */
  async apply(rules: TokenRule[], themeName: string, base: Monaco.editor.BuiltinTheme, colors: Record<string, string>): Promise<void> {
    if (!this.registry) return;
    const bg = parseColor(colors['editor.background'] ?? '') ?? (base === 'vs' || base === 'hc-light' ? [255, 255, 255, 1] : [30, 30, 30, 1]);
    const fg = opaque(colors['editor.foreground'], bg) ?? (base === 'vs' || base === 'hc-light' ? '#000000' : '#d4d4d4');
    const settings: IRawTheme['settings'] = [{ settings: { foreground: fg, background: toHex(bg, false) } }];
    for (const r of rules) {
      if (!r || typeof r !== 'object' || !r.settings) continue;
      settings.push({
        scope: r.scope,
        settings: { foreground: opaque(r.settings.foreground, bg), background: opaque(r.settings.background, bg), fontStyle: r.settings.fontStyle },
      });
    }
    this.registry.setTheme({ name: 'vscode', settings });
    this.colorMap = this.registry.getColorMap();
    this.monaco.editor.defineTheme(themeName, {
      base,
      inherit: false,
      rules: [],
      // Ids 1..n of vscode-textmate's color map, in order (index 0 is unused).
      encodedTokensColors: this.colorMap.slice(1),
      colors,
    });
    this.monaco.editor.setTheme(themeName);
    this.grammar = (await this.registry.loadGrammarWithConfiguration('source.twincat-st',
      this.monaco.languages.getEncodedLanguageId(this.languageId), {})) ?? undefined;
    const grammar = this.grammar;
    if (!grammar) return;
    // Setting the provider again makes Monaco tokenize the open models with the new colors.
    this.monaco.languages.setTokensProvider(this.languageId, {
      getInitialState: () => new TmState(INITIAL),
      tokenizeEncoded: (line: string, state: Monaco.languages.IState) => {
        const r = grammar.tokenizeLine2(line, (state as TmState).stack, 500);
        return { tokens: r.tokens, endState: new TmState(r.ruleStack) };
      },
    });
  }
}
