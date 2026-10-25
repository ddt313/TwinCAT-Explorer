// Token colors of the active color theme, for the TextMate tokenizer of the
// split editor's webview: the theme's tokenColors (following `include`), then
// the user's editor.tokenColorCustomizations, the way VS Code layers them.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseJsonc } from '../core/jsonc';
import { TokenRule, parseTmTheme } from '../core/tmTheme';

export interface ThemeTokens {
  /** Setting id of the theme, e.g. "Default Dark Modern". */
  name: string;
  rules: TokenRule[];
  /** Where the rules came from, for the log. */
  source: string;
}

function activeThemeName(): string {
  const wb = vscode.workspace.getConfiguration('workbench');
  const win = vscode.workspace.getConfiguration('window');
  const kind = vscode.window.activeColorTheme.kind;
  if (kind === vscode.ColorThemeKind.HighContrast && win.get<boolean>('autoDetectHighContrast', true)) {
    const hc = wb.get<string>('preferredHighContrastColorTheme');
    if (hc) return hc;
  }
  if (kind === vscode.ColorThemeKind.HighContrastLight && win.get<boolean>('autoDetectHighContrast', true)) {
    const hc = wb.get<string>('preferredHighContrastLightColorTheme');
    if (hc) return hc;
  }
  if (win.get<boolean>('autoDetectColorScheme', false)) {
    const dark = kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
    const preferred = wb.get<string>(dark ? 'preferredDarkColorTheme' : 'preferredLightColorTheme');
    if (preferred) return preferred;
  }
  return wb.get<string>('colorTheme') ?? '';
}

interface ThemeContribution {
  id?: string;
  label?: string;
  path: string;
}

function findThemeFile(name: string): string | undefined {
  for (const ext of vscode.extensions.all) {
    const themes = (ext.packageJSON?.contributes?.themes ?? []) as ThemeContribution[];
    for (const t of themes) {
      if ((t.id ?? t.label) === name || t.label === name) return path.join(ext.extensionPath, t.path);
    }
  }
  return undefined;
}

/** The file of the active color theme, for the browser build to read beforehand (web/extension.ts). */
export function activeThemeFile(): string | undefined {
  const name = activeThemeName();
  return name ? findThemeFile(name) : undefined;
}

function loadTokenColors(file: string, seen = new Set<string>()): TokenRule[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const text = fs.readFileSync(file, 'utf8');
  if (/\.tmTheme$/i.test(file)) return parseTmTheme(text);
  const json = parseJsonc<{ include?: string; tokenColors?: TokenRule[] | string }>(text);
  const rules: TokenRule[] = [];
  if (json.include) rules.push(...loadTokenColors(path.join(path.dirname(file), json.include), seen));
  if (typeof json.tokenColors === 'string') {
    const target = path.join(path.dirname(file), json.tokenColors);
    if (/\.tmTheme$/i.test(target)) rules.push(...parseTmTheme(fs.readFileSync(target, 'utf8')));
    else {
      const sub = parseJsonc<TokenRule[] | { tokenColors?: TokenRule[] }>(fs.readFileSync(target, 'utf8'));
      rules.push(...(Array.isArray(sub) ? sub : sub.tokenColors ?? []));
    }
  } else if (Array.isArray(json.tokenColors)) rules.push(...json.tokenColors);
  return rules;
}

/** Scopes VS Code assigns to the simple keys of editor.tokenColorCustomizations. */
const CUSTOMIZATION_SCOPES: Record<string, string[]> = {
  comments: ['comment', 'punctuation.definition.comment'],
  strings: ['string', 'meta.embedded.assembly'],
  keywords: ['keyword - keyword.operator', 'keyword.control', 'storage', 'storage.type'],
  numbers: ['constant.numeric'],
  types: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'],
  functions: ['entity.name.function', 'support.function'],
  variables: ['variable', 'entity.name.variable'],
};

type Customization = { [key: string]: unknown; textMateRules?: TokenRule[] };

function customizationRules(c: Customization | undefined): TokenRule[] {
  if (!c || typeof c !== 'object') return [];
  const rules: TokenRule[] = [];
  for (const [key, scopes] of Object.entries(CUSTOMIZATION_SCOPES)) {
    const v = c[key];
    if (typeof v === 'string') rules.push({ scope: scopes, settings: { foreground: v } });
    else if (v && typeof v === 'object') rules.push({ scope: scopes, settings: v as TokenRule['settings'] });
  }
  if (Array.isArray(c.textMateRules)) rules.push(...c.textMateRules);
  return rules;
}

function globMatches(pattern: string, name: string): boolean {
  const re = new RegExp('^' + pattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  return re.test(name);
}

export function activeThemeTokens(): ThemeTokens {
  const name = activeThemeName();
  const rules: TokenRule[] = [];
  let source = 'no theme file found';
  const file = name ? findThemeFile(name) : undefined;
  if (file) {
    try {
      rules.push(...loadTokenColors(file));
      source = file;
    } catch (e) {
      source = `${file}: ${(e as Error).message}`;
    }
  }
  const custom = vscode.workspace.getConfiguration('editor').get<Customization>('tokenColorCustomizations');
  rules.push(...customizationRules(custom));
  for (const [key, value] of Object.entries(custom ?? {})) {
    const m = /^\[(.+)\]$/.exec(key);
    if (m && m[1].split('][').some(p => globMatches(p, name))) rules.push(...customizationRules(value as Customization));
  }
  return { name, rules, source };
}
