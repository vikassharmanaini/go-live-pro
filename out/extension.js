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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const server_1 = require("./server");
const watcher_1 = require("./watcher");
const path = __importStar(require("path"));
let liveServer;
let watcher;
let statusBarItem;
function activate(context) {
    console.log('Antigravity Live Server is now active!');
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'go-live.start';
    statusBarItem.text = '$(broadcast) Go Live';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    let startCommand = vscode.commands.registerCommand('go-live.start', async (uri) => {
        if (liveServer) {
            vscode.window.showInformationMessage('Live Server is already running.');
            return;
        }
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            vscode.window.showErrorMessage('No workspace folder open.');
            return;
        }
        let rootDir = workspaceFolders[0].uri.fsPath;
        if (uri && uri.fsPath) {
            const stats = require('fs').statSync(uri.fsPath);
            if (stats.isDirectory()) {
                rootDir = uri.fsPath;
            }
            else {
                rootDir = path.dirname(uri.fsPath);
            }
        }
        liveServer = new server_1.LiveServer(rootDir);
        watcher = new watcher_1.FileWatcher(rootDir, () => {
            liveServer?.reload();
        });
        try {
            const port = await liveServer.start();
            watcher.start();
            statusBarItem.text = `$(circle-slash) Port: ${port}`;
            statusBarItem.command = 'go-live.stop';
            vscode.window.showInformationMessage(`Live Server started on port ${port}`);
            // Open browser
            const url = `http://localhost:${port}`;
            vscode.env.openExternal(vscode.Uri.parse(url));
        }
        catch (error) {
            vscode.window.showErrorMessage(`Failed to start Live Server: ${error.message}`);
        }
    });
    let stopCommand = vscode.commands.registerCommand('go-live.stop', () => {
        if (liveServer) {
            liveServer.stop();
            watcher?.stop();
            liveServer = undefined;
            watcher = undefined;
            statusBarItem.text = '$(broadcast) Go Live';
            statusBarItem.command = 'go-live.start';
            vscode.window.showInformationMessage('Live Server stopped.');
        }
    });
    context.subscriptions.push(startCommand, stopCommand);
}
function deactivate() {
    liveServer?.stop();
    watcher?.stop();
}
//# sourceMappingURL=extension.js.map