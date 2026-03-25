# Architecture overview

Go Live is a VS Code extension that runs a local static server with live reload, optional proxying, and an optional embedded preview with real Chromium DevTools.

## Components

### 1. Extension host (`extension.ts`)

- **Activation**: `onStartupFinished`.
- **Commands**: `go-live.start`, `go-live.stop`, `go-live.openSettings`, `go-live.openPreview`.
- **State**: `Map` of workspace folder path → `{ LiveServer, FileWatcher, port, … }`.
- **Status bar**: Shows Go Live / active port; tooltip links to start, open preview, settings.
- **Preview coordination**: When a server stops, calls `PreviewWebview.notifyLiveServerStopped(port)` so an open preview can tear down Chromium and show a banner.
- **Deactivate**: Disposes the preview panel and stops all servers.

### 2. Live server (`server.ts`)

Express app that:

- Serves static files from the configured **root** (per workspace).
- Injects a small client script into HTML for **WebSocket live reload** and **Legacy DevTools hooks** (console, inspect picker, storage) when the page runs inside the VS Code webview iframe.
- Optional **SPA fallback** to `index.html`.
- Optional **HTTP proxy** for API backends (`http-proxy-middleware`).

See [server.md](server.md).

### 3. File watcher (`watcher.ts`)

- Uses **chokidar** on the serve root.
- Respects `go-live.ignorePatterns`.
- On change, invokes the server’s `reload()`, which broadcasts `reload` over WebSockets to connected clients.

See [watcher.md](watcher.md).

### 4. Settings webview (`webview.ts`)

- Form UI for `go-live.*` settings; persists via `vscode.workspace.getConfiguration`.

### 5. Preview webview (`preview.ts`)

- **Single** `WebviewPanel` (`PreviewWebview.currentPanel`) showing the live URL.
- Two preview modes (see [webviews.md](webviews.md)):
  - **Screencast (default)**: Chromium renders the page; the extension uses **CDP** to stream JPEG frames to a canvas and forwards pointer/keyboard input. The bottom panel embeds the real **Chromium DevTools** frontend in an iframe.
  - **Iframe (legacy)**: The webview’s own iframe loads the live URL directly; **Legacy** tabs mirror that iframe only (not the Chromium tab).
- Starts or restarts a **Chromium debugging session** (`chromiumDevToolsSession.ts`) and optionally a **CDP WebSocket bridge** (`cdpPreviewBridge.ts`).

### 6. Chromium session (`chromiumDevToolsSession.ts`)

- Launches Chrome/Chromium/Edge (or path from settings) with **remote debugging** on a free or configured port.
- Opens the live page in a browser tab/window (possibly headless or off-screen per settings).
- Fetches `http://127.0.0.1:<port>/json/list`, picks the matching **page** target, returns:
  - `inspectorHttpUrl` — URL for the DevTools iframe
  - `webSocketDebuggerUrl` — CDP WebSocket for the page (multiple clients allowed; DevTools may use another)
  - `dispose` — kill browser / cleanup

See [chromium-cdp.md](chromium-cdp.md).

### 7. CDP preview bridge (`cdpPreviewBridge.ts`)

- One **WebSocket** to the page target’s `webSocketDebuggerUrl`.
- **Screencast**: `Page.startScreencast` → forwards `Page.screencastFrame` to the webview; webview acks with `Page.screencastFrameAck`.
- **Input**: `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent` from webview messages.
- **Device metrics**: `Emulation.setDeviceMetricsOverride` / `clear` from toolbar presets.
- **Network+**: `Network.enable` + event pipeline for **XHR/Fetch**; replay via `Runtime.evaluate` + `fetch()` in page context.

See [chromium-cdp.md](chromium-cdp.md).

## End-to-end flows

### Go Live

1. User runs **Go Live** for a workspace folder.
2. `LiveServer.start()` binds the port and begins serving.
3. `FileWatcher` starts.
4. If **Open Browser** is enabled, the system browser opens `http://localhost:<port>`.

### Open Preview

1. Requires at least one active server.
2. `PreviewWebview.show` creates or reuses the panel and navigates to `http://localhost:<port>`.
3. Chromium session starts; DevTools iframe URL is posted to the webview.
4. If `go-live.useIframePreview` is false, `CdpPreviewBridge.connect` runs screencast + network capture path.

### File save → reload

1. Watcher fires → `liveServer.reload()`.
2. WebSocket clients (injected script in any open tab that connected) receive reload.
3. The VS Code iframe preview, if used, reloads with the page; screencast shows whatever Chromium’s tab does after reload.

### Stop server

1. Server and watcher stop; entry removed from `activeServers`.
2. If the preview was showing that port, `notifyLiveServerStopped` disposes CDP/Chrome and updates the webview UI.

## Configuration (summary)

All keys are under `go-live` in VS Code settings. Full list and defaults are in `package.json` → `contributes.configuration`. Notable keys:

| Key | Role |
|-----|------|
| `port`, `root`, `spa`, `proxy`, `ignorePatterns`, `devCommand`, `openBrowser` | Server and watcher |
| `chromeExecutable`, `devtoolsDebugPort`, `chromeHeadless`, `chromeOffScreenWindow` | Chromium launch |
| `useIframePreview` | `true` = legacy iframe only; `false` = Chromium screencast + shared DevTools target |

## Dependencies (runtime)

- **express**, **http-proxy-middleware**, **chokidar**, **ws** — server, proxy, watch, CDP client.
