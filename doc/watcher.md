# File watcher (`watcher.ts`)

The **`FileWatcher`** class watches the live server **root directory** with **chokidar** and invokes a callback when relevant files change. That callback is wired to **`LiveServer.reload()`**, which notifies all WebSocket clients to reload.

## Construction

- **`rootDir`**: Absolute path to watch (same as server root).
- **`ignorePatterns`**: String fragments (e.g. `node_modules`, `.git`); each is escaped and turned into a **RegExp** for chokidar’s `ignored` option, so any path **containing** that substring is ignored.
- **`onChange`**: Zero-argument function called on any watched change event.

## Methods

- **`start()`**: Creates the chokidar watcher with `ignoreInitial: true` and `persistent: true`, and listens for **`add`**, **`change`**, and **`unlink`**.
- **`stop()`**: Closes the watcher and clears the reference.

## Configuration

Controlled by **`go-live.ignorePatterns`** per workspace (default includes `node_modules` and `.git`).

See [architecture.md](architecture.md) for placement in the Go Live → reload pipeline.
