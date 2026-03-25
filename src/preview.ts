import * as path from 'path';
import * as vscode from 'vscode';
import { CdpPreviewBridge, isCdpWebviewMessage } from './cdpPreviewBridge';
import { startChromiumDebuggingSession } from './chromiumDevToolsSession';

export class PreviewWebview {
    public static currentPanel: PreviewWebview | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _context: vscode.ExtensionContext;
    private _disposables: vscode.Disposable[] = [];
    private _liveUrl: string;
    private _chromeDispose?: () => void;
    private _cdpBridge?: CdpPreviewBridge;
    private _disposed = false;
    /** Bumps on each Chrome/CDP restart so in-flight async work cannot commit stale sessions. */
    private _chromeSessionGeneration = 0;

    /** URL currently shown in the preview (same tab the user expects to match Live Server). */
    public get livePageUrl(): string {
        return this._liveUrl;
    }

    static isPreviewingPort(port: number): boolean {
        const panel = PreviewWebview.currentPanel;
        if (!panel) {
            return false;
        }
        try {
            const u = new URL(panel.livePageUrl);
            const n = u.port ? parseInt(u.port, 10) : u.protocol === 'https:' ? 443 : 80;
            return n === port;
        } catch {
            return panel.livePageUrl.includes(`:${port}`);
        }
    }

    /** If the webview is open for this port, tear down Chrome/CDP and tell the user the server stopped. */
    static notifyLiveServerStopped(port: number): void {
        if (!PreviewWebview.isPreviewingPort(port)) {
            return;
        }
        PreviewWebview.currentPanel?.onLiveServerStopped();
    }

    private onLiveServerStopped(): void {
        this.killChromeSession();
        this._panel.webview.postMessage({
            command: 'liveServerStopped',
            message: 'The Live Server for this preview was stopped. Start Go Live again to reconnect.',
        });
    }

    public static show(context: vscode.ExtensionContext, extensionUri: vscode.Uri, url: string, title: string) {
        if (PreviewWebview.currentPanel) {
            PreviewWebview.currentPanel._panel.reveal(vscode.ViewColumn.Beside);
            PreviewWebview.currentPanel._updateUrl(url);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'goLivePreview',
            `Live: ${title}`,
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri],
            }
        );

        PreviewWebview.currentPanel = new PreviewWebview(context, panel, url);
    }

    private constructor(context: vscode.ExtensionContext, panel: vscode.WebviewPanel, url: string) {
        this._context = context;
        this._panel = panel;
        this._liveUrl = url;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        const cspSource = this._panel.webview.cspSource;
        const useIframePreview =
            vscode.workspace.getConfiguration('go-live').get<boolean>('useIframePreview') === true;
        this._panel.webview.html = this._getHtmlForWebview(url, cspSource, useIframePreview);
        this._disposables.push(
            this._panel.webview.onDidReceiveMessage((msg: unknown) => {
                if (
                    msg &&
                    typeof msg === 'object' &&
                    (msg as { command?: string }).command === 'cdpNetworkReplay'
                ) {
                    const m = msg as { command: 'cdpNetworkReplay'; id: number };
                    void (async () => {
                        const bridge = this._cdpBridge;
                        if (!bridge || this._disposed) {
                            this._panel.webview.postMessage({
                                command: 'cdpNetworkReplayResult',
                                id: m.id,
                                ok: false,
                                error: 'No Chromium preview session.',
                            });
                            return;
                        }
                        const result = await bridge.replayNetworkRequest(m.id);
                        this._panel.webview.postMessage({
                            command: 'cdpNetworkReplayResult',
                            id: m.id,
                            ...result,
                        });
                    })();
                    return;
                }
                if (isCdpWebviewMessage(msg)) {
                    this._cdpBridge?.handleWebviewMessage(msg);
                    if (msg.command === 'cdpNetworkClear') {
                        this._panel.webview.postMessage({ command: 'cdpNetworkCleared' });
                    }
                }
            }),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('go-live.useIframePreview')) {
                    void this._restartChromeSession();
                }
            })
        );
        void this._startChromeSession(url);
    }

    private _updateUrl(url: string) {
        this._liveUrl = url;
        this._panel.webview.postMessage({ command: 'updateUrl', url: url });
        void this._restartChromeSession();
    }

    private async _restartChromeSession() {
        this._chromeDispose?.();
        this._chromeDispose = undefined;
        this._cdpBridge?.dispose();
        this._cdpBridge = undefined;
        await this._startChromeSession(this._liveUrl);
    }

    private async _startChromeSession(pageUrl: string) {
        const generation = ++this._chromeSessionGeneration;
        this._chromeDispose?.();
        this._chromeDispose = undefined;
        this._cdpBridge?.dispose();
        this._cdpBridge = undefined;
        const config = vscode.workspace.getConfiguration('go-live');
        const useIframePreview = config.get<boolean>('useIframePreview') === true;
        this._panel.webview.postMessage({
            command: 'chromeInspectorLoading',
            screencastTarget: !useIframePreview,
        });
        try {
            const chromePath = config.get<string>('chromeExecutable') || undefined;
            const debugPortPref = config.get<number>('devtoolsDebugPort') || 0;
            const headless = config.get<boolean>('chromeHeadless') === true;
            const offScreenWindow = config.get<boolean>('chromeOffScreenWindow') !== false;
            const userDataDir = path.join(this._context.globalStorageUri.fsPath, 'go-live-chrome-profile');
            const session = await startChromiumDebuggingSession(pageUrl, {
                chromeExecutable: chromePath,
                preferredDebugPort: debugPortPref > 0 ? debugPortPref : undefined,
                userDataDir,
                headless,
                offScreenWindow: offScreenWindow && !headless,
            });
            if (generation !== this._chromeSessionGeneration || this._disposed) {
                session.dispose();
                return;
            }
            this._chromeDispose = () => {
                this._cdpBridge?.dispose();
                this._cdpBridge = undefined;
                session.dispose();
            };
            this._panel.webview.postMessage({
                command: 'setChromeInspector',
                url: session.inspectorHttpUrl,
            });
            if (useIframePreview) {
                this._panel.webview.postMessage({ command: 'setPreviewMode', mode: 'iframe' });
            } else {
                try {
                    const bridge = await CdpPreviewBridge.connect(
                        session.webSocketDebuggerUrl,
                        (frame) => {
                            if (this._disposed || generation !== this._chromeSessionGeneration) {
                                return;
                            }
                            this._panel.webview.postMessage({
                                command: 'screencastFrame',
                                data: frame.data,
                                sessionId: frame.sessionId,
                                metadata: frame.metadata,
                            });
                        },
                        {
                            onNetworkEntry: (entry) => {
                                if (this._disposed || generation !== this._chromeSessionGeneration) {
                                    return;
                                }
                                this._panel.webview.postMessage({ command: 'cdpNetworkEntry', entry });
                            },
                        }
                    );
                    if (generation !== this._chromeSessionGeneration || this._disposed) {
                        bridge.dispose();
                        this._chromeDispose?.();
                        this._chromeDispose = undefined;
                        return;
                    }
                    this._cdpBridge = bridge;
                    this._panel.webview.postMessage({ command: 'cdpNetworkCleared' });
                    this._panel.webview.postMessage({ command: 'setPreviewMode', mode: 'screencast' });
                } catch (bridgeErr: unknown) {
                    if (generation !== this._chromeSessionGeneration || this._disposed) {
                        this._chromeDispose?.();
                        this._chromeDispose = undefined;
                        return;
                    }
                    const brMsg = bridgeErr instanceof Error ? bridgeErr.message : String(bridgeErr);
                    this._panel.webview.postMessage({ command: 'setPreviewMode', mode: 'iframe' });
                    this._panel.webview.postMessage({
                        command: 'screencastBridgeError',
                        message: brMsg,
                    });
                }
            }
        } catch (e: unknown) {
            if (generation !== this._chromeSessionGeneration || this._disposed) {
                return;
            }
            const message = e instanceof Error ? e.message : String(e);
            this._panel.webview.postMessage({ command: 'chromeInspectorError', message });
        }
    }

    private _getHtmlForWebview(url: string, cspSource: string, useIframePreview: boolean) {
        const safeUrl = url.replace(/"/g, '&quot;');
        const bodyPreviewClass = useIframePreview ? 'preview-iframe' : 'preview-screencast';
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' ${cspSource}; img-src data: blob: http: https:; font-src data:; frame-src http: https:; connect-src ${cspSource} http: https: ws: wss:;">
    <title>Live Preview Pro</title>
    <style>
        body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #000; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; display: flex; flex-direction: column; color: #ccc; }
        
        .toolbar { height: 40px; background: #1a1a1a; display: flex; align-items: center; padding: 0 12px; gap: 12px; border-bottom: 1px solid #333; box-shadow: 0 4px 10px rgba(0,0,0,0.3); z-index: 100; flex-shrink: 0; }
        .toolbar input { flex: 1; background: #000; border: 1px solid #333; color: #888; padding: 5px 10px; border-radius: 6px; font-size: 11px; outline: none; transition: border-color 0.2s; }
        .toolbar input:focus { border-color: #0078d7; color: #fff; }
        
        .toolbar-group { display: flex; align-items: center; gap: 6px; border-right: 1px solid #333; padding-right: 12px; }
        .toolbar-group:last-child { border-right: none; padding-right: 0; }
        
        .btn { background: #2a2a2a; border: none; color: #aaa; cursor: pointer; padding: 5px 8px; border-radius: 4px; font-size: 11px; display: flex; align-items: center; gap: 4px; transition: all 0.2s; white-space: nowrap; }
        .btn:hover { background: #3a3a3a; color: #fff; }
        .btn.active { background: #0078d7; color: #fff; }
        .btn:disabled { opacity: 0.35; cursor: not-allowed; }
        
        select { background: #2a2a2a; color: #aaa; border: none; font-size: 11px; padding: 4px; border-radius: 4px; outline: none; }

        .main-content { flex: 1; display: flex; flex-direction: column; position: relative; background: #111; align-items: center; overflow: hidden; min-height: 0; }
        
        #preview-container { transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); background: #fff; box-shadow: 0 0 30px rgba(0,0,0,0.5); position: relative; overflow: hidden; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
        iframe { width: 100%; height: 100%; border: none; }
        #screencastCanvas { display: none; max-width: 100%; max-height: 100%; background: #1a1a1a; outline: none; touch-action: none; }
        body.preview-screencast #previewFrame { display: none !important; }
        body.preview-screencast #screencastCanvas { display: block; }
        .preview-stage { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; width: 100%; position: relative; }
        #screencast-placeholder { display: none; position: absolute; inset: 0; align-items: center; justify-content: center; text-align: center; padding: 16px; font-size: 12px; color: #888; background: #1a1a1a; z-index: 2; pointer-events: none; }
        body.preview-screencast #screencast-placeholder.show { display: flex; }
        
        .devtools-container { height: clamp(320px, 42vh, 720px); background: #000; display: flex; flex-direction: column; border-top: 1px solid #333; transition: height 0.2s; position: relative; flex-shrink: 0; min-height: 0; }
        .devtools-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-shrink: 0; padding: 0 10px; height: 32px; background: #0d0d0d; border-bottom: 1px solid #222; }
        .devtools-title { font-size: 12px; font-weight: 600; color: #e0e0e0; letter-spacing: 0.02em; }
        .devtools-title .devtools-sub { font-weight: 400; color: #666; font-size: 10px; margin-left: 8px; }
        .btn-legacy { background: transparent; border: 1px solid #333; color: #777; cursor: pointer; padding: 4px 10px; border-radius: 4px; font-size: 10px; white-space: nowrap; transition: color 0.15s, border-color 0.15s, background 0.15s; }
        .btn-legacy:hover { color: #ccc; border-color: #555; background: #1a1a1a; }
        .btn-back-inspector { background: #1e3a5f; border: 1px solid #2a5080; color: #9ecbff; cursor: pointer; padding: 4px 10px; border-radius: 4px; font-size: 10px; }
        .btn-back-inspector:hover { background: #254a75; color: #fff; }
        .devtools-main { flex: 1; min-height: 0; display: none; flex-direction: column; }
        .devtools-container:not(.legacy-view) .devtools-main#view-inspector { display: flex; }
        .devtools-container.legacy-view .devtools-main#view-legacy { display: flex; }
        .devtools-tabs { display: flex; background: #111; border-bottom: 1px solid #222; height: 30px; flex-shrink: 0; overflow-x: auto; }
        .tab { padding: 0 15px; display: flex; align-items: center; cursor: pointer; font-size: 11px; color: #777; border-bottom: 2px solid transparent; white-space: nowrap; }
        .tab:hover { color: #aaa; }
        .tab.active { color: #fff; border-bottom-color: #0078d7; background: #1a1a1a; }
        
        .tab-content { flex: 1; overflow: hidden; font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; font-size: 11px; display: none; padding: 0; min-height: 0; }
        .tab-content.active { display: flex; flex-direction: column; }
        
        .tab-scroll { flex: 1; overflow-y: auto; padding: 5px 0; min-height: 0; }
        
        .log-entry { padding: 3px 12px; border-bottom: 1px solid #111; display: flex; gap: 8px; }
        .log-entry:hover { background: #111; }
        .log-entry .time { color: #555; width: 70px; flex-shrink: 0; }
        .log-entry .method { border-radius: 2px; padding: 0 4px; font-size: 9px; text-transform: uppercase; font-weight: bold; }
        .log-entry.log .method { color: #0f0; background: rgba(0,255,0,0.1); }
        .log-entry.error .method { color: #f44; background: rgba(255,0,0,0.1); }
        .log-entry.warn .method { color: #fa0; background: rgba(255,160,0,0.1); }
        .log-entry .args { color: #ccc; white-space: pre-wrap; word-break: break-all; }

        .element-info { padding: 10px 15px; }
        .element-tag { color: #e06c75; font-weight: bold; font-size: 13px; }
        .element-attr { color: #d19a66; }
        .element-val { color: #98c379; }
        .element-html { background: #111; color: #61afef; padding: 10px; border-radius: 6px; margin-top: 10px; border: 1px solid #222; }

        .storage-grid { display: grid; grid-template-columns: 1fr 2fr; gap: 1px; background: #222; border: 1px solid #222; }
        .storage-item { background: #000; padding: 5px 10px; color: #888; overflow: hidden; text-overflow: ellipsis; }
        .storage-item.key { color: #61afef; border-right: 1px solid #222; }

        #resize-handle { height: 3px; background: #333; cursor: ns-resize; transition: background 0.2s; flex-shrink: 0; }
        #resize-handle:hover { background: #0078d7; }

        #chrome-devtools-frame { flex: 1; width: 100%; min-height: 0; border: none; background: #fff; }
        .chrome-hint { padding: 12px 16px; color: #888; font-size: 12px; line-height: 1.5; }
        .chrome-hint.error { color: #f88; }
        .legacy-banner { padding: 6px 12px; font-size: 10px; color: #888; background: #151515; border-bottom: 1px solid #222; }
        #screencast-banner { display: none; width: 100%; padding: 6px 10px; font-size: 11px; background: #3d2914; color: #ecb; border-bottom: 1px solid #5a3d1a; flex-shrink: 0; }
        #screencast-banner.show { display: block; }
        #server-stopped-banner { display: none; width: 100%; padding: 8px 12px; font-size: 12px; background: #4a1515; color: #fcc; border-bottom: 1px solid #722; flex-shrink: 0; }
        #server-stopped-banner.show { display: block; }
    </style>
</head>
<body class="${bodyPreviewClass}">
    <div class="toolbar">
        <div class="toolbar-group">
            <button class="btn" onclick="reload()" title="Reload Preview">
                <span>🔄</span>
            </button>
            <button class="btn" id="inspectBtn" onclick="toggleInspect()" title="Select element (legacy iframe preview only)">
                <span>🔍</span>
            </button>
        </div>
        
        <div class="toolbar-group">
            <select id="deviceSelect" onchange="changeDevice()">
                <option value="responsive">Responsive</option>
                <option value="mobile">iPhone 14 (390x844)</option>
                <option value="tablet">iPad Air (820x1180)</option>
                <option value="desktop">Desktop (1440x900)</option>
            </select>
        </div>

        <input type="text" id="urlInput" value="${safeUrl}" readonly>

        <div class="toolbar-group">
            <button class="btn" onclick="toggleConsole()" id="toggleConsoleBtn" title="Show or hide the Inspector panel">Inspector</button>
        </div>
    </div>

    <div class="main-content">
        <div id="preview-container" style="flex-direction:column">
            <div id="server-stopped-banner" role="alert"></div>
            <div id="screencast-banner" role="status"></div>
            <div class="preview-stage">
            <iframe id="previewFrame" src="${safeUrl}"></iframe>
            <div id="screencast-placeholder" class="show" role="status">Connecting to Chromium preview…</div>
            <canvas id="screencastCanvas" tabindex="0" title="Chromium preview (screencast)"></canvas>
            </div>
        </div>
    </div>

    <div class="devtools-container" id="devtools">
        <div id="resize-handle"></div>
        <div class="devtools-toolbar" id="devtools-toolbar-inspector">
            <div class="devtools-title">Inspector<span class="devtools-sub">Chromium DevTools</span></div>
            <button type="button" class="btn-legacy" id="networkCaptureToggleBtn" style="display:none" onclick="toggleNetworkCapturePanel()" title="XHR/Fetch captured via CDP — replay in the Chromium page with fetch()">Network+</button>
            <button type="button" class="btn-legacy" id="openLegacyBtn" onclick="setDevtoolsView('legacy')" title="Panels for the embedded webview iframe only — not the Chromium preview tab">Legacy (webview only)</button>
        </div>
        <div id="network-capture-bar" style="display:none; flex-shrink:0; border-bottom:1px solid #222; background:#0a0a0a;">
            <div style="display:flex; align-items:center; justify-content:space-between; padding:6px 10px; gap:8px; border-bottom:1px solid #1a1a1a;">
                <span style="font-size:11px;color:#888;">Captured XHR / Fetch (extension CDP)</span>
                <button type="button" class="btn-legacy" onclick="clearNetworkCapture()">Clear list</button>
            </div>
            <div id="network-capture-list" style="max-height:160px; overflow-y:auto; font-family:'SFMono-Regular',Consolas,monospace; font-size:10px;"></div>
            <div id="network-replay-output" style="display:none; max-height:80px; overflow:auto; padding:8px 10px; font-size:10px; color:#9ecbff; border-top:1px solid #222; white-space:pre-wrap; word-break:break-all;"></div>
        </div>
        <div class="devtools-toolbar" id="devtools-toolbar-legacy" style="display:none">
            <button type="button" class="btn-back-inspector" onclick="setDevtoolsView('inspector')" title="Return to Chromium DevTools">← Inspector</button>
            <div class="devtools-title" style="margin-left:auto">Legacy<span class="devtools-sub">served page iframe</span></div>
        </div>
        <div id="view-inspector" class="devtools-main">
            <div id="chrome-status" class="chrome-hint">Starting Chrome and attaching DevTools…</div>
            <iframe id="chrome-devtools-frame" title="Chromium DevTools" style="display:none"></iframe>
        </div>
        <div id="view-legacy" class="devtools-main">
            <div class="legacy-banner">These panels mirror the VS Code webview iframe only, not the Chromium preview tab. Use Inspector for Console, Elements, Application, and Network on the real page.</div>
            <div class="devtools-tabs" style="height:28px">
                <div class="tab active" data-legacy="console" onclick="switchLegacyTab('console')">Console</div>
                <div class="tab" data-legacy="elements" onclick="switchLegacyTab('elements')">Elements</div>
                <div class="tab" data-legacy="storage" onclick="switchLegacyTab('storage')">Storage</div>
            </div>
            <div id="legacy-console" class="tab-content active" style="display:flex;flex:1;min-height:0">
                <div class="tab-scroll" id="tab-console-inner"></div>
            </div>
            <div id="legacy-elements" class="tab-content" style="display:none;flex:1;min-height:0">
                <div class="tab-scroll">
                    <div class="element-info">Select an element using the 🔍 tool to view details (iframe preview only).</div>
                </div>
            </div>
            <div id="legacy-storage" class="tab-content" style="display:none;flex:1;min-height:0">
                <div class="tab-scroll">
                    <div class="storage-grid" id="storage-grid"></div>
                </div>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const frame = document.getElementById('previewFrame');
        const scCanvas = document.getElementById('screencastCanvas');
        const scCtx = scCanvas.getContext('2d');
        const devtools = document.getElementById('devtools');
        const inspectBtn = document.getElementById('inspectBtn');
        const scPlaceholder = document.getElementById('screencast-placeholder');
        let inspecting = false;
        let previewMode = ${useIframePreview ? "'iframe'" : "'screencast'"};
        if (previewMode === 'screencast') {
            inspectBtn.disabled = true;
        } else {
            scPlaceholder.classList.remove('show');
        }

        function mapPointerToCanvas(clientX, clientY) {
            const rect = scCanvas.getBoundingClientRect();
            const w = scCanvas.width || 1;
            const h = scCanvas.height || 1;
            const x = (clientX - rect.left) * (w / rect.width);
            const y = (clientY - rect.top) * (h / rect.height);
            return { x: Math.max(0, Math.min(w, x)), y: Math.max(0, Math.min(h, y)) };
        }

        function cdpButtonFromPointer(button) {
            if (button === 0) return 'left';
            if (button === 1) return 'middle';
            if (button === 2) return 'right';
            return 'none';
        }

        let networkCapturePanelOpen = false;
        function setPreviewMode(mode) {
            previewMode = mode;
            document.body.classList.toggle('preview-screencast', mode === 'screencast');
            document.body.classList.toggle('preview-iframe', mode === 'iframe');
            inspectBtn.disabled = mode === 'screencast';
            const legBtn = document.getElementById('openLegacyBtn');
            if (legBtn) {
                legBtn.style.display = mode === 'screencast' ? 'none' : '';
            }
            const netTgl = document.getElementById('networkCaptureToggleBtn');
            if (netTgl) {
                netTgl.style.display = mode === 'screencast' ? '' : 'none';
            }
            const netBar = document.getElementById('network-capture-bar');
            if (mode !== 'screencast') {
                networkCapturePanelOpen = false;
                if (netBar) netBar.style.display = 'none';
            } else if (netBar && networkCapturePanelOpen) {
                netBar.style.display = 'block';
            }
            if (mode === 'screencast') {
                setDevtoolsView('inspector');
                const ban = document.getElementById('screencast-banner');
                ban.classList.remove('show');
                ban.textContent = '';
            } else {
                scPlaceholder.classList.remove('show');
            }
        }

        function toggleNetworkCapturePanel() {
            networkCapturePanelOpen = !networkCapturePanelOpen;
            const bar = document.getElementById('network-capture-bar');
            if (bar) {
                bar.style.display = networkCapturePanelOpen && previewMode === 'screencast' ? 'block' : 'none';
            }
        }

        function clearNetworkCapture() {
            vscode.postMessage({ command: 'cdpNetworkClear' });
        }

        function appendNetworkEntryRow(entry) {
            const list = document.getElementById('network-capture-list');
            if (!list) return;
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 10px;border-bottom:1px solid #151515;';
            const methodSpan = document.createElement('span');
            methodSpan.style.cssText = 'color:#d19a66;flex-shrink:0;width:44px;';
            methodSpan.textContent = entry.method || '';
            const urlSpan = document.createElement('span');
            urlSpan.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;color:#888;';
            urlSpan.textContent = entry.url || '';
            urlSpan.title = entry.url || '';
            const replayBtn = document.createElement('button');
            replayBtn.type = 'button';
            replayBtn.className = 'btn-legacy';
            replayBtn.textContent = 'Replay';
            replayBtn.onclick = () => {
                const out = document.getElementById('network-replay-output');
                if (out) {
                    out.style.display = 'block';
                    out.textContent = 'Replaying…';
                }
                vscode.postMessage({ command: 'cdpNetworkReplay', id: entry.id });
            };
            row.appendChild(methodSpan);
            row.appendChild(urlSpan);
            row.appendChild(replayBtn);
            list.insertBefore(row, list.firstChild);
        }

        function setScreencastConnecting(text) {
            scPlaceholder.textContent = text || 'Connecting to Chromium preview…';
            if (previewMode === 'screencast') {
                scPlaceholder.classList.add('show');
            }
        }

        function ptrMods(e) {
            return (e.shiftKey ? 8 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 1 : 0) | (e.metaKey ? 4 : 0);
        }

        scCanvas.addEventListener('pointerdown', (e) => {
            if (previewMode !== 'screencast') return;
            e.preventDefault();
            scCanvas.focus();
            scCanvas.setPointerCapture(e.pointerId);
            const { x, y } = mapPointerToCanvas(e.clientX, e.clientY);
            vscode.postMessage({
                command: 'cdpMouse',
                type: 'mousePressed',
                x, y,
                button: cdpButtonFromPointer(e.button),
                clickCount: e.detail || 1,
                buttons: e.buttons,
                modifiers: ptrMods(e)
            });
        });
        scCanvas.addEventListener('pointerup', (e) => {
            if (previewMode !== 'screencast') return;
            e.preventDefault();
            try { scCanvas.releasePointerCapture(e.pointerId); } catch (err) {}
            const { x, y } = mapPointerToCanvas(e.clientX, e.clientY);
            vscode.postMessage({
                command: 'cdpMouse',
                type: 'mouseReleased',
                x, y,
                button: cdpButtonFromPointer(e.button),
                clickCount: 1,
                buttons: e.buttons,
                modifiers: ptrMods(e)
            });
        });
        scCanvas.addEventListener('pointermove', (e) => {
            if (previewMode !== 'screencast') return;
            const { x, y } = mapPointerToCanvas(e.clientX, e.clientY);
            vscode.postMessage({
                command: 'cdpMouse',
                type: 'mouseMoved',
                x, y,
                button: 'none',
                clickCount: 0,
                buttons: e.buttons,
                modifiers: ptrMods(e)
            });
        });
        scCanvas.addEventListener('contextmenu', (e) => e.preventDefault());
        scCanvas.addEventListener('wheel', (e) => {
            if (previewMode !== 'screencast') return;
            e.preventDefault();
            const { x, y } = mapPointerToCanvas(e.clientX, e.clientY);
            vscode.postMessage({
                command: 'cdpWheel',
                x, y,
                deltaX: e.deltaX,
                deltaY: e.deltaY,
                modifiers: ptrMods(e)
            });
        }, { passive: false });

        const vkMap = {
            'Backspace': 8, 'Tab': 9, 'Enter': 13, 'ShiftLeft': 16, 'ShiftRight': 16, 'ControlLeft': 17, 'ControlRight': 17,
            'AltLeft': 18, 'AltRight': 18, 'Escape': 27, 'Space': 32, 'ArrowLeft': 37, 'ArrowUp': 38, 'ArrowRight': 39, 'ArrowDown': 40,
            'Delete': 46
        };
        scCanvas.addEventListener('keydown', (e) => {
            if (previewMode !== 'screencast') return;
            e.preventDefault();
            const vk = vkMap[e.code] ?? 0;
            const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
            vscode.postMessage({
                command: 'cdpKey',
                type: 'keyDown',
                key: e.key,
                code: e.code,
                windowsVirtualKeyCode: vk,
                nativeVirtualKeyCode: vk,
                text: printable ? e.key : undefined
            });
        });
        scCanvas.addEventListener('keyup', (e) => {
            if (previewMode !== 'screencast') return;
            e.preventDefault();
            const vk = vkMap[e.code] ?? 0;
            vscode.postMessage({
                command: 'cdpKey',
                type: 'keyUp',
                key: e.key,
                code: e.code,
                windowsVirtualKeyCode: vk,
                nativeVirtualKeyCode: vk
            });
        });

        function reload() {
            if (previewMode === 'screencast') {
                vscode.postMessage({ command: 'cdpReload' });
            } else {
                frame.src = frame.src;
            }
        }

        function toggleInspect() {
            if (previewMode === 'screencast') return;
            inspecting = !inspecting;
            inspectBtn.classList.toggle('active', inspecting);
            frame.contentWindow.postMessage({ command: 'toggleInspect', value: inspecting }, '*');
        }

        function pushDeviceToCdp() {
            if (previewMode !== 'screencast') return;
            const device = document.getElementById('deviceSelect').value;
            if (device === 'responsive') {
                vscode.postMessage({ command: 'cdpClearDeviceMetrics' });
            } else if (device === 'mobile') {
                vscode.postMessage({ command: 'cdpDeviceMetrics', width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
            } else if (device === 'tablet') {
                vscode.postMessage({ command: 'cdpDeviceMetrics', width: 820, height: 1180, deviceScaleFactor: 2, mobile: true });
            } else if (device === 'desktop') {
                vscode.postMessage({ command: 'cdpDeviceMetrics', width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
            }
        }

        function changeDevice() {
            const device = document.getElementById('deviceSelect').value;
            const container = document.getElementById('preview-container');
            if (device === 'responsive') {
                container.style.width = '100%';
                container.style.height = '100%';
                container.style.borderRadius = '0';
            } else if (device === 'mobile') {
                container.style.width = '390px';
                container.style.height = '844px';
                container.style.borderRadius = '20px';
            } else if (device === 'tablet') {
                container.style.width = '820px';
                container.style.height = '1180px';
                container.style.borderRadius = '12px';
            } else if (device === 'desktop') {
                container.style.width = '1440px';
                container.style.height = '900px';
                container.style.borderRadius = '0';
            }
            pushDeviceToCdp();
        }

        function defaultDevtoolsHeightPx() {
            return Math.min(720, Math.max(320, Math.round(window.innerHeight * 0.42)));
        }

        function toggleConsole() {
            const isHidden = devtools.style.height === '0px';
            devtools.style.height = isHidden ? defaultDevtoolsHeightPx() + 'px' : '0px';
        }

        function setDevtoolsView(view) {
            const tbInsp = document.getElementById('devtools-toolbar-inspector');
            const tbLeg = document.getElementById('devtools-toolbar-legacy');
            if (view === 'legacy') {
                devtools.classList.add('legacy-view');
                tbInsp.style.display = 'none';
                tbLeg.style.display = 'flex';
            } else {
                devtools.classList.remove('legacy-view');
                tbInsp.style.display = 'flex';
                tbLeg.style.display = 'none';
            }
        }

        function switchLegacyTab(which) {
            document.querySelectorAll('#view-legacy .devtools-tabs .tab').forEach(t => t.classList.remove('active'));
            const legTab = document.querySelector('#view-legacy .devtools-tabs .tab[data-legacy="' + which + '"]');
            if (legTab) legTab.classList.add('active');
            document.getElementById('legacy-console').style.display = which === 'console' ? 'flex' : 'none';
            document.getElementById('legacy-elements').style.display = which === 'elements' ? 'flex' : 'none';
            document.getElementById('legacy-storage').style.display = which === 'storage' ? 'flex' : 'none';
        }

        function setChromeInspector(url) {
            const iframe = document.getElementById('chrome-devtools-frame');
            const status = document.getElementById('chrome-status');
            document.getElementById('server-stopped-banner').classList.remove('show');
            if (!url) {
                status.style.display = 'block';
                status.textContent = 'Starting Chrome and attaching DevTools…';
                status.className = 'chrome-hint';
                iframe.style.display = 'none';
                return;
            }
            status.style.display = 'none';
            iframe.style.display = 'block';
            iframe.src = url;
        }

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'setPreviewMode') {
                setPreviewMode(message.mode === 'screencast' ? 'screencast' : 'iframe');
                if (message.mode === 'screencast') {
                    setScreencastConnecting('Connecting to Chromium preview…');
                    pushDeviceToCdp();
                }
            } else if (message.command === 'screencastFrame' && message.data && scCtx) {
                const img = new Image();
                img.onload = () => {
                    scCanvas.width = img.naturalWidth;
                    scCanvas.height = img.naturalHeight;
                    scCtx.drawImage(img, 0, 0);
                    scPlaceholder.classList.remove('show');
                    vscode.postMessage({ command: 'screencastAck', sessionId: message.sessionId });
                };
                img.onerror = () => {
                    vscode.postMessage({ command: 'screencastAck', sessionId: message.sessionId });
                };
                img.src = 'data:image/jpeg;base64,' + message.data;
            } else if (message.command === 'screencastBridgeError') {
                const ban = document.getElementById('screencast-banner');
                ban.textContent = 'Screencast unavailable — showing the served page in the iframe instead. ' + (message.message || '');
                ban.classList.add('show');
            } else if (message.command === 'liveServerStopped') {
                const stopBan = document.getElementById('server-stopped-banner');
                stopBan.textContent = message.message || 'Live Server stopped.';
                stopBan.classList.add('show');
                setPreviewMode('iframe');
                document.getElementById('chrome-devtools-frame').style.display = 'none';
                const st = document.getElementById('chrome-status');
                st.style.display = 'block';
                st.className = 'chrome-hint error';
                st.textContent = 'Preview disconnected: Live Server was stopped.';
                setDevtoolsView('inspector');
            } else if (message.command === 'chromeInspectorLoading') {
                setDevtoolsView('inspector');
                setChromeInspector('');
                if (message.screencastTarget) {
                    setPreviewMode('screencast');
                    setScreencastConnecting('Connecting to Chromium preview…');
                } else {
                    setPreviewMode('iframe');
                }
            } else if (message.command === 'setChromeInspector') {
                setChromeInspector(message.url);
            } else if (message.command === 'chromeInspectorError') {
                const status = document.getElementById('chrome-status');
                const iframe = document.getElementById('chrome-devtools-frame');
                status.style.display = 'block';
                status.className = 'chrome-hint error';
                status.textContent = 'Inspector: ' + (message.message || 'Unknown error');
                iframe.style.display = 'none';
                setDevtoolsView('inspector');
                setPreviewMode('iframe');
                const ban = document.getElementById('screencast-banner');
                ban.textContent = 'Chromium could not start — showing the served page in the iframe. ' + (message.message || '');
                ban.classList.add('show');
            } else if (message.type === 'devtools') {
                if (message.method === 'element') {
                    const tab = document.querySelector('#legacy-elements .tab-scroll');
                    tab.innerHTML = \`<div class="element-info">
                        <div class="element-tag">&lt;\${message.args[0]} 
                            <span class="element-attr">id</span>="<span class="element-val">\${message.id}</span>" 
                            <span class="element-attr">class</span>="<span class="element-val">\${message.classes}</span>"&gt;
                        </div>
                        <div class="element-html">\${message.html.replace(/</g, '&lt;')}</div>
                    </div>\`;
                    setDevtoolsView('legacy');
                    switchLegacyTab('elements');
                    inspecting = false;
                    inspectBtn.classList.remove('active');
                    frame.contentWindow.postMessage({ command: 'toggleInspect', value: false }, '*');
                } else if (message.method === 'storage') {
                    const grid = document.getElementById('storage-grid');
                    const data = JSON.parse(message.data);
                    grid.innerHTML = '';
                    for (const key in data) {
                        grid.innerHTML += \`<div class="storage-item key">\${key}</div><div class="storage-item">\${data[key]}</div>\`;
                    }
                } else {
                    const consoleTab = document.getElementById('tab-console-inner');
                    const entry = document.createElement('div');
                    entry.className = 'log-entry ' + message.method;
                    entry.innerHTML = \`<span class="time">\${new Date().toLocaleTimeString()}</span>
                                     <span class="method">\${message.method}</span>
                                     <span class="args">\${message.args.join(' ')}</span>\`;
                    consoleTab.appendChild(entry);
                    consoleTab.scrollTop = consoleTab.scrollHeight;
                }
            } else if (message.command === 'updateUrl') {
                frame.src = message.url;
                document.getElementById('urlInput').value = message.url;
            } else if (message.command === 'cdpNetworkEntry' && message.entry) {
                appendNetworkEntryRow(message.entry);
            } else if (message.command === 'cdpNetworkCleared') {
                const list = document.getElementById('network-capture-list');
                if (list) list.innerHTML = '';
                const out = document.getElementById('network-replay-output');
                if (out) {
                    out.style.display = 'none';
                    out.textContent = '';
                }
            } else if (message.command === 'cdpNetworkReplayResult') {
                const out = document.getElementById('network-replay-output');
                if (!out) return;
                out.style.display = 'block';
                if (message.ok) {
                    const prev = (message.bodyPreview || '').slice(0, 8000);
                    out.textContent =
                        'HTTP ' +
                        (message.status != null ? message.status : '?') +
                        (message.contentType ? ' · ' + message.contentType : '') +
                        '\\n' +
                        prev;
                } else {
                    out.textContent = 'Replay failed: ' + (message.error || 'unknown');
                }
            }
        });

        const handle = document.getElementById('resize-handle');
        handle.onmousedown = () => {
            document.onmousemove = (e) => {
                const height = window.innerHeight - e.clientY;
                if (height > 30 && height < window.innerHeight - 100) {
                    devtools.style.height = height + 'px';
                }
            };
            document.onmouseup = () => { document.onmousemove = null; };
        };
    </script>
</body>
</html>`;
    }

    public dispose() {
        if (this._disposed) {
            return;
        }
        this._disposed = true;
        PreviewWebview.currentPanel = undefined;
        this._cdpBridge?.dispose();
        this._cdpBridge = undefined;
        this._chromeDispose?.();
        this._chromeDispose = undefined;
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
        this._panel.dispose();
    }

    /** Stop the Chromium debug browser used for embedded DevTools (e.g. when stopping the live server). */
    public killChromeSession(): void {
        this._chromeDispose?.();
        this._chromeDispose = undefined;
        this._cdpBridge?.dispose();
        this._cdpBridge = undefined;
    }

    public static disposeChromeSession(): void {
        PreviewWebview.currentPanel?.killChromeSession();
    }
}
