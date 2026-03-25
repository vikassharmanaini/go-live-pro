import * as cp from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';

export interface ChromiumSession {
    inspectorHttpUrl: string;
    debugPort: number;
    /** From `/json/list` for the matched `page` target; CDP WebSocket (second client OK; DevTools may use another). */
    webSocketDebuggerUrl: string;
    /** From `/json/list` `id` for the matched `page` target. */
    targetId: string;
    dispose: () => void;
}

interface JsonTarget {
    id: string;
    type: string;
    url: string;
    devtoolsFrontendUrl?: string;
    webSocketDebuggerUrl?: string;
}

function httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

async function waitForDebuggerPort(port: number, maxMs = 15000): Promise<void> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        try {
            const body = await httpGet(`http://127.0.0.1:${port}/json/version`);
            if (body && body.includes('Browser')) {
                return;
            }
        } catch {
            /* retry */
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Timed out waiting for Chrome remote debugging port.');
}

async function isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.once('error', () => resolve(false));
        s.listen(port, '127.0.0.1', () => {
            s.close(() => resolve(true));
        });
    });
}

async function pickDebugPort(preferred?: number): Promise<number> {
    if (preferred && preferred > 0 && (await isPortFree(preferred))) {
        return preferred;
    }
    for (let p = 9222; p < 9322; p++) {
        if (await isPortFree(p)) {
            return p;
        }
    }
    throw new Error('No free TCP port found for Chrome remote debugging (9222–9321).');
}

export function resolveChromeExecutable(configured?: string): string | undefined {
    if (configured && fs.existsSync(configured)) {
        return configured;
    }
    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
        return process.env.CHROME_PATH;
    }
    if (process.platform === 'darwin') {
        const candidates = [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ];
        for (const c of candidates) {
            if (fs.existsSync(c)) {
                return c;
            }
        }
    } else if (process.platform === 'win32') {
        const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
        const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
        const candidates = [
            path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ];
        for (const c of candidates) {
            if (fs.existsSync(c)) {
                return c;
            }
        }
    } else {
        const whichNames = ['google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium', 'microsoft-edge'];
        for (const name of whichNames) {
            try {
                const p = cp.execSync(`which ${name}`, { encoding: 'utf8' }).trim();
                if (p && fs.existsSync(p)) {
                    return p;
                }
            } catch {
                /* try next */
            }
        }
    }
    return undefined;
}

function killProcessTree(child: cp.ChildProcess): void {
    if (!child.pid) {
        return;
    }
    if (process.platform === 'win32') {
        try {
            cp.execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
        } catch {
            child.kill();
        }
    } else {
        child.kill('SIGTERM');
    }
}

function normalizeUrlPrefix(u: string): string {
    try {
        const parsed = new URL(u);
        const host = parsed.hostname === 'localhost' ? '127.0.0.1' : parsed.hostname;
        const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
        return `${parsed.protocol}//${host}:${port}`;
    } catch {
        return u.replace(/\/$/, '');
    }
}

function pageUrlsMatch(targetUrl: string, livePageUrl: string): boolean {
    if (targetUrl === livePageUrl) {
        return true;
    }
    if (targetUrl.startsWith(livePageUrl) || livePageUrl.startsWith(targetUrl)) {
        return true;
    }
    try {
        const a = new URL(targetUrl);
        const b = new URL(livePageUrl);
        const ha = a.hostname === 'localhost' ? '127.0.0.1' : a.hostname;
        const hb = b.hostname === 'localhost' ? '127.0.0.1' : b.hostname;
        const pa = a.port || '80';
        const pb = b.port || '80';
        if (ha === hb && pa === pb && a.pathname === b.pathname) {
            return true;
        }
    } catch {
        /* fall through */
    }
    const want = normalizeUrlPrefix(livePageUrl);
    const tw = normalizeUrlPrefix(targetUrl);
    return tw === want || targetUrl.startsWith(want + '/') || targetUrl.startsWith(want + '?');
}

function buildInspectorUrl(debugPort: number, target: JsonTarget): string {
    if (target.devtoolsFrontendUrl) {
        const rel = target.devtoolsFrontendUrl.startsWith('/')
            ? target.devtoolsFrontendUrl
            : `/${target.devtoolsFrontendUrl}`;
        return `http://127.0.0.1:${debugPort}${rel}`;
    }
    const ws = target.webSocketDebuggerUrl;
    if (ws) {
        const hostPart = ws.replace(/^ws:\/\//, '').replace(/^wss:\/\//, '');
        const encoded = encodeURIComponent(hostPart);
        return `http://127.0.0.1:${debugPort}/devtools/inspector.html?ws=${encoded}`;
    }
    return `http://127.0.0.1:${debugPort}/devtools/inspector.html?ws=${encodeURIComponent(
        `127.0.0.1:${debugPort}/devtools/page/${target.id}`
    )}`;
}

async function findPageTarget(debugPort: number, livePageUrl: string): Promise<JsonTarget> {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        try {
            const raw = await httpGet(`http://127.0.0.1:${debugPort}/json/list`);
            const list = JSON.parse(raw) as JsonTarget[];
            const page = list.find((t) => t.type === 'page' && pageUrlsMatch(t.url, livePageUrl));
            if (page) {
                return page;
            }
        } catch {
            /* retry */
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('Could not find a Chrome page tab for the live preview URL.');
}

export async function startChromiumDebuggingSession(
    livePageUrl: string,
    options: {
        chromeExecutable?: string;
        preferredDebugPort?: number;
        userDataDir: string;
        /** Use Chromium headless (new); DevTools + screencast still attach to the page. */
        headless?: boolean;
        /** When true, move the OS window off-screen to reduce distraction (ignored if headless). */
        offScreenWindow?: boolean;
    }
): Promise<ChromiumSession> {
    const chromePath = resolveChromeExecutable(options.chromeExecutable);
    if (!chromePath) {
        throw new Error(
            'Chrome, Chromium, or Edge not found. Install a Chromium-based browser or set go-live.chromeExecutable.'
        );
    }

    await fs.promises.mkdir(options.userDataDir, { recursive: true });

    const debugPort = await pickDebugPort(options.preferredDebugPort);

    const args = [
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${options.userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-popup-blocking',
    ];
    if (options.headless) {
        args.push('--headless=new');
    } else if (options.offScreenWindow) {
        args.push('--window-position=-2400,-2400');
        args.push('--window-size=800,600');
    }
    args.push(livePageUrl);

    const child = cp.spawn(chromePath, args, {
        stdio: 'ignore',
        env: { ...process.env },
    });
    try {
        await waitForDebuggerPort(debugPort);
        const target = await findPageTarget(debugPort, livePageUrl);
        const inspectorHttpUrl = buildInspectorUrl(debugPort, target);
        const pageWs = target.webSocketDebuggerUrl;
        if (!pageWs) {
            throw new Error('Chrome did not report webSocketDebuggerUrl for the preview page.');
        }

        return {
            inspectorHttpUrl,
            debugPort,
            webSocketDebuggerUrl: pageWs,
            targetId: target.id,
            dispose: () => killProcessTree(child),
        };
    } catch (e) {
        killProcessTree(child);
        throw e;
    }
}
