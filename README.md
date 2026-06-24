# Workflow Radar

A live **observability dashboard** for long-running AI workflows, multi-agent
systems, coding/research agents, and orchestrated tasks — right inside the VS
Code sidebar.

> Workflow Radar is **not** a worktree manager or a terminal manager. It is a
> read-only monitoring surface. Any process writes status to a JSON file; the
> extension watches that file and renders a dense, scannable dashboard that feels
> like GitHub Actions / Temporal / LangGraph / Airflow.

## How it works

```
  your process ──writes──▶  .workflow/status.json  ──watched by──▶  Workflow Radar
```

1. Any external process (an orchestrator, a script, an agent harness) writes a
   small JSON status file.
2. The extension watches the file with a VS Code `FileSystemWatcher`.
3. On every change it re-reads, normalizes, and re-renders the dashboard.

You never call an API. You just write a file.

## The status schema

Minimal example (everything except `workflow` is optional):

```json
{
  "workflow": "alive",
  "status": "running",
  "currentPhase": "verify",
  "progress": 62,
  "phases": [
    { "name": "Finders",   "agents": 9,  "completed": 9,  "state": "done",    "note": "9 lenses swept" },
    { "name": "Verifiers", "agents": 51, "completed": 18, "state": "running", "note": "3 skeptics × 17 findings" },
    { "name": "Critic",      "agents": 0, "state": "waiting" },
    { "name": "Synthesizer", "agents": 0, "state": "waiting" }
  ],
  "events": [
    { "timestamp": "11:42", "message": "verifier-12 challenged finding F-07" },
    { "timestamp": "11:43", "message": "verifier-18 marked risk medium" }
  ]
}
```

| Field            | Type                                                      | Notes |
|------------------|-----------------------------------------------------------|-------|
| `workflow`       | string                                                    | Display name. |
| `status`         | `running` `completed` `failed` `paused` `idle`            | Aliases like `active`, `done`, `error` are accepted. Inferred from phases if omitted. |
| `currentPhase`   | string                                                    | Optional highlighted phase. |
| `progress`       | number 0–100                                              | Optional. Derived from phase counts if omitted. |
| `phases[]`       | array                                                     | Ordered list of stages. |
| `phases[].name`  | string                                                    | |
| `phases[].state` | `done` `running` `waiting` `failed` `skipped`            | Aliases accepted; inferred from counts if omitted. |
| `phases[].agents`/`completed` | number                                      | Agent/task counts; drive the per-phase bar. |
| `phases[].note`  | string                                                    | Free-form annotation. |
| `events[]`       | array of `{ timestamp, message, level? }`                | `level` ∈ `info` `warn` `error`. Rendered newest-first. |

The parser is **lenient on input, strict on output**: unknown state strings are
mapped to the nearest known value, missing fields are defaulted, and a malformed
write keeps the last good render while showing a non-blocking error banner.

## Features

- Dedicated **Workflow Radar** activity-bar view (Webview, not a Tree View).
- Live workflow name, status badge, current phase, and overall progress bar.
- Dense **phase table** with per-phase state, agent counts, progress, and notes.
- Live **event log** (newest first, capped).
- **Stale warning** when the file stops updating (configurable threshold).
- Friendly **empty state** with a one-click "Create sample file" when the status
  file is missing.
- Native theming — light, dark, and high-contrast via VS Code theme tokens.

## Commands

| Command                                   | Description |
|-------------------------------------------|-------------|
| `Workflow Radar: Refresh`                 | Force a re-read. |
| `Workflow Radar: Open Status File`        | Open the watched JSON file. |
| `Workflow Radar: Create Sample Status File` | Scaffold `.workflow/status.json`. |

## Settings

| Setting                              | Default                  | Description |
|--------------------------------------|--------------------------|-------------|
| `workflowRadar.statusFilePath`       | `.workflow/status.json`  | Workspace-relative file to watch. |
| `workflowRadar.staleThresholdSeconds`| `30`                     | Seconds before a run is flagged stale. |
| `workflowRadar.maxEvents`            | `100`                    | Max event-log rows rendered. |

## Architecture

Clean separation between the four concerns the spec calls out:

```
src/
├─ types/        Data model + webview message protocol (strongly typed)
│  ├─ workflow.ts
│  └─ messages.ts
├─ data/         Data layer — parsing + the source abstraction
│  ├─ StatusParser.ts        raw JSON ▶ normalized WorkflowStatus
│  └─ WorkflowSource.ts      WorkflowSource interface + FileWorkflowSource
├─ watch/        File watching
│  └─ StatusWatcher.ts       debounced FileSystemWatcher wrapper
├─ state/        State management
│  └─ WorkflowStore.ts       owns active source, caches + emits snapshots
├─ view/         UI rendering
│  ├─ WorkflowRadarViewProvider.ts   WebviewViewProvider (host side)
│  └─ html.ts                        CSP'd HTML shell
└─ extension.ts  Composition root / activation

media/           Webview client (CSP-isolated, no bundler)
├─ main.js       Renders snapshots into DOM (XSS-safe, ticks freshness locally)
├─ main.css      Dense, theme-aware styling
└─ radar.svg     Activity-bar icon
```

Data flows one way:

```
FileWorkflowSource ─▶ WorkflowStore ─▶ ViewProvider ─▶ webview (main.js)
        ▲ StatusWatcher signals changes
```

### Designed for what comes next

The seams are deliberately placed so future versions extend at known, local
points rather than rewriting the data flow. Each item below names the seam and
the focused change it still requires — honest about what is pre-wired vs. what
remains:

- **Remote sources** — drop-in: implement the `WorkflowSource` interface
  (HTTP/WebSocket); `read()` is already async and nothing upstream changes.
- **Multiple workflows / worktrees** — `WorkflowStore` isolates a single "active
  source" today. Multi-source means refactoring its three singular fields into a
  keyed `Map` with an explicit active id, and emitting the source id on change.
  `WorkflowSource.id` and `SnapshotMeta.sourceId` are already threaded so
  consumers can key by identity; worktrees additionally need an absolute-`Uri`
  watcher (`RelativePattern` accepts a base `Uri`) and a folder enumerator.
- **Branch awareness / historical runs / filtering** — snapshots are immutable
  values, so a ring buffer in the store is natural. Branch/run identity must be
  added to `SnapshotMeta` and populated by the source/parser before history can
  be delimited per-run or filtered on more than name + time.
- **Restart buttons / terminal integration** — the webview→host protocol carries
  typed `command` messages with an optional `target.sourceId` payload, so
  targeted, per-run actions are additive (no protocol change); the host just
  registers the new commands and forwards the target.

## Develop

```bash
npm install
npm run compile      # or: npm run watch
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host, open a
folder, and run **Workflow Radar: Create Sample Status File** to see it live.
Edit the JSON and watch the dashboard update.

## License

MIT
