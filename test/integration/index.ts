// Entry of the integration tests (scripts/test-integration.js): VS Code calls run() in its extension host.
import { runAll } from './harness';
import './extension.test';

export function run(): Promise<void> {
  return runAll();
}
