import * as vscode from 'vscode';

export class SettingsWebview {
    public static currentPanel: SettingsWebview | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    public static show(extensionUri: vscode.Uri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (SettingsWebview.currentPanel) {
            SettingsWebview.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'goLiveSettings',
            'Go Live Settings',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri]
            }
        );

        SettingsWebview.currentPanel = new SettingsWebview(panel, extensionUri);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);

        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'save':
                        await this._saveSettings(message.settings);
                        vscode.window.showInformationMessage('Settings saved successfully!');
                        return;
                }
            },
            null,
            this._disposables
        );
    }

    private async _saveSettings(settings: any) {
        const config = vscode.workspace.getConfiguration('go-live');
        await config.update('port', parseInt(settings.port), vscode.ConfigurationTarget.Global);
        await config.update('root', settings.root, vscode.ConfigurationTarget.Global);
        await config.update('spa', settings.spa === 'true', vscode.ConfigurationTarget.Global);
        await config.update('proxy', settings.proxy, vscode.ConfigurationTarget.Global);
        await config.update('devCommand', settings.devCommand, vscode.ConfigurationTarget.Global);
        await config.update('openBrowser', settings.openBrowser === 'true', vscode.ConfigurationTarget.Global);
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const config = vscode.workspace.getConfiguration('go-live');
        const settings = {
            port: config.get('port'),
            root: config.get('root'),
            spa: config.get('spa'),
            proxy: config.get('proxy'),
            devCommand: config.get('devCommand'),
            openBrowser: config.get('openBrowser')
        };

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Go Live Settings</title>
    <style>
        :root {
            --primary: #3b82f6;
            --bg: #0f172a;
            --card-bg: #1e293b;
            --text-main: #f8fafc;
            --text-dim: #94a3b8;
        }
        body {
            font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
            background-color: var(--bg);
            color: var(--text-main);
            padding: 2rem;
            display: flex;
            justify-content: center;
        }
        .container {
            width: 100%;
            max-width: 600px;
            background: var(--card-bg);
            padding: 2.5rem;
            border-radius: 12px;
            box-shadow: 0 10px 25px -5px rgba(0,0,0,0.3);
            border: 1px solid rgba(255,255,255,0.05);
        }
        h1 {
            margin-top: 0;
            margin-bottom: 2rem;
            font-size: 1.5rem;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 0.75rem;
        }
        .form-group {
            margin-bottom: 1.5rem;
        }
        label {
            display: block;
            margin-bottom: 0.5rem;
            font-size: 0.875rem;
            color: var(--text-dim);
        }
        input, select {
            width: 100%;
            padding: 0.75rem;
            background: #0f172a;
            border: 1px solid #334155;
            color: white;
            border-radius: 6px;
            font-size: 0.9rem;
            transition: border-color 0.2s;
        }
        input:focus {
            outline: none;
            border-color: var(--primary);
        }
        .hint {
            font-size: 0.75rem;
            color: #64748b;
            margin-top: 0.4rem;
        }
        button {
            margin-top: 1rem;
            width: 100%;
            padding: 0.8rem;
            background: var(--primary);
            color: white;
            border: none;
            border-radius: 6px;
            font-weight: 600;
            cursor: pointer;
            transition: filter 0.2s;
        }
        button:hover {
            filter: brightness(1.1);
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Go Live Configuration</h1>
        
        <div class="form-group">
            <label>Port</label>
            <input type="number" id="port" value="${settings.port}">
            <div class="hint">The port to run the server on (default: 5500).</div>
        </div>

        <div class="form-group">
            <label>Root Directory</label>
            <input type="text" id="root" value="${settings.root}">
            <div class="hint">Path relative to workspace (e.g., ./dist).</div>
        </div>

        <div class="form-group">
            <label>Dev Command</label>
            <input type="text" id="devCommand" value="${settings.devCommand || ''}" placeholder="e.g. npm start">
            <div class="hint">Optional terminal command to run when going live.</div>
        </div>

        <div class="form-group">
            <label>SPA Mode</label>
            <select id="spa">
                <option value="true" ${settings.spa === true ? 'selected' : ''}>Enabled (Fallback to index.html)</option>
                <option value="false" ${settings.spa === false ? 'selected' : ''}>Disabled</option>
            </select>
            <div class="hint">Good for React/Angular/Vue apps with client-side routing.</div>
        </div>

        <div class="form-group">
            <label>Proxy URL</label>
            <input type="text" id="proxy" value="${settings.proxy || ''}" placeholder="e.g. http://localhost:8080">
            <div class="hint">Fallback target for API requests.</div>
        </div>

        <div class="form-group">
            <label>Auto Open Browser</label>
            <select id="openBrowser">
                <option value="true" ${settings.openBrowser === true ? 'selected' : ''}>Yes</option>
                <option value="false" ${settings.openBrowser === false ? 'selected' : ''}>No</option>
            </select>
        </div>

        <button onclick="save()">Save Settings</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        function save() {
            const settings = {
                port: document.getElementById('port').value,
                root: document.getElementById('root').value,
                devCommand: document.getElementById('devCommand').value,
                spa: document.getElementById('spa').value,
                proxy: document.getElementById('proxy').value,
                openBrowser: document.getElementById('openBrowser').value
            };
            vscode.postMessage({
                command: 'save',
                settings: settings
            });
        }
    </script>
</body>
</html>`;
    }

    public dispose() {
        SettingsWebview.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}
