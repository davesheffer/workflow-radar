/**
 * Extension entry point. Wires the four layers together and owns their
 * lifetimes:
 *
 *   FileWorkflowSource (data) -> WorkflowStore (state) -> ViewProvider (UI)
 *                       ^ StatusWatcher feeds change signals upstream
 *
 * Everything created here is registered on `context.subscriptions` so VS Code
 * disposes it on deactivate.
 */

import * as vscode from 'vscode';

import { FileWorkflowSource } from './data/WorkflowSource';
import { WorkflowStore } from './state/WorkflowStore';
import { WorkflowRadarViewProvider } from './view/WorkflowRadarViewProvider';

const CONFIG_NS = 'workflowRadar';
const DEFAULT_STATUS_PATH = '.workflow/status.json';

export function activate(context: vscode.ExtensionContext): void {
  const store = new WorkflowStore();
  const provider = new WorkflowRadarViewProvider(context.extensionUri, store);

  context.subscriptions.push(
    store,
    provider,
    vscode.window.registerWebviewViewProvider(
      WorkflowRadarViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // Build the active source from current settings + first workspace folder.
  // Guarded so unrelated workspace-folder mutations don't needlessly tear down
  // and rebuild the watcher (which would also drop the cached last-good status).
  let currentSourceKey: string | undefined;
  const applySource = (): void => {
    const relPath = statusPath();
    const folder = vscode.workspace.workspaceFolders?.[0];
    const key = folder ? `${folder.uri.toString()}::${relPath}` : undefined;
    if (key === currentSourceKey) {
      return;
    }
    currentSourceKey = key;
    store.setSource(folder ? new FileWorkflowSource(folder, relPath) : undefined);
  };
  applySource();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${CONFIG_NS}.statusFilePath`)) {
        applySource();
      } else if (e.affectsConfiguration(CONFIG_NS)) {
        // staleThreshold / maxEvents changed — re-push so the webview picks it up.
        provider.refresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => applySource()),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(`${CONFIG_NS}.refresh`, () => {
      void store.refresh();
    }),
    vscode.commands.registerCommand(`${CONFIG_NS}.openStatusFile`, () =>
      openStatusFile(),
    ),
    vscode.commands.registerCommand(`${CONFIG_NS}.createSampleStatus`, () =>
      createSampleStatus(),
    ),
  );
}

export function deactivate(): void {
  // All disposables are owned by context.subscriptions; nothing extra to do.
}

// --- commands ---------------------------------------------------------------

async function openStatusFile(): Promise<void> {
  const uri = resolveStatusUri();
  if (!uri) {
    void vscode.window.showWarningMessage(
      'Workflow Radar: open a folder to use a status file.',
    );
    return;
  }
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
  } catch {
    const choice = await vscode.window.showInformationMessage(
      `Workflow Radar: ${statusPath()} does not exist yet.`,
      'Create Sample',
    );
    if (choice === 'Create Sample') {
      await createSampleStatus();
    }
  }
}

async function createSampleStatus(): Promise<void> {
  const uri = resolveStatusUri();
  if (!uri) {
    void vscode.window.showWarningMessage(
      'Workflow Radar: open a folder before creating a status file.',
    );
    return;
  }
  const dir = vscode.Uri.joinPath(uri, '..');
  try {
    await vscode.workspace.fs.createDirectory(dir);
    const content = Buffer.from(JSON.stringify(SAMPLE_STATUS, null, 2), 'utf8');
    await vscode.workspace.fs.writeFile(uri, content);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    void vscode.window.showInformationMessage(
      `Workflow Radar: created ${statusPath()}.`,
    );
  } catch (e) {
    void vscode.window.showErrorMessage(
      `Workflow Radar: could not create status file — ${(e as Error).message}`,
    );
  }
}

// --- helpers ----------------------------------------------------------------

function statusPath(): string {
  return vscode.workspace
    .getConfiguration(CONFIG_NS)
    .get<string>('statusFilePath', DEFAULT_STATUS_PATH);
}

function resolveStatusUri(): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return undefined;
  }
  const segments = statusPath()
    .split(/[\\/]+/)
    .filter((s) => s.length > 0);
  return vscode.Uri.joinPath(folder.uri, ...segments);
}

const SAMPLE_STATUS = {
  workflow: 'alive',
  status: 'running',
  currentPhase: 'verify',
  progress: 62,
  phases: [
    { name: 'Finders', agents: 9, completed: 9, state: 'done', note: '9 lenses swept' },
    {
      name: 'Verifiers',
      agents: 51,
      completed: 18,
      state: 'running',
      note: '3 skeptics × 17 findings',
    },
    { name: 'Critic', agents: 0, state: 'waiting' },
    { name: 'Synthesizer', agents: 0, state: 'waiting' },
  ],
  events: [
    { timestamp: '11:42', message: 'verifier-12 challenged finding F-07' },
    { timestamp: '11:43', message: 'verifier-18 marked risk medium' },
  ],
} as const;
