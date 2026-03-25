import { FSWatcher, watch } from 'chokidar';
import * as path from 'path';

export class FileWatcher {
    private watcher?: FSWatcher;
    private rootDir: string;
    private onFileChange: () => void;
    private ignorePatterns: string[];

    constructor(rootDir: string, ignorePatterns: string[], onFileChange: () => void) {
        this.rootDir = rootDir;
        this.ignorePatterns = ignorePatterns;
        this.onFileChange = onFileChange;
    }

    public start() {
        this.watcher = watch(this.rootDir, {
            ignored: this.ignorePatterns.map(p => new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))),
            persistent: true,
            ignoreInitial: true,
        });

        this.watcher
            .on('add', (filePath: string) => this.handleChange(filePath))
            .on('change', (filePath: string) => this.handleChange(filePath))
            .on('unlink', (filePath: string) => this.handleChange(filePath));
    }

    private handleChange(filePath: string) {
        // Reload for all files that were not ignored by the watcher
        this.onFileChange();
    }

    public stop() {
        this.watcher?.close();
    }
}
