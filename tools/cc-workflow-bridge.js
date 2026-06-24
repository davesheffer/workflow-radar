#!/usr/bin/env node
// @ts-check
/*
 * cc-workflow-bridge — feed live Claude Code workflow runs into Workflow Radar.
 *
 * Claude Code's `/workflow` (ultracode) runs write an append-only journal
 * (`journal.jsonl`) per run under:
 *   ~/.claude/projects/<project>/<session>/subagents/workflows/wf_<id>/journal.jsonl
 * Each line is `{type:"started"|"result", agentId, ...}`. This watcher tails the
 * newest active run and translates it into the `.workflow/status.json` schema
 * that the Workflow Radar extension renders.
 *
 * WHAT IT CAN SHOW (reliably, live):
 *   - agents dispatched / completed / in-flight
 *   - overall progress + running/completed state
 *   - an activity log (agent started / finished)
 *
 * WHAT IT CANNOT SHOW: per-phase names, labels, tokens. Those are harness-derived
 * and only written to the run's `.output` at completion — there is no documented
 * live source. This bridge depends on an INTERNAL, undocumented file format and
 * may break on Claude Code updates. Best-effort by design.
 *
 * Usage:
 *   node tools/cc-workflow-bridge.js [--out <path>] [--interval <ms>]
 *                                    [--dir <workflows-or-run-dir>] [--name <label>] [--once]
 *
 * Zero dependencies. Node 16+.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const args = parseArgs(process.argv.slice(2));
const OUT = path.resolve(args.out || path.join('.workflow', 'status.json'));
const INTERVAL = Number(args.interval) || 1000;
const NAME_OVERRIDE = args.name;
const DIR_OVERRIDE = args.dir ? path.resolve(args.dir) : undefined;

/** @type {Set<string>} agentIds seen as started */
const started = new Set();
/** @type {Set<string>} agentIds seen as completed */
const completed = new Set();
/** @type {{timestamp:string,message:string,level?:string}[]} */
const events = [];
const MAX_EVENTS = 100;

let activeRunDir = '';

function main() {
  ensureDir(path.dirname(OUT));
  tick();
  if (args.once) {
    return;
  }
  setInterval(tick, INTERVAL);
  log(`watching for Claude Code workflow runs → ${OUT} (every ${INTERVAL}ms)`);
}

function tick() {
  const runDir = DIR_OVERRIDE ? resolveRunDir(DIR_OVERRIDE) : findNewestRunDir();
  if (!runDir) {
    writeStatus(emptyStatus());
    return;
  }
  if (runDir !== activeRunDir) {
    // New run detected — reset accumulators.
    activeRunDir = runDir;
    started.clear();
    completed.clear();
    events.length = 0;
    log(`tracking run: ${path.basename(runDir)}`);
  }
  ingestJournal(path.join(runDir, 'journal.jsonl'));
  writeStatus(buildStatus(runDir));
}

/** Parse journal lines, accumulating started/completed sets and activity events. */
function ingestJournal(journalPath) {
  let text;
  try {
    text = fs.readFileSync(journalPath, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // partial trailing line mid-write
    }
    const id = typeof rec.agentId === 'string' ? rec.agentId : null;
    if (!id) continue;
    if (rec.type === 'started' && !started.has(id)) {
      started.add(id);
      pushEvent(`agent ${short(id)} started`);
    } else if (rec.type === 'result' && !completed.has(id)) {
      completed.add(id);
      const failed = rec.result && rec.result.error;
      pushEvent(`agent ${short(id)} ${failed ? 'failed' : 'finished'}`, failed ? 'error' : 'info');
    }
  }
}

function buildStatus(runDir) {
  const total = started.size;
  const done = completed.size;
  const inFlight = Math.max(0, total - done);
  const running = inFlight > 0;
  const progress = total > 0 ? Math.round((done / total) * 100) : 0;

  return {
    workflow: NAME_OVERRIDE || path.basename(runDir),
    status: running ? 'running' : total > 0 ? 'completed' : 'idle',
    currentPhase: running ? `${inFlight} agent${inFlight === 1 ? '' : 's'} in flight` : undefined,
    progress,
    phases: [
      {
        name: 'Agents',
        agents: total,
        completed: done,
        state: running ? 'running' : total > 0 ? 'done' : 'waiting',
        note: running ? `${inFlight} in flight` : total > 0 ? 'all complete' : 'no agents yet',
      },
    ],
    events: events.slice(-MAX_EVENTS),
    updatedAt: new Date().toISOString(),
  };
}

function emptyStatus() {
  return {
    workflow: NAME_OVERRIDE || 'Claude Code',
    status: 'idle',
    progress: 0,
    phases: [{ name: 'Agents', agents: 0, state: 'waiting', note: 'no active workflow run' }],
    events: [],
    updatedAt: new Date().toISOString(),
  };
}

// --- run discovery ----------------------------------------------------------

/** Resolve a --dir argument that may be a workflows dir OR a specific run dir. */
function resolveRunDir(dir) {
  if (fileExists(path.join(dir, 'journal.jsonl'))) {
    return dir; // it's a run dir
  }
  return newestChildRun(dir);
}

/** Scan all CC projects/sessions for the most-recently-updated run dir. */
function findNewestRunDir() {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  let best = '';
  let bestMtime = -1;
  for (const project of safeDirs(projectsRoot)) {
    for (const session of safeDirs(path.join(projectsRoot, project))) {
      const wfRoot = path.join(projectsRoot, project, session, 'subagents', 'workflows');
      const candidate = newestChildRun(wfRoot, (mtime) => {
        if (mtime > bestMtime) {
          bestMtime = mtime;
          return true;
        }
        return false;
      });
      if (candidate) best = candidate;
    }
  }
  return best;
}

/**
 * Return the newest `wf_*` child of `wfRoot` (by journal.jsonl mtime).
 * Optional `accept(mtime)` lets the caller track a global best across roots.
 */
function newestChildRun(wfRoot, accept) {
  let best = '';
  let bestMtime = -1;
  for (const child of safeDirs(wfRoot)) {
    if (!child.startsWith('wf_')) continue;
    const journal = path.join(wfRoot, child, 'journal.jsonl');
    const mtime = mtimeOf(journal);
    if (mtime < 0) continue;
    if (accept) {
      if (accept(mtime)) best = path.join(wfRoot, child);
    } else if (mtime > bestMtime) {
      bestMtime = mtime;
      best = path.join(wfRoot, child);
    }
  }
  return best;
}

// --- io helpers -------------------------------------------------------------

function writeStatus(status) {
  const tmp = OUT + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(status, null, 2));
    fs.renameSync(tmp, OUT); // atomic-ish: reader never sees a partial file
  } catch (e) {
    log(`write failed: ${e.message}`);
  }
}

function pushEvent(message, level) {
  events.push({ timestamp: clock(), message, level: level || undefined });
  if (events.length > MAX_EVENTS * 2) events.splice(0, events.length - MAX_EVENTS);
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* exists */
  }
}

function safeDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return -1;
  }
}

function fileExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function short(id) {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function clock() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function parseArgs(argv) {
  /** @type {Record<string,string|boolean>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

function log(msg) {
  process.stdout.write(`[cc-workflow-bridge] ${msg}\n`);
}

main();
