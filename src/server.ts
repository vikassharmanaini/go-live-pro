import express from 'express';
import * as http from 'http';
import ws from 'ws';
import * as path from 'path';
import * as fs from 'fs';

import { createProxyMiddleware } from 'http-proxy-middleware';

export class LiveServer {
    private app: express.Application;
    private server?: http.Server;
    private wss?: ws.Server;
    private port: number;
    private rootDir: string;
    private isSpa: boolean;
    private proxy: string;

    constructor(rootDir: string, port: number = 5500, isSpa: boolean = false, proxy: string = '') {
        this.rootDir = rootDir;
        this.port = port;
        this.isSpa = isSpa;
        this.proxy = proxy;
        this.app = express();
        this.setupMiddleware();
    }

    private isPathUnderRoot(candidate: string): boolean {
        const root = path.resolve(this.rootDir);
        const resolved = path.resolve(candidate);
        const rel = path.relative(root, resolved);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    }

    private setupMiddleware() {
        // 1. First try to serve injected HTML (Static files)
        this.app.use((req, res, next) => {
            const url = req.url.split('?')[0];
            if (url.endsWith('.html') || url === '/' || !path.extname(url)) {
                const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
                const filePath = path.resolve(this.rootDir, rel);
                if (!this.isPathUnderRoot(filePath)) {
                    return next();
                }
                if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                    let content = fs.readFileSync(filePath, 'utf8');
                    content = this.injectLiveReloadScript(content);
                    res.send(content);
                    return;
                }
            }
            next();
        });

        // 2. Serve other static files
        this.app.use(express.static(this.rootDir));

        // 3. Optional Proxy fallback (Dev Mode / Backend support)
        if (this.proxy) {
            console.log(`Setting up proxy fallback to: ${this.proxy}`);
            this.app.use(createProxyMiddleware({
                target: this.proxy,
                changeOrigin: true,
                ws: true,
                on: {
                    error: (err: any, req: any, res: any) => {
                        console.error(`Proxy Error: ${err.message}`);
                    }
                }
            }));
        }

        // 4. Finally, SPA Fallback if neither local file nor proxy worked (or if proxy was not set)
        if (this.isSpa) {
            this.app.get('*', (req, res) => {
                const indexPath = path.resolve(this.rootDir, 'index.html');
                if (!this.isPathUnderRoot(indexPath)) {
                    return res.status(404).send('Not Found');
                }
                if (fs.existsSync(indexPath)) {
                    let content = fs.readFileSync(indexPath, 'utf8');
                    content = this.injectLiveReloadScript(content);
                    res.send(content);
                } else {
                    res.status(404).send('Not Found');
                }
            });
        }
    }

    private injectLiveReloadScript(html: string): string {
        const script = `
        <script>
            (function() {
                // Live Reload (same host/port as the page — works for 127.0.0.1, localhost, and LAN IP)
                const socket = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host);
                socket.onmessage = function(msg) {
                    if (msg.data === 'reload') {
                        window.location.reload();
                    }
                };

                // Console Interception
                const originalConsole = {
                    log: console.log, error: console.error, warn: console.warn, info: console.info
                };
                const sendToParent = (type, args, metadata = {}) => {
                    window.parent.postMessage({
                        type: 'devtools',
                        method: type,
                        args: Array.from(args).map(arg => {
                            try { return typeof arg === 'object' ? JSON.stringify(arg) : String(arg); }
                            catch(e) { return String(arg); }
                        }),
                        ...metadata
                    }, '*');
                };

                console.log = function() { originalConsole.log.apply(console, arguments); sendToParent('log', arguments); };
                console.error = function() { originalConsole.error.apply(console, arguments); sendToParent('error', arguments); };
                console.warn = function() { originalConsole.warn.apply(console, arguments); sendToParent('warn', arguments); };
                console.info = function() { originalConsole.info.apply(console, arguments); sendToParent('info', arguments); };

                window.addEventListener('error', (e) => sendToParent('error', [e.message]));

                // Storage Sync
                const syncStorage = () => {
                    sendToParent('storage', [], { data: JSON.stringify(localStorage) });
                };
                window.addEventListener('storage', syncStorage);
                setInterval(syncStorage, 2000); // Polling as fallback

                // Element Inspector
                let inspecting = false;
                let overlay = document.createElement('div');
                overlay.style.cssText = 'position:fixed; pointer-events:none; background:rgba(0,120,215,0.3); border:1px solid #0078d7; z-index:100000; display:none;';
                document.body.appendChild(overlay);

                window.addEventListener('message', (event) => {
                    if (event.data.command === 'toggleInspect') {
                        inspecting = event.data.value;
                        if (!inspecting) overlay.style.display = 'none';
                    }
                });

                document.addEventListener('mousemove', (e) => {
                    if (!inspecting) return;
                    const el = document.elementFromPoint(e.clientX, e.clientY);
                    if (el && el !== overlay) {
                        const rect = el.getBoundingClientRect();
                        overlay.style.display = 'block';
                        overlay.style.width = rect.width + 'px';
                        overlay.style.height = rect.height + 'px';
                        overlay.style.top = rect.top + 'px';
                        overlay.style.left = rect.left + 'px';
                    }
                });

                document.addEventListener('click', (e) => {
                    if (!inspecting) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const el = document.elementFromPoint(e.clientX, e.clientY);
                    if (el) {
                        sendToParent('element', [el.tagName.toLowerCase()], { 
                            id: el.id, 
                            classes: el.className,
                            html: el.outerHTML.substring(0, 500) + '...'
                        });
                    }
                }, true);

            })();
        </script>
        `;
        if (html.includes('</body>')) {
            return html.replace('</body>', `${script}</body>`);
        }
        return html + script;
    }

    public async start(): Promise<number> {
        const maxAttempts = 80;
        let port = this.port;
        const firstPort = port;
        for (let i = 0; i < maxAttempts; i++, port++) {
            const bound = await this.tryBindOnce(port);
            if (bound.ok) {
                this.port = port;
                console.log(`Live Server running at http://localhost:${this.port}`);
                return this.port;
            }
            if (!bound.retry) {
                throw bound.error ?? new Error('Live Server failed to bind.');
            }
        }
        throw new Error(
            `Could not bind Live Server: tried ${maxAttempts} ports starting at ${firstPort} (all in use or unavailable).`
        );
    }

    private tryBindOnce(
        port: number
    ): Promise<{ ok: true } | { ok: false; retry: boolean; error?: Error }> {
        return new Promise((resolve) => {
            const srv = http.createServer(this.app);
            const wss = new ws.Server({ server: srv });
            const fail = (retry: boolean, error?: Error) => {
                wss.close(() => {
                    srv.close(() => resolve({ ok: false, retry, error }));
                });
            };
            const onError = (err: NodeJS.ErrnoException) => {
                srv.removeListener('error', onError);
                if (err.code === 'EADDRINUSE') {
                    fail(true);
                } else {
                    fail(false, err);
                }
            };
            srv.once('error', onError);
            srv.listen(port, () => {
                srv.removeListener('error', onError);
                this.server = srv;
                this.wss = wss;
                resolve({ ok: true });
            });
        });
    }

    public stop() {
        return new Promise<void>((resolve) => {
            const wss = this.wss;
            const srv = this.server;
            this.wss = undefined;
            this.server = undefined;
            if (!wss && !srv) {
                resolve();
                return;
            }
            if (wss) {
                wss.close(() => {
                    srv?.close(() => resolve());
                });
            } else {
                srv?.close(() => resolve());
            }
        });
    }

    public reload() {
        this.wss?.clients.forEach(client => {
            if (client.readyState === ws.OPEN) {
                client.send('reload');
            }
        });
    }
}
