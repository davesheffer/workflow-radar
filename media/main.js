// @ts-check
/*
 * Workflow Radar — webview client.
 *
 * Receives `{ type: 'update', snapshot, config }` messages from the extension
 * host and renders the dashboard. All DOM is built via `el()` using textContent
 * / text nodes — never innerHTML — so producer-controlled strings (workflow
 * names, notes, event messages) cannot inject markup. Freshness ("updated Ns
 * ago" + the stale banner) ticks locally every second against a host-supplied
 * clock offset, so the host doesn't have to re-push just to advance time.
 */

(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  /**
   * @typedef {{ snapshot: any, config: any, receivedAt: number, clockSkew: number }} ViewState
   */

  /** @type {ViewState | null} */
  let state = /** @type {any} */ (vscode.getState()) || null;

  const root = /** @type {HTMLElement} */ (document.getElementById('app'));

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || msg.type !== 'update') {
      return;
    }
    const receivedAt = Date.now();
    state = {
      snapshot: msg.snapshot,
      config: msg.config,
      receivedAt,
      // Difference between host clock and ours; usually ~0 (same machine).
      clockSkew: receivedAt - (msg.config ? msg.config.serverTime : receivedAt),
    };
    vscode.setState(state);
    render();
  });

  // Live tick for relative time + stale flagging (no host round-trip needed).
  setInterval(() => {
    if (state && state.snapshot && state.snapshot.status) {
      updateFreshness();
    }
  }, 1000);

  // Tell the host we're alive so it pushes the current snapshot.
  vscode.postMessage({ type: 'ready' });

  if (state) {
    render();
  }

  // --- rendering ------------------------------------------------------------

  function render() {
    if (!state) {
      return;
    }
    const { snapshot } = state;
    clear(root);

    if (!snapshot || !snapshot.meta || !snapshot.status) {
      // File present but unparseable with no prior good status: show the parse
      // error, not the generic "no file" empty state.
      const brokenError =
        snapshot && snapshot.meta && snapshot.meta.present ? snapshot.meta.error : null;
      root.appendChild(renderEmpty(snapshot, brokenError));
      return;
    }

    const status = snapshot.status;
    root.appendChild(renderHeader(status, snapshot.meta));

    const banner = renderBanners(snapshot.meta);
    if (banner) {
      root.appendChild(banner);
    }

    root.appendChild(renderPhases(status.phases || []));
    root.appendChild(renderEvents(status.events || []));

    updateFreshness();
  }

  function renderHeader(status, meta) {
    const header = el('div', { class: 'header' });

    const top = el('div', { class: 'header-top' });
    top.appendChild(el('h1', { class: 'workflow-name', title: status.workflow }, status.workflow));
    top.appendChild(renderStatusBadge(status.status));
    header.appendChild(top);

    // current phase + updated-ago line
    const metaRow = el('div', { class: 'header-meta' });
    if (status.currentPhase) {
      metaRow.appendChild(el('span', null, 'phase: '));
      metaRow.appendChild(el('span', { class: 'mono' }, status.currentPhase));
      metaRow.appendChild(el('span', { class: 'dot' }));
    }
    const ago = el('span', { id: 'ago', class: 'ago' }, '');
    metaRow.appendChild(ago);
    header.appendChild(metaRow);

    // overall progress
    const progRow = el('div', { class: 'progress-row' });
    const progressClass =
      status.status === 'failed' ? 'failed' : status.status === 'completed' ? 'done' : '';
    progRow.appendChild(
      el('div', { class: 'progress' },
        el('div', { class: 'progress-track' }),
        el('div', { class: 'progress-fill ' + progressClass, style: 'width:' + clampPct(status.progress) + '%' }),
      ),
    );
    progRow.appendChild(el('span', { class: 'progress-pct' }, clampPct(status.progress) + '%'));
    header.appendChild(progRow);

    return header;
  }

  function renderStatusBadge(runState) {
    const labels = {
      running: 'Running',
      completed: 'Completed',
      failed: 'Failed',
      paused: 'Paused',
      idle: 'Idle',
    };
    return el('span', { class: 'badge status-' + runState },
      el('span', { class: 'dot' }),
      labels[runState] || runState,
    );
  }

  function renderBanners(meta) {
    // Parse error takes precedence; stale handled live in updateFreshness().
    if (meta.error) {
      return el('div', { class: 'banner error' },
        el('span', { class: 'icon' }, '⚠'),
        el('span', null, 'Status file problem: ' + meta.error + ' — showing last good data.'),
      );
    }
    return null;
  }

  function renderPhases(phases) {
    const section = el('div', { class: 'section' });
    section.appendChild(
      el('div', { class: 'section-title' },
        'Phases',
        el('span', { class: 'count' }, String(phases.length)),
      ),
    );

    if (phases.length === 0) {
      section.appendChild(el('div', { class: 'muted' }, 'No phases reported.'));
      return section;
    }

    const table = el('div', { class: 'phases' });
    for (const phase of phases) {
      table.appendChild(renderPhase(phase));
    }
    section.appendChild(table);
    return section;
  }

  function renderPhase(phase) {
    const stateClass = 'state-' + phase.state;
    const row = el('div', { class: 'phase ' + stateClass });

    row.appendChild(el('span', { class: 'marker' }, el('span', { class: 'dot' })));

    const name = el('div', { class: 'phase-name' });
    name.appendChild(el('span', { class: 'label', title: phase.name }, phase.name));
    name.appendChild(el('span', { class: 'state-tag' }, phase.state));
    row.appendChild(name);

    // agent counts
    const agents = el('div', { class: 'agents' });
    if (typeof phase.agents === 'number' && phase.agents > 0) {
      const completed = typeof phase.completed === 'number' ? phase.completed : 0;
      agents.appendChild(el('b', null, String(completed)));
      agents.appendChild(document.createTextNode(' / ' + phase.agents + ' agents'));
    } else if (typeof phase.agents === 'number') {
      agents.appendChild(document.createTextNode('—'));
    }
    row.appendChild(agents);

    // per-phase progress bar
    row.appendChild(renderPhaseBar(phase));

    if (phase.note) {
      row.appendChild(el('div', { class: 'note', title: phase.note }, phase.note));
    }

    return row;
  }

  function renderPhaseBar(phase) {
    const wrap = el('div', { class: 'phase-bar' });
    const hasCounts = typeof phase.agents === 'number' && phase.agents > 0;
    const pct = hasCounts
      ? clampPct(((phase.completed || 0) / phase.agents) * 100)
      : phase.state === 'done'
        ? 100
        : 0;

    let fillClass = '';
    if (phase.state === 'done') fillClass = 'done';
    else if (phase.state === 'failed') fillClass = 'failed';

    const indeterminate = phase.state === 'running' && !hasCounts;
    const bar = el('div', { class: 'progress' + (indeterminate ? ' indeterminate' : '') },
      el('div', { class: 'progress-track' }),
      el('div', { class: 'progress-fill ' + fillClass, style: 'width:' + (indeterminate ? 35 : pct) + '%' }),
    );
    wrap.appendChild(bar);
    return wrap;
  }

  function renderEvents(events) {
    const max = state && state.config ? state.config.maxEvents : 100;
    const countLabel =
      events.length > max ? max + ' of ' + events.length : String(events.length);
    const section = el('div', { class: 'section' });
    section.appendChild(
      el('div', { class: 'section-title' },
        'Event Log',
        el('span', { class: 'count' }, countLabel),
      ),
    );

    if (events.length === 0) {
      section.appendChild(el('div', { class: 'muted' }, 'No events yet.'));
      return section;
    }

    // newest first, capped
    const list = el('div', { class: 'events' });
    const ordered = events.slice(-max).reverse();
    for (const ev of ordered) {
      const levelClass = ev.level ? ' level-' + ev.level : '';
      list.appendChild(
        el('div', { class: 'event' + levelClass },
          el('span', { class: 'ts' }, ev.timestamp || ''),
          el('span', { class: 'msg' }, ev.message || ''),
        ),
      );
    }
    section.appendChild(list);
    return section;
  }

  function renderEmpty(snapshot, error) {
    const label = snapshot && snapshot.meta && snapshot.meta.sourceLabel
      ? snapshot.meta.sourceLabel
      : '.workflow/status.json';

    const wrap = el('div', { class: 'empty' });

    // File exists but could not be parsed (and we have no prior good render).
    if (error) {
      wrap.appendChild(
        el('div', { class: 'banner error' },
          el('span', { class: 'icon' }, '⚠'),
          el('span', null, 'Could not parse ', el('code', { class: 'path' }, label), ': ' + error),
        ),
      );
      wrap.appendChild(el('h2', null, 'Status file is invalid'));
      wrap.appendChild(
        el('p', { class: 'muted' }, 'Fix the JSON to resume monitoring. Expected shape:'),
      );
      wrap.appendChild(el('pre', null, SAMPLE_TEXT));
      const errRow = el('div', { class: 'btn-row' });
      const openBtn = el('button', { class: 'btn' }, 'Open status file');
      openBtn.addEventListener('click', () =>
        vscode.postMessage({ type: 'command', command: 'openStatusFile' }),
      );
      errRow.appendChild(openBtn);
      wrap.appendChild(errRow);
      return wrap;
    }

    wrap.appendChild(el('h2', null, 'No workflow detected'));
    wrap.appendChild(
      el('p', null,
        'Workflow Radar watches ',
        el('code', { class: 'path' }, label),
        ' and renders any process that writes status updates to it.',
      ),
    );
    wrap.appendChild(el('p', { class: 'muted' }, 'Have a process write JSON like this:'));
    wrap.appendChild(el('pre', null, SAMPLE_TEXT));

    const row = el('div', { class: 'btn-row' });
    const create = el('button', { class: 'btn' }, 'Create sample file');
    create.addEventListener('click', () =>
      vscode.postMessage({ type: 'command', command: 'createSampleStatus' }),
    );
    const open = el('button', { class: 'btn secondary' }, 'Open status file');
    open.addEventListener('click', () =>
      vscode.postMessage({ type: 'command', command: 'openStatusFile' }),
    );
    row.appendChild(create);
    row.appendChild(open);
    wrap.appendChild(row);
    return wrap;
  }

  // --- live freshness -------------------------------------------------------

  function updateFreshness() {
    if (!state || !state.snapshot || !state.snapshot.status) {
      return;
    }
    const meta = state.snapshot.meta;
    const agoEl = document.getElementById('ago');
    if (!meta || meta.lastUpdated == null) {
      if (agoEl) agoEl.textContent = '';
      return;
    }

    // meta.lastUpdated is on the host clock (file mtime). clockSkew = local - host,
    // so convert our local now to host time by SUBTRACTING the offset.
    const now = Date.now() - state.clockSkew;
    const ageMs = Math.max(0, now - meta.lastUpdated);
    if (agoEl) {
      agoEl.textContent = 'updated ' + formatAgo(ageMs);
    }

    const thresholdMs = (state.config ? state.config.staleThresholdSeconds : 30) * 1000;
    const stale = ageMs > thresholdMs;
    syncStaleBanner(stale, ageMs);
  }

  function syncStaleBanner(stale, ageMs) {
    let banner = document.getElementById('stale-banner');
    if (stale && !banner) {
      banner = el('div', { id: 'stale-banner', class: 'banner stale' },
        el('span', { class: 'icon' }, '◷'),
        el('span', { id: 'stale-text' }, ''),
      );
      // Place above the phases section — i.e. below the header AND below any
      // higher-precedence parse-error banner.
      const anchor = root.querySelector('.section');
      if (anchor) {
        root.insertBefore(banner, anchor);
      } else {
        root.appendChild(banner);
      }
    } else if (!stale && banner) {
      banner.remove();
      return;
    }
    if (stale && banner) {
      const text = banner.querySelector('#stale-text');
      if (text) {
        text.textContent = 'No update for ' + formatAgo(ageMs) + ' — workflow may be stalled.';
      }
    }
  }

  // --- helpers --------------------------------------------------------------

  /**
   * Tiny hyperscript helper. Builds an element, applies attributes, appends
   * children. String children become text nodes (XSS-safe by construction).
   * @param {string} tag
   * @param {Record<string, any> | null} [attrs]
   * @param {...any} children
   * @returns {HTMLElement}
   */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const key of Object.keys(attrs)) {
        const value = attrs[key];
        if (value == null) continue;
        if (key === 'class') node.className = value;
        // Apply styles via CSSOM, NOT setAttribute('style', …): a strict
        // style-src CSP (no 'unsafe-inline') blocks inline style *attributes*
        // but permits CSSOM mutations, so this keeps the bars rendering.
        else if (key === 'style') node.style.cssText = value;
        else node.setAttribute(key, String(value));
      }
    }
    for (const child of children) {
      appendChild(node, child);
    }
    return node;
  }

  function appendChild(node, child) {
    if (child == null) return;
    if (Array.isArray(child)) {
      child.forEach((c) => appendChild(node, c));
    } else if (typeof child === 'string' || typeof child === 'number') {
      node.appendChild(document.createTextNode(String(child)));
    } else {
      node.appendChild(child);
    }
  }

  function clear(node) {
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function clampPct(n) {
    const v = typeof n === 'number' && isFinite(n) ? n : 0;
    return Math.max(0, Math.min(100, Math.round(v)));
  }

  function formatAgo(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 2) return 'just now';
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ' + (m % 60) + 'm ago';
    const d = Math.floor(h / 24);
    return d + 'd ago';
  }

  const SAMPLE_TEXT =
    '{\n' +
    '  "workflow": "alive",\n' +
    '  "status": "running",\n' +
    '  "currentPhase": "verify",\n' +
    '  "progress": 62,\n' +
    '  "phases": [\n' +
    '    { "name": "Finders", "agents": 9, "completed": 9, "state": "done" },\n' +
    '    { "name": "Verifiers", "agents": 51, "completed": 18, "state": "running" }\n' +
    '  ],\n' +
    '  "events": [\n' +
    '    { "timestamp": "11:42", "message": "verifier-12 challenged F-07" }\n' +
    '  ]\n' +
    '}';
})();
