// Token color rules of VS Code themes, and a reader for the old .tmTheme
// (plist) format some themes still reference.

export interface TokenRule {
  name?: string;
  scope?: string | string[];
  settings: { foreground?: string; background?: string; fontStyle?: string };
}

/** Minimal reader for the `settings` array of a .tmTheme (plist) file. */
export function parseTmTheme(xml: string): TokenRule[] {
  type PValue = string | PValue[] | { [k: string]: PValue };
  const tokens = xml.replace(/<!--[\s\S]*?-->/g, '').match(/<\/?(dict|array|key|string)>|<(dict|array)\/>|[^<]+/g) ?? [];
  let i = 0;
  const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const value = (): PValue | undefined => {
    while (i < tokens.length && !tokens[i].startsWith('<')) i++;
    const t = tokens[i++];
    if (t === '<dict/>') return {};
    if (t === '<array/>') return [];
    if (t === '<string>') {
      let text = '';
      while (i < tokens.length && tokens[i] !== '</string>') text += tokens[i++];
      i++;
      return unescape(text);
    }
    if (t === '<array>') {
      const arr: PValue[] = [];
      for (;;) {
        while (i < tokens.length && !tokens[i].startsWith('<')) i++;
        if (i >= tokens.length || tokens[i] === '</array>') { i++; return arr; }
        const v = value();
        if (v !== undefined) arr.push(v);
      }
    }
    if (t === '<dict>') {
      const obj: { [k: string]: PValue } = {};
      for (;;) {
        while (i < tokens.length && !tokens[i].startsWith('<')) i++;
        if (i >= tokens.length || tokens[i] === '</dict>') { i++; return obj; }
        if (tokens[i] !== '<key>') { i++; continue; }
        i++;
        let key = '';
        while (i < tokens.length && tokens[i] !== '</key>') key += tokens[i++];
        i++;
        const v = value();
        if (v !== undefined) obj[unescape(key)] = v;
      }
    }
    return undefined;
  };
  // The root plist contains one dict.
  while (i < tokens.length && tokens[i] !== '<dict>') i++;
  const root = value() as { settings?: PValue[] } | undefined;
  const settings = Array.isArray(root?.settings) ? root!.settings : [];
  return settings.filter((s): s is { [k: string]: PValue } => !!s && typeof s === 'object' && !Array.isArray(s))
    .map(s => ({ scope: typeof s.scope === 'string' ? s.scope : undefined, settings: (s.settings ?? {}) as TokenRule['settings'] }));
}
