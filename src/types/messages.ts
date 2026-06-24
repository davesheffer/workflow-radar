/**
 * Typed message protocol between the extension host and the webview.
 *
 * Keeping this contract in one place lets both sides (the provider in
 * `src/view` and the client in `media/main.js`) stay in lock-step. The webview
 * is plain JS, but it is written against the shapes declared here.
 */

import type { WorkflowSnapshot } from './workflow';

/** Runtime configuration the webview needs to render freshness correctly. */
export interface WebviewConfig {
  /** Seconds without an update before the run is flagged stale. */
  readonly staleThresholdSeconds: number;
  /** Max event-log entries to render. */
  readonly maxEvents: number;
  /**
   * `Date.now()` on the extension host at send time. The webview reconciles this
   * against its own clock so the live "updated Ns ago" label stays accurate
   * without the host pushing on every tick.
   */
  readonly serverTime: number;
}

// ---------------------------------------------------------------------------
// Extension host -> Webview
// ---------------------------------------------------------------------------

export interface UpdateMessage {
  readonly type: 'update';
  readonly snapshot: WorkflowSnapshot;
  readonly config: WebviewConfig;
}

export type ExtensionToWebview = UpdateMessage;

// ---------------------------------------------------------------------------
// Webview -> Extension host
// ---------------------------------------------------------------------------

/** Commands the webview may ask the host to run. Mirrors registered command ids. */
export type WebviewCommand = 'refresh' | 'openStatusFile' | 'createSampleStatus';

export interface ReadyMessage {
  readonly type: 'ready';
}

export interface CommandMessage {
  readonly type: 'command';
  readonly command: WebviewCommand;
  /**
   * Optional target for a future multi-source / per-run action (e.g. restart or
   * open-terminal for a specific workflow). Present so targeted commands can be
   * added without changing the message shape; today's commands ignore it.
   */
  readonly target?: { readonly sourceId?: string };
}

export type WebviewToExtension = ReadyMessage | CommandMessage;
