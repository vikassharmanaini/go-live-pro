import express from 'express';
import * as http from 'http';
import ws from 'ws';
import * as path from 'path';
import * as fs from 'fs';

export class LiveServer {
    private app: express.Application;
    private server?: http.Server;
    private wss?: ws.Server;
    private port: number = 5500;
    private rootDir: string;

    constructor(rootDir: string) {
        this.rootDir = rootDir;
        this.app = express();
        this.setupMiddleware();
    }

    private setupMiddleware() {
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

        this.app.use(express.static(this.rootDir));
    }

    private injectLiveReloadScript(html: string): string {
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

    public async start(): Promise<number> {
        return new Promise((resolve, reject) => {
            this.server = http.createServer(this.app);
            this.wss = new ws.Server({ server: this.server });

            this.server.listen(this.port, () => {
                console.log(`Live Server running at http://localhost:${this.port}`);
                resolve(this.port);
            }).on('error', (err: any) => {
                if (err.code === 'EADDRINUSE') {
                    this.port++;
                    this.start().then(resolve).catch(reject);
                } else {
                    reject(err);
                }
            });
        });
    }

    public stop() {
        this.wss?.close();
        this.server?.close();
    }

    public reload() {
        this.wss?.clients.forEach(client => {
            if (client.readyState === ws.OPEN) {
                client.send('reload');
            }
        });
    }
}
