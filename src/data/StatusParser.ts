/**
 * Parses and normalizes raw status-file text into the internal {@link WorkflowStatus}
 * model. Producers are external and untrusted: the parser is deliberately lenient
 * about input shape but strict about the output it emits. Unknown state strings
 * are mapped to the closest known value, missing fields are defaulted, and a
 * malformed file yields a structured error rather than a thrown exception.
 */

import type {
  EventLevel,
  PhaseState,
  WorkflowEvent,
  WorkflowPhase,
  WorkflowRunState,
  WorkflowStatus,
} from '../types/workflow';

export interface ParseResult {
  /** Normalized status, or null when the input could not be interpreted at all. */
  readonly status: WorkflowStatus | null;
  /** Human-readable problem description, or null on success. */
  readonly error: string | null;
}

type Json = Record<string, unknown>;

const RUN_STATE_ALIASES: Record<string, WorkflowRunState> = {
  running: 'running',
  active: 'running',
  in_progress: 'running',
  inprogress: 'running',
  completed: 'completed',
  complete: 'completed',
  done: 'completed',
  success: 'completed',
  succeeded: 'completed',
  failed: 'failed',
  error: 'failed',
  errored: 'failed',
  paused: 'paused',
  suspended: 'paused',
  idle: 'idle',
  waiting: 'idle',
  pending: 'idle',
};

const PHASE_STATE_ALIASES: Record<string, PhaseState> = {
  done: 'done',
  completed: 'done',
  complete: 'done',
  success: 'done',
  succeeded: 'done',
  running: 'running',
  active: 'running',
  in_progress: 'running',
  inprogress: 'running',
  waiting: 'waiting',
  pending: 'waiting',
  queued: 'waiting',
  idle: 'waiting',
  failed: 'failed',
  error: 'failed',
  skipped: 'skipped',
  skip: 'skipped',
};

const EVENT_LEVELS: ReadonlySet<EventLevel> = new Set(['info', 'warn', 'error']);

export function parseStatus(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { status: null, error: `Invalid JSON: ${(e as Error).message}` };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { status: null, error: 'Status file must contain a JSON object.' };
  }
  try {
    return { status: normalizeStatus(raw as Json), error: null };
  } catch (e) {
    return { status: null, error: (e as Error).message };
  }
}

function normalizeStatus(raw: Json): WorkflowStatus {
  const phases = normalizePhases(raw.phases);
  const status = normalizeRunState(raw.status, phases);
  const progress = clampProgress(
    raw.progress !== undefined ? asNumber(raw.progress) : deriveProgress(phases),
  );

  return {
    workflow: asString(raw.workflow ?? raw.name) || 'Workflow',
    status,
    currentPhase: optionalString(raw.currentPhase ?? raw.phase),
    progress,
    phases,
    events: normalizeEvents(raw.events),
    updatedAt: optionalString(raw.updatedAt ?? raw.timestamp),
  };
}

function normalizePhases(value: unknown): WorkflowPhase[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const phases: WorkflowPhase[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const p = item as Json;
    const agents = optionalNumber(p.agents);
    const completed = optionalNumber(p.completed);
    phases.push({
      name: asString(p.name) || 'Phase',
      agents,
      completed,
      state: normalizePhaseState(p.state, agents, completed),
      note: optionalString(p.note),
    });
  }
  return phases;
}

function normalizeEvents(value: unknown): WorkflowEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const events: WorkflowEvent[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const e = item as Json;
    const level = asString(e.level).toLowerCase();
    events.push({
      timestamp: asString(e.timestamp ?? e.time ?? e.ts),
      message: asString(e.message ?? e.msg ?? e.text),
      level: EVENT_LEVELS.has(level as EventLevel) ? (level as EventLevel) : undefined,
    });
  }
  return events;
}

function normalizeRunState(value: unknown, phases: readonly WorkflowPhase[]): WorkflowRunState {
  const key = asString(value).toLowerCase().replace(/[\s-]/g, '_');
  const mapped = RUN_STATE_ALIASES[key];
  if (mapped) {
    return mapped;
  }
  // Infer from phases when the producer omits an overall status.
  if (phases.some((p) => p.state === 'failed')) {
    return 'failed';
  }
  if (phases.length > 0 && phases.every((p) => p.state === 'done')) {
    return 'completed';
  }
  if (phases.some((p) => p.state === 'running')) {
    return 'running';
  }
  // Nothing failed/running and not all done. A completed phase means work has
  // started (between phases) → still 'running'; otherwise (all waiting/skipped,
  // or no phases) the run has not started → 'idle'. Never report un-started
  // work as 'running'.
  if (phases.some((p) => p.state === 'done')) {
    return 'running';
  }
  return 'idle';
}

function normalizePhaseState(
  value: unknown,
  agents: number | undefined,
  completed: number | undefined,
): PhaseState {
  const key = asString(value).toLowerCase().replace(/[\s-]/g, '_');
  const mapped = PHASE_STATE_ALIASES[key];
  if (mapped) {
    return mapped;
  }
  // Infer from counts when state is missing.
  if (agents !== undefined && agents > 0) {
    if ((completed ?? 0) >= agents) {
      return 'done';
    }
    if ((completed ?? 0) > 0) {
      return 'running';
    }
  }
  return 'waiting';
}

/** Overall progress fallback: weighted by per-phase completion, else done-fraction. */
function deriveProgress(phases: readonly WorkflowPhase[]): number {
  if (phases.length === 0) {
    return 0;
  }
  const haveCounts = phases.some((p) => (p.agents ?? 0) > 0);
  if (haveCounts) {
    let total = 0;
    let done = 0;
    for (const p of phases) {
      // Defensive clamping: a single malformed (negative) count must not be able
      // to zero out or invert the aggregate progress.
      const a = Math.max(0, p.agents ?? 0);
      total += a;
      done += Math.min(Math.max(0, p.completed ?? 0), a);
    }
    return total > 0 ? (done / total) * 100 : 0;
  }
  const doneCount = phases.filter((p) => p.state === 'done').length;
  return (doneCount / phases.length) * 100;
}

// --- coercion helpers -------------------------------------------------------

function asString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function optionalString(value: unknown): string | undefined {
  const s = asString(value).trim();
  return s.length > 0 ? s : undefined;
}

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return 0;
}

/** Optional non-negative count (agents/completed). Negatives are rejected as noise. */
function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  let n: number | undefined;
  if (typeof value === 'number' && Number.isFinite(value)) {
    n = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      n = parsed;
    }
  }
  return n !== undefined && n >= 0 ? n : undefined;
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}
