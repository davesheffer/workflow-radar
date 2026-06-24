/**
 * Source abstraction for workflow snapshots.
 *
 * A {@link WorkflowSource} is anything that can produce a {@link WorkflowSnapshot}
 * and notify when its data may have changed. The MVP ships exactly one
 * implementation — {@link FileWorkflowSource}, backed by a JSON file on disk —
 * but the interface is intentionally narrow so future sources (a remote HTTP/WS
 * endpoint, a worktree-aware scanner, an in-memory test double) can drop in
 * without touching the state or UI layers.
 */

import * as vscode from 'vscode';

import { parseStatus } from './StatusParser';
import type { WorkflowSnapshot, WorkflowStatus } from '../types/workflow';
import { StatusWatcher } from '../watch/StatusWatcher';

export interface WorkflowSource extends vscode.Disposable {
  /** Stable identity for this source (used by the multi-source store later). */
  readonly id: string;
  /** Human label, shown in the UI. */
  readonly label: string;
  /** Fires whenever the underlying data may have changed. */
  readonly onDidChange: vscode.Event<void>;
  /** Read the latest snapshot. Async to accommodate remote sources. */
  read(): Promise<WorkflowSnapshot>;
}

/**
 * A workflow source backed by a single JSON file inside a workspace folder.
 * Survives transient producer races (partial writes) by retaining the last
 * successfully parsed status and surfacing parse errors via snapshot metadata.
 */
export class FileWorkflowSource implements WorkflowSource {
  public readonly id: string;
  public readonly label: string;

  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.emitter.event;

  private readonly uri: vscode.Uri;
  private readonly watcher: StatusWatcher;
  private lastGoodStatus: WorkflowStatus | null = null;

  constructor(folder: vscode.WorkspaceFolder, relativePath: string) {
    this.id = `file:${folder.uri.toString()}::${relativePath}`;
    this.label = relativePath;
    this.uri = vscode.Uri.joinPath(folder.uri, ...splitPath(relativePath));
    this.watcher = new StatusWatcher(folder, relativePath);
    this.watcher.onDidChange(() => this.emitter.fire());
  }

  public async read(): Promise<WorkflowSnapshot> {
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(this.uri);
    } catch {
      // File absent — a first-class "empty" state, not an error.
      return this.absent();
    }

    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(this.uri);
    } catch (e) {
      // The file vanished between stat() and readFile() (producers do
      // delete/rename-replace writes). Treat not-found as the clean absent
      // state rather than reporting a stale mtime with present:true.
      if (isFileNotFound(e)) {
        return this.absent();
      }
      return this.present(stat.mtime, `Could not read status file: ${(e as Error).message}`);
    }

    const text = Buffer.from(bytes).toString('utf8');
    const result = parseStatus(text);
    if (result.status) {
      this.lastGoodStatus = result.status;
    }
    return this.present(stat.mtime, result.error);
  }

  private absent(): WorkflowSnapshot {
    return {
      status: null,
      meta: {
        sourceId: this.id,
        sourceLabel: this.label,
        present: false,
        lastUpdated: null,
        error: null,
      },
    };
  }

  private present(lastUpdated: number, error: string | null): WorkflowSnapshot {
    return {
      status: this.lastGoodStatus,
      meta: {
        sourceId: this.id,
        sourceLabel: this.label,
        present: true,
        lastUpdated,
        error,
      },
    };
  }

  public dispose(): void {
    this.watcher.dispose();
    this.emitter.dispose();
  }
}

/** Splits a workspace-relative path on either slash style into URI segments. */
function splitPath(relativePath: string): string[] {
  return relativePath.split(/[\\/]+/).filter((seg) => seg.length > 0);
}

/** True when a filesystem error denotes a missing file (vs. a genuine read failure). */
function isFileNotFound(e: unknown): boolean {
  if (e instanceof vscode.FileSystemError) {
    return e.code === 'FileNotFound';
  }
  const code = (e as { code?: string } | null)?.code;
  return code === 'ENOENT' || /ENOENT|not found/i.test(String((e as Error)?.message ?? ''));
}
