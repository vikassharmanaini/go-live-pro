import { FSWatcher, watch } from 'chokidar';
import * as path from 'path';

export class FileWatcher {
    private watcher?: FSWatcher;
    private rootDir: string;
    private onFileChange: () => void;

    constructor(rootDir: string, onFileChange: () => void) {
        this.rootDir = rootDir;
        this.onFileChange = onFileChange;
    }

    public start() {
        this.watcher = watch(this.rootDir, {
            ignored: /node_modules|\.git/,
            persistent: true,
            ignoreInitial: true,
        });

        this.watcher
            .on('add', (filePath: string) => this.handleChange(filePath))
            .on('change', (filePath: string) => this.handleChange(filePath))
            .on('unlink', (filePath: string) => this.handleChange(filePath));
    }

    private handleChange(filePath: string) {
        const ext = path.extname(filePath);
        if (['.html', '.css', '.js', '.json'].includes(ext)) {
            this.onFileChange();
        }
    }

    public stop() {
        this.watcher?.close();
    }
}
