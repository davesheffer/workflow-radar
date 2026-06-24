/**
 * The UI layer: a {@link vscode.WebviewViewProvider} that renders the dashboard
 * in the activity-bar sidebar.
 *
 * Responsibilities are kept narrow on purpose:
 *  - own the webview lifecycle and HTML shell,
 *  - forward {@link WorkflowStore} snapshots (plus live config) to the client,
 *  - translate inbound webview messages into registered VS Code commands.
 *
 * It contains no parsing, watching, or freshness logic — those live in the data
 * and state layers. The provider is a dumb, well-typed pipe.
 */

import * as vscode from 'vscode';

import { getHtml } from './html';
import type { WorkflowStore } from '../state/WorkflowStore';
import type {
  UpdateMessage,
  WebviewToExtension,
} from '../types/messages';
import type { WorkflowSnapshot } from '../types/workflow';

/**
 * Commands the webview is permitted to trigger. The `WebviewCommand` type is
 * compile-time only and erased at runtime; webview messages cross a trust
 * boundary, so the inbound `command` field is validated against this allowlist
 * before any dispatch.
 */
const ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  'refresh',
  'openStatusFile',
  'createSampleStatus',
]);

export class WorkflowRadarViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'workflowRadar.dashboard';

  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: WorkflowStore,
  ) {
    this.disposables.push(
      this.store.onDidChangeSnapshot((snapshot) => this.post(snapshot)),
    );
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    webviewView.webview.html = getHtml(webviewView.webview, this.extensionUri);

    webviewView.webview.onDidReceiveMessage(
      (message: WebviewToExtension) => this.onMessage(message),
      undefined,
      this.disposables,
    );

    webviewView.onDidDispose(
      () => {
        this.view = undefined;
      },
      undefined,
      this.disposables,
    );

    // Push whatever we already have so the view is never blank on open.
    this.post(this.store.snapshot);
  }

  /** Re-push the current snapshot, e.g. after a configuration change. */
  public refresh(): void {
    this.post(this.store.snapshot);
  }

  private onMessage(message: WebviewToExtension): void {
    switch (message.type) {
      case 'ready':
        this.post(this.store.snapshot);
        break;
      case 'command':
        if (ALLOWED_COMMANDS.has(message.command)) {
          void vscode.commands.executeCommand(`workflowRadar.${message.command}`);
        }
        break;
    }
  }

  private post(snapshot: WorkflowSnapshot): void {
    if (!this.view) {
      return;
    }
    const config = vscode.workspace.getConfiguration('workflowRadar');
    const message: UpdateMessage = {
      type: 'update',
      snapshot,
      config: {
        staleThresholdSeconds: config.get<number>('staleThresholdSeconds', 30),
        maxEvents: config.get<number>('maxEvents', 100),
        serverTime: Date.now(),
      },
    };
    void this.view.webview.postMessage(message);
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
