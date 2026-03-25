# Chromium launch and Chrome DevTools Protocol (CDP)

This document describes how the extension launches Chromium, attaches the embedded DevTools UI, and uses a second CDP WebSocket for screencast, input, device emulation, and optional **Network+** capture/replay.

## Source files

| File | Responsibility |
|------|----------------|
| `chromiumDevToolsSession.ts` | Resolve Chrome binary, pick debug port, spawn process, wait for `/json`, match page target, build inspector URL |
| `cdpPreviewBridge.ts` | WebSocket CDP client: screencast, input, emulation, reload, network capture, `Runtime.evaluate` replay |
| `preview.ts` | Webview HTML/JS, wires messages ↔ bridge, starts/stops session with server lifecycle |

## Chromium session (`startChromiumDebuggingSession`)

### Executable resolution (`resolveChromeExecutable`)

Order of precedence:

1. Non-empty `go-live.chromeExecutable` if the path exists  
2. `CHROME_PATH` environment variable if it exists  
3. Platform defaults (e.g. macOS: `/Applications/Google Chrome.app/...`, Linux `google-chrome-stable`, etc.)

### Port selection

- If `go-live.devtoolsDebugPort` is a positive number and the port is free, it is used.
- Otherwise the first free port in **9222–9321** is chosen.

### Launch flags (conceptual)

- Remote debugging on the chosen port (`--remote-debugging-port=...`).
- User data dir under the extension’s **global storage** (`go-live-chrome-profile`) for a stable profile.
- **`go-live.chromeHeadless`**: `--headless=new` when enabled (DevTools + screencast still work on supported Chromium builds).
- **`go-live.chromeOffScreenWindow`**: when not headless, window position off-screen to reduce distraction.

### Target discovery

After the browser is up, the code polls `http://127.0.0.1:<port>/json/version` until ready, then reads `http://127.0.0.1:<port>/json/list`.

It selects a **`page`** target whose `url` matches the live page URL (or normalized http/localhost variants). Returns:

| Field | Use |
|-------|-----|
| `inspectorHttpUrl` | Loaded in the preview’s DevTools iframe (`devtoolsFrontendUrl` from list, rewritten to use `127.0.0.1` and the session debug port) |
| `webSocketDebuggerUrl` | CDP WebSocket for the **page** target (second client; DevTools may already use one) |
| `targetId` | Target id from JSON list |
| `debugPort` | Actual debugging port |
| `dispose` | Kill child process and run temp profile cleanup when applicable |

## CDP preview bridge (`CdpPreviewBridge`)

### Connection (`CdpPreviewBridge.connect`)

1. Open WebSocket to `webSocketDebuggerUrl`.
2. Send CDP commands (awaited until response):
   - `Page.enable`
   - `Input.enable`
   - `Runtime.enable`
   - `Network.enable`
   - `Page.startScreencast` (JPEG, quality/max dimensions as in code)

On failure after open, the bridge is disposed and the error propagates.

### Disposal

- Sets `disposed`, rejects pending command promises, sends `Page.stopScreencast` best-effort, closes socket.
- Clears **pending network captures** and **stored captures**.

### Incoming CDP events (non-command responses)

| Event | Handling |
|-------|----------|
| `Page.screencastFrame` | Invokes frame callback → preview posts `screencastFrame` to webview |
| `Network.requestWillBeSent` | If `type` is **`XHR`** or **`Fetch`**, start a pending capture (url, method, headers, optional `postData`) |
| `Network.requestWillBeSentExtraInfo` | Merge header pairs into the pending capture for that `requestId` |
| `Network.loadingFinished` | Finalize pending capture for `requestId` |
| `Network.requestFailed` | Finalize pending capture for `requestId` (replay may still be attempted with captured data) |

### Finalizing a network capture

1. Remove from pending map.
2. For methods other than `GET`/`HEAD`, if body still missing, call **`Network.getRequestPostData`** (errors ignored).
3. Assign monotonic **`id`** (per bridge instance), store in map (cap **100** entries; evict lowest id when over limit).
4. Call optional **`onNetworkEntry`** (`NetworkEntrySummary`) → preview posts **`cdpNetworkEntry`**.

### Replay (`replayNetworkRequest(captureId)`)

1. Look up capture by numeric `id`.
2. Build a JSON-serializable spec: `url`, `method`, `headers`, `body` (post data or `null`).
3. Strip header names that are unsafe or not allowed on `fetch` from script: includes **`host`**, **`cookie`**, **`content-length`**, **`connection`**, **`keep-alive`**, **`transfer-encoding`**, **`origin`**, **`referer`** (case-insensitive match on keys).
4. `Runtime.evaluate` with an async IIFE that runs **`fetch(spec.url, init)`** in the **page** world, `awaitPromise: true`, `returnByValue: true`.
5. Returned object includes `ok`, `status`, `contentType`, `bodyPreview` (truncated in-page; host also bounds length).

**Why `Runtime.evaluate`:** The request runs in the inspected page’s JavaScript realm, so **same-origin cookies** and typical **CORS** behavior match a normal in-page `fetch`, not an extension-side HTTP client.

### Webview → bridge message reference (`handleWebviewMessage`)

| Message | CDP method / behavior |
|---------|------------------------|
| `screencastAck` | `Page.screencastFrameAck` |
| `cdpMouse` | `Input.dispatchMouseEvent` (maps `buttons` when omitted) |
| `cdpWheel` | `Input.dispatchMouseEvent` (`mouseWheel`) |
| `cdpKey` | `Input.dispatchKeyEvent` |
| `cdpDeviceMetrics` | `Emulation.setDeviceMetricsOverride` (+ screen width/height aligned to viewport) |
| `cdpClearDeviceMetrics` | `Emulation.clearDeviceMetricsOverride` |
| `cdpReload` | `Page.reload` |
| `cdpNetworkClear` | Clears in-memory capture maps and resets capture id counter |

### Commands using internal `sendRaw`

Mouse/wheel/key/device/reload use **fire-and-forget** `sendRaw` (no promise). Screencast ack uses `sendRaw` as well. `sendCommand` is used for connect sequence, `getRequestPostData`, and `Runtime.evaluate`.

## Network+ UI (preview webview)

- **Network+** is visible only in **screencast** mode.
- Toggles **`#network-capture-bar`**: list container, **Clear list** (`cdpNetworkClear`), per-row **Replay** (`cdpNetworkReplay` + capture `id`).
- **Clear list** clears the bridge store and UI via `cdpNetworkCleared`.
- On successful screencast bridge attach, **`cdpNetworkCleared`** is sent once so stale rows disappear after reconnect.

## Limitations (intentional / environmental)

- **Network+** only lists **XHR** and **Fetch** CDP resource types; static assets are ignored.
- **Pixel parity** with a standalone Chrome window is not guaranteed (scaling, JPEG screencast, webview CSP).
- **Replay** is best-effort: some headers cannot be set from `fetch`; stripped headers may change behavior vs the original request.
- Multiple CDP clients on one target are supported by Chromium; extreme concurrency is untested.

## Related settings

| Setting | Effect on this stack |
|---------|----------------------|
| `go-live.chromeExecutable` | Binary path |
| `go-live.devtoolsDebugPort` | Fixed debug port vs auto 9222–9321 |
| `go-live.chromeHeadless` | Headless Chromium |
| `go-live.chromeOffScreenWindow` | Off-screen window when not headless |
| `go-live.useIframePreview` | Skip screencast bridge; iframe-only main preview |
