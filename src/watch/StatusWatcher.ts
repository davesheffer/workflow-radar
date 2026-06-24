/**
 * Thin wrapper around a VS Code {@link vscode.FileSystemWatcher} scoped to a
 * single status file. Collapses create/change/delete into one debounced
 * `onDidChange` signal so the data layer can stay agnostic about *why* the file
 * changed — it just re-reads. Producers that rewrite the file rapidly (multiple
 * writes per second) are smoothed by a short debounce to avoid render thrash.
 */

import * as vscode from 'vscode';

const DEBOUNCE_MS = 80;

export class StatusWatcher implements vscode.Disposable {
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.emitter.event;

  private debounceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(folder: vscode.WorkspaceFolder, relativePath: string) {
    // RelativePattern keeps the watcher scoped to this folder + path, including
    // creation/deletion of the file itself (a bare glob would miss create/delete).
    const pattern = new vscode.RelativePattern(folder, relativePath);
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.watcher.onDidCreate(() => this.signal());
    this.watcher.onDidChange(() => this.signal());
    this.watcher.onDidDelete(() => this.signal());
  }

  private signal(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.emitter.fire();
    }, DEBOUNCE_MS);
  }

  public dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.watcher.dispose();
    this.emitter.dispose();
  }
}
