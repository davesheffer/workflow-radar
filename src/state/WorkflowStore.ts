/**
 * Single source of truth for the currently observed workflow.
 *
 * The store sits between the data layer ({@link WorkflowSource}) and the UI
 * layer ({@link ../view/WorkflowRadarViewProvider}). It owns the active source,
 * re-reads it when notified, caches the latest snapshot, and emits a change
 * event the view subscribes to. Today it tracks one active source; the API is
 * shaped so a future version can hold a keyed collection of sources (multiple
 * workflows / worktrees) and expose an "active" selection without the view
 * caring how many exist.
 */

import * as vscode from 'vscode';

import type { WorkflowSource } from '../data/WorkflowSource';
import { EMPTY_SNAPSHOT, type WorkflowSnapshot } from '../types/workflow';

export class WorkflowStore implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<WorkflowSnapshot>();
  /** Fires whenever the active snapshot is replaced. */
  public readonly onDidChangeSnapshot = this.emitter.event;

  private source: WorkflowSource | undefined;
  private sourceSub: vscode.Disposable | undefined;
  private current: WorkflowSnapshot = EMPTY_SNAPSHOT;
  /** Guards against overlapping async reads clobbering each other out of order. */
  private readGeneration = 0;

  public get snapshot(): WorkflowSnapshot {
    return this.current;
  }

  /**
   * Swap the active source. Disposes the previous one, subscribes to the new
   * one's change signal, and triggers an immediate read. Passing `undefined`
   * clears the store back to the empty state.
   */
  public setSource(source: WorkflowSource | undefined): void {
    this.sourceSub?.dispose();
    this.source?.dispose();

    this.source = source;
    this.sourceSub = source?.onDidChange(() => void this.refresh());

    void this.refresh();
  }

  /** Re-read the active source and broadcast the result. */
  public async refresh(): Promise<void> {
    const generation = ++this.readGeneration;

    if (!this.source) {
      this.commit(EMPTY_SNAPSHOT, generation);
      return;
    }

    try {
      const snapshot = await this.source.read();
      this.commit(snapshot, generation);
    } catch (e) {
      this.commit(
        {
          status: this.current.status,
          meta: {
            ...this.current.meta,
            error: `Read failed: ${(e as Error).message}`,
          },
        },
        generation,
      );
    }
  }

  private commit(snapshot: WorkflowSnapshot, generation: number): void {
    // Drop stale reads: only the most recently issued read may commit.
    if (generation !== this.readGeneration) {
      return;
    }
    this.current = snapshot;
    this.emitter.fire(snapshot);
  }

  public dispose(): void {
    this.sourceSub?.dispose();
    this.source?.dispose();
    this.emitter.dispose();
  }
}
