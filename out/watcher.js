"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileWatcher = void 0;
const chokidar_1 = require("chokidar");
class FileWatcher {
    constructor(rootDir, ignorePatterns, onFileChange) {
        this.rootDir = rootDir;
        this.ignorePatterns = ignorePatterns;
        this.onFileChange = onFileChange;
    }
    start() {
        this.watcher = (0, chokidar_1.watch)(this.rootDir, {
            ignored: this.ignorePatterns.map(p => new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))),
            persistent: true,
            ignoreInitial: true,
        });
        this.watcher
            .on('add', (filePath) => this.handleChange(filePath))
            .on('change', (filePath) => this.handleChange(filePath))
            .on('unlink', (filePath) => this.handleChange(filePath));
    }
    handleChange(filePath) {
        // Reload for all files that were not ignored by the watcher
        this.onFileChange();
    }
    stop() {
        this.watcher?.close();
    }
}
exports.FileWatcher = FileWatcher;
//# sourceMappingURL=watcher.js.map