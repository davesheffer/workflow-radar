/**
 * Builds the static HTML shell for the dashboard webview.
 *
 * The shell is intentionally minimal: an empty `#app` root that the client
 * script ({@link ../../media/main.js}) renders into. All dynamic content is built
 * client-side from posted snapshots, which keeps the host free of string-HTML
 * concatenation (and the XSS surface that comes with it).
 *
 * A strict Content-Security-Policy is applied: no inline scripts (a per-load
 * nonce gates the one script tag), styles only from the extension's `media`
 * folder, and everything else denied.
 */

import * as vscode from 'vscode';

export function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce();
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'main.js'),
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'main.css'),
  );

  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Workflow Radar</title>
</head>
<body>
  <div id="app" class="app">
    <div class="loading">Connecting to workflow source…</div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
