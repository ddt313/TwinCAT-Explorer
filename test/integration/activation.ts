// Checks that VS Code activates the extension by itself (activation events),
// without the test calling activate(). Run by scripts/check-activation.js.
import * as vscode from 'vscode';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension('thanhdang.twincat-explorer');
  console.log(`ACTIVATION: extension known=${!!ext}`);
  const found = await vscode.workspace.findFiles('**/*.tsproj', '**/{node_modules,.git,_Boot,_CompileInfo,_Libraries}/**');
  console.log(`ACTIVATION: findFiles(**/*.tsproj) -> ${found.length} ${found.map(u => u.fsPath).join(', ')}`);
  const timeout = Number(process.env.TWINCAT_ACTIVATION_TIMEOUT ?? 20000);
  const start = Date.now();
  while (!ext?.isActive && Date.now() - start < timeout) await sleep(250);
  console.log(`ACTIVATION: isActive=${!!ext?.isActive} after ${Date.now() - start} ms`);
  if (!ext?.isActive) throw new Error('extension was not activated by its activation events');
}
