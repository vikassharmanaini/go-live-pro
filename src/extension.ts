import * as vscode from 'vscode';
import { LiveServer } from './server';
import { FileWatcher } from './watcher';
import * as path from 'path';

let liveServer: LiveServer | undefined;
let watcher: FileWatcher | undefined;
let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
    console.log('Antigravity Live Server is now active!');

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'go-live.start';
    statusBarItem.text = '$(broadcast) Go Live';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    let startCommand = vscode.commands.registerCommand('go-live.start', async (uri: vscode.Uri) => {
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
            } else {
                rootDir = path.dirname(uri.fsPath);
            }
        }

        liveServer = new LiveServer(rootDir);
        watcher = new FileWatcher(rootDir, () => {
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

        } catch (error: any) {
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

export function deactivate() {
    liveServer?.stop();
    watcher?.stop();
}
