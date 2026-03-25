# Go Live — documentation

Internal documentation for the extension codebase and behavior.

| Document | Contents |
|----------|----------|
| [architecture.md](architecture.md) | Components, how they connect, end-to-end flows |
| [server.md](server.md) | Express live server, injection, WebSocket reload, proxy, SPA |
| [watcher.md](watcher.md) | chokidar file watcher → reload broadcast |
| [webviews.md](webviews.md) | Settings UI and Preview webview (iframe vs screencast, Inspector, Legacy DevTools) |
| [chromium-cdp.md](chromium-cdp.md) | Chromium launch, CDP bridge, screencast, input, Network+ capture and replay |

Source lives under `src/`. Build output is `out/` (`tsc`).
