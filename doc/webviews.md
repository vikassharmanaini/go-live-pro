# Webview UI

The extension uses two webviews: **Settings** and **Preview**.

## Settings webview (`webview.ts`)

- Opened via command **Go Live: Go Live Settings** (`go-live.openSettings`).
- Reads `go-live` configuration when opened; **Save** writes back through `vscode.workspace.getConfiguration('go-live')`.
- Styled as a standalone dark settings page (glass-style panels).

---

## Preview webview (`preview.ts`)

Opened via **Go Live: Open Preview** (`go-live.openPreview`) while a live server is running. Title: `Live: <folder name>`.

### Top toolbar

| Control | Behavior |
|---------|----------|
| Reload | Screencast: `cdpReload` → CDP `Page.reload`. Iframe: resets `iframe.src`. |
| Inspect | **Iframe mode only.** Toggles inject-driven element picker; posts into iframe. Disabled in screencast (Chromium page is not the webview iframe). |
| Device dropdown | Resizes the preview container visually; in screencast also sends `cdpDeviceMetrics` / `cdpClearDeviceMetrics`. |
| URL field | Read-only display of the live URL. |
| Inspector | Toggles height of the bottom **devtools** panel (resize handle still adjusts height). |

### Preview area (main stage)

- **`#previewFrame`**: iframe loading the live HTTP URL (always present).
- **`#screencastCanvas`**: shows JPEG frames from Chromium when `body.preview-screencast` is active.
- **`#screencast-placeholder`**: “Connecting…” until the first frame or fallback.
- Banners: **screencast bridge error**, **live server stopped**, **Chrome failed** (see messages below).

### Bottom panel: Inspector vs Legacy

#### Inspector view (default)

- Embeds Chromium’s own DevTools in **`#chrome-devtools-frame`** using `inspectorHttpUrl` from `chromiumDevToolsSession`.
- **Network+** button (screencast only): toggles a slim panel listing CDP-captured **XHR/Fetch** requests with **Replay** (see [chromium-cdp.md](chromium-cdp.md)).
- **Legacy (webview only)** is hidden in screencast mode (no dual target to confuse users).

#### Legacy view

- Explicitly labeled as mirroring the **VS Code webview iframe** only, not the Chromium tab.
- Tabs: **Console**, **Elements**, **Storage** — fed by the **injected script** in `server.ts` when the iframe loads the served page.

### Preview modes

| Mode | When | What the user sees |
|------|------|---------------------|
| **Screencast** | `go-live.useIframePreview` is `false` (default) and CDP screencast connects | Chromium tab as a canvas; DevTools inspect that same tab. |
| **Iframe** | Setting `true`, or Chrome/CDP failure, or live server stopped while preview open | Webview iframe only; Legacy tools apply; DevTools iframe may still load if Chrome started. |

Changing **`go-live.useIframePreview`** triggers a Chrome/CDP restart from the preview constructor’s configuration listener.

---

## Messages: extension host → webview

Posted with `WebviewPanel.webview.postMessage`.

| `command` / shape | Purpose |
|-------------------|---------|
| `updateUrl` + `url` | Sync iframe + URL field after navigation. |
| `chromeInspectorLoading` + `screencastTarget?: boolean` | Reset inspector iframe; set preview mode toward screencast or iframe while connecting. |
| `setChromeInspector` + `url` | Set DevTools iframe `src` (empty string = loading state). |
| `chromeInspectorError` + `message` | Show error hint; fall back to iframe preview messaging. |
| `setPreviewMode` + `mode`: `'screencast'` \| `'iframe'` | Toggle body classes and toolbar behavior. |
| `screencastFrame` + `data`, `sessionId`, `metadata` | JPEG base64 + ack id for screencast. |
| `screencastBridgeError` + `message` | Banner when CDP bridge fails; UI falls back to iframe. |
| `liveServerStopped` + `message` | Banner; dispose Chrome; switch to iframe-style messaging. |
| `cdpNetworkEntry` + `entry` | New row for Network+ (`id`, `url`, `method`, `timestamp`, optional `resourceType`). |
| `cdpNetworkCleared` | Empty Network+ list and replay output (also sent after a fresh screencast bridge connects). |
| `cdpNetworkReplayResult` + `id`, `ok`, optional `status`, `contentType`, `bodyPreview`, `error` | Replay outcome for the output strip. |

**Legacy DevTools** (from injected page script → server → not covered here in full): messages with `type: 'devtools'` and `method` `log` | `warn` | `error` | `element` | `storage` still drive Legacy tabs when the iframe preview is active.

---

## Messages: webview → extension host

Handled in `PreviewWebview` via `onDidReceiveMessage`.

### CDP bridge messages (`isCdpWebviewMessage` in `cdpPreviewBridge.ts`)

Forwarded to `CdpPreviewBridge.handleWebviewMessage` when the bridge exists:

| `command` | Role |
|-----------|------|
| `screencastAck` | `Page.screencastFrameAck` |
| `cdpMouse` | `Input.dispatchMouseEvent` (press/move/release) |
| `cdpWheel` | `Input.dispatchMouseEvent` (`mouseWheel`) |
| `cdpKey` | `Input.dispatchKeyEvent` |
| `cdpDeviceMetrics` | `Emulation.setDeviceMetricsOverride` |
| `cdpClearDeviceMetrics` | `Emulation.clearDeviceMetricsOverride` |
| `cdpReload` | `Page.reload` |
| `cdpNetworkClear` | Clear captured network log on the bridge; host also posts `cdpNetworkCleared`. |

### Replay (handled in `preview.ts` only)

| `command` | Role |
|-----------|------|
| `cdpNetworkReplay` + `id` | Run `replayNetworkRequest(id)` on the bridge; post `cdpNetworkReplayResult`. |

If there is no active bridge, the host still replies with `cdpNetworkReplayResult` (`ok: false`, error message).

---

## Lifecycle and disposal

- **`PreviewWebview.dispose`**: clears `currentPanel`, disposes CDP bridge, kills Chromium session, disposes subscriptions and panel.
- **`killChromeSession`**: used when stopping the matching live server; clears bridge + browser without tearing down the whole webview panel class.
- **`PreviewWebview.disposeChromeSession`**: static helper for external callers.

---

## Content Security Policy (preview HTML)

The generated HTML sets a strict CSP: scripts `unsafe-inline` + webview `cspSource`; `frame-src` / `img-src` / `connect-src` allow http(s), data, blob, and ws where needed for DevTools and images.
