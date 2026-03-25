"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileWatcher = void 0;
const chokidar_1 = require("chokidar");
const path = __importStar(require("path"));
class FileWatcher {
    constructor(rootDir, onFileChange) {
        this.rootDir = rootDir;
        this.onFileChange = onFileChange;
    }
    start() {
        this.watcher = (0, chokidar_1.watch)(this.rootDir, {
            ignored: /node_modules|\.git/,
            persistent: true,
            ignoreInitial: true,
        });
        this.watcher
            .on('add', (filePath) => this.handleChange(filePath))
            .on('change', (filePath) => this.handleChange(filePath))
            .on('unlink', (filePath) => this.handleChange(filePath));
    }
    handleChange(filePath) {
        const ext = path.extname(filePath);
        if (['.html', '.css', '.js', '.json'].includes(ext)) {
            this.onFileChange();
        }
    }
    stop() {
        this.watcher?.close();
    }
}
exports.FileWatcher = FileWatcher;
//# sourceMappingURL=watcher.js.map