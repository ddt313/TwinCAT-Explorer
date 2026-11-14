// Works around VS Code not re-reading a notebook when it is reverted (File: Revert File, or "Don't Save" when
// its tab closes). Its stored file working copy asks to force the read, but the working copy manager drops that
// option (it only forwards `reload.force`), so the read is made with the etag of the last read. The `twincat:`
// file system gives the same mtime and size while the object is unchanged on disk, the read stops at "not
// modified", and the notebook turns clean with the discarded text still in its cells; the next edit makes it
// dirty again and a save writes that text. A text document (the split editor) is not affected.
//
// So an object notebook that turns clean while its cells differ from the disk is made to read the disk again:
// the object gets a new modification time and a change event (ObjectFileSystem.reload).

import * as vscode from 'vscode';
import { ObjectFileSystem } from './objectFs';
import { cellMeta } from './serializers';
import { OBJECT_NOTEBOOK } from './uris';

export function watchNotebookReverts(objectFs: ObjectFileSystem): vscode.Disposable {
  /** Object notebooks seen dirty, by URI. */
  const seenDirty = new Set<string>();
  const timers = new Set<NodeJS.Timeout>();

  const check = () => {
    const open = new Set<string>();
    for (const nb of vscode.workspace.notebookDocuments) {
      if (nb.notebookType !== OBJECT_NOTEBOOK || nb.isClosed) continue;
      const key = nb.uri.toString();
      open.add(key);
      if (nb.isDirty) {
        seenDirty.add(key);
        continue;
      }
      if (!seenDirty.delete(key)) continue;
      // Saved, or undone to what it was loaded with, the cells show the disk; reverted, they may not.
      const cells = nb.getCells().flatMap(c => {
        const key = cellMeta(c)?.key;
        return key ? [{ key, text: c.document.getText() }] : [];
      });
      if (objectFs.showsDisk(nb.uri, cells) === false) objectFs.reload(nb.uri, 'after revert');
    }
    for (const key of [...seenDirty]) if (!open.has(key)) seenDirty.delete(key);
  };

  /**
   * The dirty state of a notebook reaches the extension host apart from the tab change that shows it, so it is
   * checked once soon and once more a little later.
   */
  const schedule = () => {
    for (const ms of [100, 1000]) {
      const t = setTimeout(() => {
        timers.delete(t);
        check();
      }, ms);
      timers.add(t);
    }
  };

  const subscriptions = [
    // A tab shows a notebook's dirty state: editing, saving and reverting all change its tabs.
    vscode.window.tabGroups.onDidChangeTabs(schedule),
    vscode.workspace.onDidChangeNotebookDocument(e => {
      if (e.notebook.notebookType === OBJECT_NOTEBOOK && e.notebook.isDirty) seenDirty.add(e.notebook.uri.toString());
    }),
    vscode.workspace.onDidCloseNotebookDocument(nb => seenDirty.delete(nb.uri.toString())),
  ];
  return new vscode.Disposable(() => {
    for (const t of timers) clearTimeout(t);
    for (const s of subscriptions) s.dispose();
  });
}
