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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LiveServer = void 0;
const express_1 = __importDefault(require("express"));
const http = __importStar(require("http"));
const ws_1 = __importDefault(require("ws"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const http_proxy_middleware_1 = require("http-proxy-middleware");
class LiveServer {
    constructor(rootDir, port = 5500, isSpa = false, proxy = '') {
        this.rootDir = rootDir;
        this.port = port;
        this.isSpa = isSpa;
        this.proxy = proxy;
        this.app = (0, express_1.default)();
        this.setupMiddleware();
    }
    isPathUnderRoot(candidate) {
        const root = path.resolve(this.rootDir);
        const resolved = path.resolve(candidate);
        const rel = path.relative(root, resolved);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    }
    setupMiddleware() {
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
        this.app.use(express_1.default.static(this.rootDir));
        // 3. Optional Proxy fallback (Dev Mode / Backend support)
        if (this.proxy) {
            console.log(`Setting up proxy fallback to: ${this.proxy}`);
            this.app.use((0, http_proxy_middleware_1.createProxyMiddleware)({
                target: this.proxy,
                changeOrigin: true,
                ws: true,
                on: {
                    error: (err, req, res) => {
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
                }
                else {
                    res.status(404).send('Not Found');
                }
            });
        }
    }
    injectLiveReloadScript(html) {
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
    async start() {
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
        throw new Error(`Could not bind Live Server: tried ${maxAttempts} ports starting at ${firstPort} (all in use or unavailable).`);
    }
    tryBindOnce(port) {
        return new Promise((resolve) => {
            const srv = http.createServer(this.app);
            const wss = new ws_1.default.Server({ server: srv });
            const fail = (retry, error) => {
                wss.close(() => {
                    srv.close(() => resolve({ ok: false, retry, error }));
                });
            };
            const onError = (err) => {
                srv.removeListener('error', onError);
                if (err.code === 'EADDRINUSE') {
                    fail(true);
                }
                else {
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
    stop() {
        return new Promise((resolve) => {
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
            }
            else {
                srv?.close(() => resolve());
            }
        });
    }
    reload() {
        this.wss?.clients.forEach(client => {
            if (client.readyState === ws_1.default.OPEN) {
                client.send('reload');
            }
        });
    }
}
exports.LiveServer = LiveServer;
//# sourceMappingURL=server.js.map