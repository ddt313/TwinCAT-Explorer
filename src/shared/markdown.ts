// Markdown helpers shared by the extension host and the webview.

/** Text shown as itself in Markdown: commit messages, names and doc comments never become links or markup. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, m => `\\${m}`);
}
