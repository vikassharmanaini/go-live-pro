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
class LiveServer {
    constructor(rootDir) {
        this.port = 5500;
        this.rootDir = rootDir;
        this.app = (0, express_1.default)();
        this.setupMiddleware();
    }
    setupMiddleware() {
        this.app.use((req, res, next) => {
            if (req.url.endsWith('.html') || req.url === '/' || !path.extname(req.url)) {
                const filePath = path.join(this.rootDir, req.url === '/' ? 'index.html' : req.url);
                if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                    let content = fs.readFileSync(filePath, 'utf8');
                    content = this.injectLiveReloadScript(content);
                    res.send(content);
                    return;
                }
            }
            next();
        });
        this.app.use(express_1.default.static(this.rootDir));
    }
    injectLiveReloadScript(html) {
        const script = `
        <script>
            (function() {
                const socket = new WebSocket('ws://localhost:${this.port}');
                socket.onmessage = function(msg) {
                    if (msg.data === 'reload') {
                        window.location.reload();
                    }
                };
                socket.onclose = function() {
                    console.log('Live Server connection closed.');
                };
            })();
        </script>
        `;
        if (html.includes('</body>')) {
            return html.replace('</body>', `${script}</body>`);
        }
        return html + script;
    }
    async start() {
        return new Promise((resolve, reject) => {
            this.server = http.createServer(this.app);
            this.wss = new ws_1.default.Server({ server: this.server });
            this.server.listen(this.port, () => {
                console.log(`Live Server running at http://localhost:${this.port}`);
                resolve(this.port);
            }).on('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    this.port++;
                    this.start().then(resolve).catch(reject);
                }
                else {
                    reject(err);
                }
            });
        });
    }
    stop() {
        this.wss?.close();
        this.server?.close();
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