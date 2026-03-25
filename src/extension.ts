import * as vscode from 'vscode';
import { LiveServer } from './server';
import { FileWatcher } from './watcher';
import { SettingsWebview } from './webview';
import { PreviewWebview } from './preview';
import * as path from 'path';

interface ServerInstance {
    server: LiveServer;
    watcher: FileWatcher;
    port: number;
    rootDir: string;
    folderName: string;
}

let activeServers = new Map<string, ServerInstance>();
let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
    console.log('Antigravity Live Server is now active!');

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'go-live.start';
    statusBarItem.text = '$(radio-tower) Go Live';
    
    // Create a rich tooltip with a link to settings
    const tooltip = new vscode.MarkdownString();
    tooltip.isTrusted = true;
    tooltip.supportThemeIcons = true;
    tooltip.appendMarkdown("$(radio-tower) [Go Live](command:go-live.start) - Start the server\n\n***\n\n");
    tooltip.appendMarkdown("$(browser) [Open Preview](command:go-live.openPreview) - Show side-by-side\n\n");
    tooltip.appendMarkdown("$(gear) [Settings](command:go-live.openSettings) - Configure options");
    
    statusBarItem.tooltip = tooltip;
    statusBarItem.show();
    function updateStatusBar() {
        const count = activeServers.size;
        if (count === 0) {
            statusBarItem.text = '$(radio-tower) Go Live';
            statusBarItem.command = 'go-live.start';
        } else if (count === 1) {
            const instance = Array.from(activeServers.values())[0];
            statusBarItem.text = `$(debug-stop) Port: ${instance.port}`;
            statusBarItem.command = 'go-live.stop';
        } else {
            statusBarItem.text = `$(debug-stop) ${count} Servers Running`;
            statusBarItem.command = 'go-live.stop';
        }
    }

    let startCommand = vscode.commands.registerCommand('go-live.start', async (uri: vscode.Uri) => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            vscode.window.showErrorMessage('No workspace folder open.');
            return;
        }

        let selectedFolder: vscode.WorkspaceFolder | undefined;

        if (uri) {
            selectedFolder = vscode.workspace.getWorkspaceFolder(uri);
        } else if (workspaceFolders.length === 1) {
            selectedFolder = workspaceFolders[0];
        } else {
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor) {
                selectedFolder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
            }
        }

        if (!selectedFolder) {
            const picks = workspaceFolders.map(f => ({ label: f.name, folder: f }));
            const selection = await vscode.window.showQuickPick(picks, { placeHolder: 'Select a folder to Go Live' });
            if (!selection) return;
            selectedFolder = selection.folder;
        }

        const folderPath = selectedFolder.uri.fsPath;
        if (activeServers.has(folderPath)) {
            vscode.window.showInformationMessage(`Live Server is already running for ${selectedFolder.name}`);
            return;
        }

        const config = vscode.workspace.getConfiguration('go-live', selectedFolder.uri);
        const port = config.get<number>('port') || 5500;
        const spa = config.get<boolean>('spa') || false;
        const ignorePatterns = config.get<string[]>('ignorePatterns') || ['node_modules', '.git'];
        const rootSetting = config.get<string>('root') || './';
        const proxy = config.get<string>('proxy') || '';
        const devCommand = config.get<string>('devCommand') || '';
        const openBrowser = config.get<boolean>('openBrowser') !== false;

        let rootDir = path.join(folderPath, rootSetting);

        // If a specific file was targeted but it's not the folder itself, we might still want to serve the folder
        // but for now, the folder resolution above is more robust for multi-root.

        // Run Dev Command if specified
        if (devCommand) {
            const terminal = vscode.window.createTerminal({
                name: `Go Live - ${selectedFolder.name}`,
                cwd: folderPath
            });
            terminal.sendText(devCommand);
            terminal.show();
        }

        const liveServer = new LiveServer(rootDir, port, spa, proxy);
        const watcher = new FileWatcher(rootDir, ignorePatterns, () => {
            liveServer.reload();
        });

        try {
            const actualPort = await liveServer.start();
            watcher.start();

            activeServers.set(folderPath, {
                server: liveServer,
                watcher: watcher,
                port: actualPort,
                rootDir: rootDir,
                folderName: selectedFolder.name
            });

            updateStatusBar();
            vscode.window.showInformationMessage(`Live Server started for ${selectedFolder.name} on port ${actualPort}`);

            if (openBrowser) {
                const url = `http://localhost:${actualPort}`;
                vscode.env.openExternal(vscode.Uri.parse(url));
            }
        } catch (error: unknown) {
            watcher.stop();
            await liveServer.stop();
            const msg = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to start Live Server for ${selectedFolder.name}: ${msg}`);
        }
    });

    let stopCommand = vscode.commands.registerCommand('go-live.stop', async (uri: vscode.Uri) => {
        if (activeServers.size === 0) return;

        let folderPathToStop: string | undefined;

        if (uri) {
            const folder = vscode.workspace.getWorkspaceFolder(uri);
            if (folder) folderPathToStop = folder.uri.fsPath;
        }

        if (!folderPathToStop) {
            if (activeServers.size === 1) {
                folderPathToStop = Array.from(activeServers.keys())[0];
            } else {
                const picks = Array.from(activeServers.values()).map(s => ({
                    label: `Stop ${s.folderName} (Port: ${s.port})`,
                    path: Array.from(activeServers.entries()).find(([k, v]) => v === s)![0]
                }));
                picks.push({ label: 'Stop All Servers', path: 'all' });

                const selection = await vscode.window.showQuickPick(picks, { placeHolder: 'Select a server to stop' });
                if (!selection) return;
                
                if (selection.path === 'all') {
                    for (const s of activeServers.values()) {
                        await s.server.stop();
                        s.watcher.stop();
                        PreviewWebview.notifyLiveServerStopped(s.port);
                    }
                    activeServers.clear();
                    updateStatusBar();
                    vscode.window.showInformationMessage('All Live Servers stopped.');
                    return;
                }
                folderPathToStop = selection.path;
            }
        }

        const instance = activeServers.get(folderPathToStop!);
        if (instance) {
            const stoppedPort = instance.port;
            await instance.server.stop();
            instance.watcher.stop();
            activeServers.delete(folderPathToStop!);
            PreviewWebview.notifyLiveServerStopped(stoppedPort);
            updateStatusBar();
            vscode.window.showInformationMessage(`Live Server stopped for ${instance.folderName}.`);
        }
    });

    let openSettingsCommand = vscode.commands.registerCommand('go-live.openSettings', () => {
        SettingsWebview.show(context.extensionUri);
    });

    let openPreviewCommand = vscode.commands.registerCommand('go-live.openPreview', async () => {
        let selectedServer = Array.from(activeServers.values())[0];
        
        if (activeServers.size > 1) {
            const picks = Array.from(activeServers.values()).map(s => ({
                label: `Preview ${s.folderName} (Port: ${s.port})`,
                instance: s
            }));
            const selection = await vscode.window.showQuickPick(picks, { placeHolder: 'Select a server to preview' });
            if (!selection) return;
            selectedServer = selection.instance;
        }

        if (!selectedServer) {
            vscode.window.showErrorMessage('No active server to preview. Please click "Go Live" first.');
            return;
        }

        PreviewWebview.show(
            context,
            context.extensionUri,
            `http://localhost:${selectedServer.port}`,
            selectedServer.folderName
        );
    });

    context.subscriptions.push(
        statusBarItem,
        startCommand,
        stopCommand,
        openSettingsCommand,
        openPreviewCommand
    );
}

export async function deactivate() {
    PreviewWebview.currentPanel?.dispose();
    for (const s of activeServers.values()) {
        await s.server.stop();
        s.watcher.stop();
    }
    activeServers.clear();
}
