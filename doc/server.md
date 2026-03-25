# Live Server implementation

The `LiveServer` class in `server.ts` is the core of the Go Live extension. It serves static files, proxies API traffic when configured, injects the live-reload + **Legacy DevTools** client script into HTML, and broadcasts reloads over WebSockets.

For how the **Preview** uses either the injected iframe page or a separate **Chromium** tab (screencast), see [webviews.md](webviews.md) and [chromium-cdp.md](chromium-cdp.md).

## Server Setup
The server uses **Express** and **http-proxy-middleware** for robust handling of static and dynamic requests.

### 1. Static File Serving
Static files are served from the user-defined `root` directory. The server automatically injects the **Live Reload & DevTools** script into every HTML response.

### 2. Live Reload Injection
Whenever an `.html` file is requested, the server reads the file content and injects a specialized `<script>` tag before the `</body>` tag. 
This script:
- Establishes a **WebSocket** connection to `ws://localhost:PORT`.
- Listens for the `reload` message from the server (triggered by the `FileWatcher`).
- Implements **Console Interception**: Overrides `console.log`, `error`, etc., to capture logs and send them to the parent window (VS Code Webview via `postMessage`).
- Implements **Element Picking**: Adds listeners to the DOM to support the "Inspect" tool in the embedded DevTools.

### 3. SPA Fallback
In Single Page Application mode, the server uses a fallback middleware. If a request does not match any physical file and is not an API proxy request, it returns the `index.html` file from the root directory. This allows client-side routers (React Router, Vue Router, etc.) to handle deep-linked URLs.

### 4. Proxy Support
The server can proxy non-file requests to a backend API (e.g., `localhost:3000`). This is configured via the `proxy` setting. It uses `http-proxy-middleware` for seamless integration, including support for `changeOrigin`.

## WebSocket communication

On startup, a `ws.Server` is attached (same HTTP server as Express).

- **Client connection**: Any page that loads the injected script opens a WebSocket to the live server host; the server stores the socket.
- **Broadcasting**: When `liveServer.reload()` is called (file watcher or manual), the server sends the string `'reload'` to every connected client so the page can `location.reload()` (or equivalent).

The **embedded preview iframe** uses the same injection when it loads served HTML, so it receives reloads. The **Chromium screencast** preview shows whatever the debug browser tab does; that tab also loads the same URL and therefore the same script and WebSocket if the document is HTML from this server.

## Class responsibilities (`server.ts`)

- **Constructor**: `rootDir`, `port`, `spa` flag, optional `proxy` URL.
- **`start()`**: Creates HTTP server, Express app, WebSocket server, proxy middleware if needed; binds starting at the configured port and increments on `EADDRINUSE` (up to a fixed number of attempts); returns the bound port.
- **`stop()`**: Closes server and clears client sockets.
- **`reload()`**: WebSocket broadcast to all clients.
- **HTML injection**: Rewrites HTML responses to insert the client script before `</body>` (or at end of document).

## Related documentation

- [architecture.md](architecture.md) — how server, watcher, and preview fit together  
- [webviews.md](webviews.md) — Legacy Console / Elements / Storage vs Chromium Inspector
