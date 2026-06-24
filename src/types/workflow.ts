/**
 * Domain model for Workflow Radar.
 *
 * These types describe the normalized, internal shape of a workflow run after a
 * raw status file has been parsed and validated. Producers may write looser JSON
 * (see {@link ../data/StatusParser}); everything reaching the UI conforms to the
 * interfaces below.
 */

/** Overall lifecycle state of a workflow run. */
export type WorkflowRunState =
  | 'running'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'idle';

/** Lifecycle state of an individual phase within a run. */
export type PhaseState =
  | 'done'
  | 'running'
  | 'waiting'
  | 'failed'
  | 'skipped';

/** Severity of an event-log entry. */
export type EventLevel = 'info' | 'warn' | 'error';

/** A single phase / stage of a workflow (e.g. "Finders", "Verifiers"). */
export interface WorkflowPhase {
  readonly name: string;
  /** Total agents/tasks dispatched for this phase, if known. */
  readonly agents?: number;
  /** Agents/tasks completed so far, if known. */
  readonly completed?: number;
  readonly state: PhaseState;
  /** Free-form human note shown alongside the phase. */
  readonly note?: string;
}

/** A timestamped line in the live event log. */
export interface WorkflowEvent {
  /** Producer-supplied label, e.g. "11:42" or an ISO timestamp. Rendered verbatim. */
  readonly timestamp: string;
  readonly message: string;
  readonly level?: EventLevel;
}

/** A fully normalized workflow run, ready to render. */
export interface WorkflowStatus {
  /** Display name of the workflow. */
  readonly workflow: string;
  readonly status: WorkflowRunState;
  readonly currentPhase?: string;
  /** Overall progress 0–100. Derived from phases when the producer omits it. */
  readonly progress: number;
  readonly phases: readonly WorkflowPhase[];
  readonly events: readonly WorkflowEvent[];
  /** Optional producer-supplied timestamp string, shown if present. */
  readonly updatedAt?: string;
}

/**
 * Metadata about how/where a snapshot was obtained. Separated from
 * {@link WorkflowStatus} so the UI can reason about freshness and source health
 * independently of the workflow payload itself.
 */
export interface SnapshotMeta {
  /**
   * Stable identity of the producing source (e.g. `file:<folderUri>::<relPath>`),
   * or null for the empty snapshot. Lets future consumers key history / filter by
   * source without the UI knowing how many sources exist.
   */
  readonly sourceId: string | null;
  /** Human label for the source, e.g. ".workflow/status.json". */
  readonly sourceLabel: string;
  /** Whether the backing source currently exists. */
  readonly present: boolean;
  /** Epoch ms of the last update (file mtime), or null when unavailable. */
  readonly lastUpdated: number | null;
  /** Non-fatal parse/read error to surface while keeping the last good status. */
  readonly error: string | null;
}

/**
 * Immutable, self-describing unit handed from the state layer to the UI layer.
 * `status` is null only when the source is absent or has never produced a valid
 * payload; otherwise it holds the most recent good status (even on a stale read).
 */
export interface WorkflowSnapshot {
  readonly status: WorkflowStatus | null;
  readonly meta: SnapshotMeta;
}

/** A snapshot representing "no source configured / nothing to show". */
export const EMPTY_SNAPSHOT: WorkflowSnapshot = {
  status: null,
  meta: {
    sourceId: null,
    sourceLabel: '',
    present: false,
    lastUpdated: null,
    error: null,
  },
};
