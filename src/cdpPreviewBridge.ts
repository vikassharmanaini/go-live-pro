import WebSocket from 'ws';

const NETWORK_LOG_MAX = 100;
const REPLAY_BODY_PREVIEW_LEN = 6000;

export interface NetworkEntrySummary {
    id: number;
    url: string;
    method: string;
    timestamp: number;
    resourceType?: string;
}

interface CapturedRequest {
    id: number;
    requestId: string;
    url: string;
    method: string;
    headers: Record<string, string>;
    postData: string | undefined;
    timestamp: number;
    resourceType?: string;
}

interface PendingCapture {
    requestId: string;
    url: string;
    method: string;
    headers: Record<string, string>;
    postData: string | undefined;
    timestamp: number;
    resourceType?: string;
}

export interface NetworkReplayResult {
    ok: boolean;
    status?: number;
    contentType?: string;
    bodyPreview?: string;
    error?: string;
}

export interface CdpPreviewBridgeConnectOptions {
    /** Called when a request finishes (XHR/Fetch) and is ready for replay. */
    onNetworkEntry?: (entry: NetworkEntrySummary) => void;
}

export interface ScreencastFramePayload {
    data: string;
    sessionId: number;
    metadata: {
        offsetTop: number;
        pageScaleFactor: number;
        deviceWidth: number;
        deviceHeight: number;
        scrollOffsetX: number;
        scrollOffsetY: number;
    };
}

export type CdpWebviewMessage =
    | { command: 'screencastAck'; sessionId: number }
    | {
          command: 'cdpMouse';
          type: 'mousePressed' | 'mouseReleased' | 'mouseMoved';
          x: number;
          y: number;
          button: 'none' | 'left' | 'middle' | 'right';
          clickCount: number;
          modifiers?: number;
          /** Bitmask of pressed buttons (PointerEvent.buttons / CDP). */
          buttons?: number;
      }
    | { command: 'cdpWheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers?: number }
    | {
          command: 'cdpKey';
          type: 'keyDown' | 'keyUp' | 'rawKeyDown' | 'char';
          key: string;
          code: string;
          text?: string;
          windowsVirtualKeyCode?: number;
          nativeVirtualKeyCode?: number;
          modifiers?: number;
      }
    | { command: 'cdpDeviceMetrics'; width: number; height: number; deviceScaleFactor: number; mobile: boolean }
    | { command: 'cdpClearDeviceMetrics' }
    | { command: 'cdpReload' }
    | { command: 'cdpNetworkClear' };

type FrameHandler = (frame: ScreencastFramePayload) => void;

interface Pending {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
}

export class CdpPreviewBridge {
    private ws: WebSocket;
    private nextId = 1;
    private pending = new Map<number, Pending>();
    private disposed = false;
    private onFrame: FrameHandler;
    private onNetworkEntry?: (entry: NetworkEntrySummary) => void;
    private nextCaptureId = 1;
    private readonly pendingCaptures = new Map<string, PendingCapture>();
    private readonly capturesByNumericId = new Map<number, CapturedRequest>();

    private constructor(ws: WebSocket, onFrame: FrameHandler, options?: CdpPreviewBridgeConnectOptions) {
        this.ws = ws;
        this.onFrame = onFrame;
        this.onNetworkEntry = options?.onNetworkEntry;
        this.ws.on('message', (data: WebSocket.RawData) => {
            this.handleMessage(String(data.toString()));
        });
        this.ws.on('close', () => {
            this.dispose();
        });
        this.ws.on('error', () => {
            this.dispose();
        });
    }

    static async connect(
        pageWsUrl: string,
        onFrame: FrameHandler,
        options?: CdpPreviewBridgeConnectOptions
    ): Promise<CdpPreviewBridge> {
        const ws = new WebSocket(pageWsUrl);
        await new Promise<void>((resolve, reject) => {
            ws.once('open', () => resolve());
            ws.once('error', (err) => reject(err instanceof Error ? err : new Error(String(err))));
        });
        const bridge = new CdpPreviewBridge(ws, onFrame, options);
        try {
            await bridge.sendCommand('Page.enable', {});
            await bridge.sendCommand('Input.enable', {});
            await bridge.sendCommand('Runtime.enable', {});
            await bridge.sendCommand('Network.enable', {});
            await bridge.sendCommand('Page.startScreencast', {
                format: 'jpeg',
                quality: 85,
                maxWidth: 1920,
                maxHeight: 1080,
            });
        } catch (e) {
            bridge.dispose();
            throw e;
        }
        return bridge;
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        for (const [, p] of this.pending) {
            p.reject(new Error('CDP bridge closed'));
        }
        this.pending.clear();
        this.pendingCaptures.clear();
        this.capturesByNumericId.clear();
        try {
            if (this.ws.readyState === WebSocket.OPEN) {
                try {
                    this.ws.send(
                        JSON.stringify({ id: this.nextId++, method: 'Page.stopScreencast', params: {} })
                    );
                } catch {
                    /* ignore */
                }
            }
            this.ws.removeAllListeners();
            this.ws.close();
        } catch {
            /* ignore */
        }
    }

    handleWebviewMessage(msg: CdpWebviewMessage): void {
        if (this.disposed || this.ws.readyState !== WebSocket.OPEN) {
            return;
        }
        switch (msg.command) {
            case 'screencastAck':
                void this.sendRaw('Page.screencastFrameAck', { sessionId: msg.sessionId });
                break;
            case 'cdpMouse': {
                let buttons = msg.buttons;
                if (buttons === undefined) {
                    if (msg.type === 'mouseReleased') {
                        buttons = 0;
                    } else if (msg.type === 'mousePressed') {
                        buttons =
                            msg.button === 'left' ? 1 : msg.button === 'right' ? 2 : msg.button === 'middle' ? 4 : 0;
                    } else {
                        buttons = 0;
                    }
                }
                void this.sendRaw('Input.dispatchMouseEvent', {
                    type: msg.type,
                    x: Math.round(msg.x),
                    y: Math.round(msg.y),
                    button: msg.button,
                    buttons,
                    clickCount: msg.clickCount,
                    modifiers: msg.modifiers ?? 0,
                });
                break;
            }
            case 'cdpWheel':
                void this.sendRaw('Input.dispatchMouseEvent', {
                    type: 'mouseWheel',
                    x: Math.round(msg.x),
                    y: Math.round(msg.y),
                    deltaX: msg.deltaX,
                    deltaY: msg.deltaY,
                    modifiers: msg.modifiers ?? 0,
                });
                break;
            case 'cdpKey': {
                const params: Record<string, unknown> = {
                    type: msg.type,
                    modifiers: msg.modifiers ?? 0,
                };
                if (msg.windowsVirtualKeyCode !== undefined) {
                    params.windowsVirtualKeyCode = msg.windowsVirtualKeyCode;
                }
                if (msg.nativeVirtualKeyCode !== undefined) {
                    params.nativeVirtualKeyCode = msg.nativeVirtualKeyCode;
                }
                if (msg.text !== undefined) {
                    params.text = msg.text;
                }
                if (msg.code) {
                    params.code = msg.code;
                }
                if (msg.key) {
                    params.key = msg.key;
                }
                void this.sendRaw('Input.dispatchKeyEvent', params);
                break;
            }
            case 'cdpDeviceMetrics':
                void this.sendRaw('Emulation.setDeviceMetricsOverride', {
                    width: Math.round(msg.width),
                    height: Math.round(msg.height),
                    deviceScaleFactor: msg.deviceScaleFactor,
                    mobile: msg.mobile,
                    screenWidth: Math.round(msg.width),
                    screenHeight: Math.round(msg.height),
                });
                break;
            case 'cdpClearDeviceMetrics':
                void this.sendRaw('Emulation.clearDeviceMetricsOverride', {});
                break;
            case 'cdpReload':
                void this.sendRaw('Page.reload', { ignoreCache: false });
                break;
            case 'cdpNetworkClear':
                this.clearNetworkCaptures();
                break;
            default:
                break;
        }
    }

    /** Replays a captured XHR/Fetch via Runtime.evaluate in the page (same origin cookies/CORS as fetch from the page). */
    async replayNetworkRequest(captureId: number): Promise<NetworkReplayResult> {
        const cap = this.capturesByNumericId.get(captureId);
        if (!cap) {
            return { ok: false, error: 'No captured request with that id.' };
        }
        if (this.disposed || this.ws.readyState !== WebSocket.OPEN) {
            return { ok: false, error: 'CDP not connected.' };
        }
        const headers: Record<string, string> = { ...cap.headers };
        const skip = new Set([
            'host',
            'connection',
            'content-length',
            'keep-alive',
            'transfer-encoding',
            'cookie',
            'origin',
            'referer',
        ]);
        for (const k of Object.keys(headers)) {
            if (skip.has(k.toLowerCase())) {
                delete headers[k];
            }
        }
        const spec = {
            url: cap.url,
            method: cap.method,
            headers,
            body: cap.postData ?? null,
        };
        const specJson = JSON.stringify(spec);
        const expression = `(async()=>{const spec=${specJson};const h=new Headers();Object.keys(spec.headers||{}).forEach(k=>h.append(k,spec.headers[k]));const init={method:spec.method||'GET',headers:h};const m=(spec.method||'GET').toUpperCase();if(spec.body!=null&&spec.body!==''&&['POST','PUT','PATCH','DELETE'].includes(m)){init.body=spec.body;}const r=await fetch(spec.url,init);const t=await r.text();return{ok:r.ok,status:r.status,contentType:r.headers.get('content-type')||'',bodyPreview:t.slice(0,${REPLAY_BODY_PREVIEW_LEN})};})()`;
        try {
            const raw = (await this.sendCommand('Runtime.evaluate', {
                expression,
                awaitPromise: true,
                returnByValue: true,
            })) as {
                result?: { value?: NetworkReplayResult };
                exceptionDetails?: { text?: string };
            };
            if (raw.exceptionDetails) {
                return { ok: false, error: raw.exceptionDetails.text ?? 'Runtime.evaluate failed' };
            }
            const v = raw.result?.value as NetworkReplayResult | undefined;
            if (v && typeof v === 'object') {
                return {
                    ok: !!v.ok,
                    status: v.status,
                    contentType: v.contentType,
                    bodyPreview: v.bodyPreview,
                    error: v.error,
                };
            }
            return { ok: false, error: 'Unexpected evaluate result' };
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return { ok: false, error: msg };
        }
    }

    clearNetworkCaptures(): void {
        this.capturesByNumericId.clear();
        this.pendingCaptures.clear();
        this.nextCaptureId = 1;
    }

    private sendRaw(method: string, params: object): void {
        if (this.disposed || this.ws.readyState !== WebSocket.OPEN) {
            return;
        }
        const id = this.nextId++;
        this.ws.send(JSON.stringify({ id, method, params }));
    }

    private async sendCommand(method: string, params: object): Promise<unknown> {
        if (this.disposed || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('CDP not connected');
        }
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    private handleMessage(raw: string): void {
        if (this.disposed) {
            return;
        }
        let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string } };
        try {
            msg = JSON.parse(raw) as typeof msg;
        } catch {
            return;
        }
        if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
            const p = this.pending.get(msg.id);
            if (p) {
                this.pending.delete(msg.id);
                if (msg.error) {
                    p.reject(new Error(msg.error.message));
                } else {
                    p.resolve(msg.result);
                }
            }
            return;
        }
        if (msg.method === 'Page.screencastFrame' && msg.params) {
            const p = msg.params as {
                data: string;
                sessionId: number;
                metadata: ScreencastFramePayload['metadata'];
            };
            this.onFrame({
                data: p.data,
                sessionId: p.sessionId,
                metadata: p.metadata,
            });
            return;
        }
        if (msg.method === 'Network.requestWillBeSent' && msg.params) {
            this.onRequestWillBeSent(msg.params as Record<string, unknown>);
            return;
        }
        if (msg.method === 'Network.requestWillBeSentExtraInfo' && msg.params) {
            this.onRequestWillBeSentExtraInfo(msg.params as Record<string, unknown>);
            return;
        }
        if (msg.method === 'Network.loadingFinished' && msg.params) {
            void this.onLoadingFinished(msg.params as { requestId?: string });
            return;
        }
        if (msg.method === 'Network.requestFailed' && msg.params) {
            void this.onRequestFailed(msg.params as { requestId?: string });
            return;
        }
    }

    private static headersObjectToRecord(h: unknown): Record<string, string> {
        const out: Record<string, string> = {};
        if (!h || typeof h !== 'object') {
            return out;
        }
        for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
            if (typeof v === 'string') {
                out[k] = v;
            }
        }
        return out;
    }

    private static mergeHeaderPairs(
        target: Record<string, string>,
        headers: Array<{ name?: string; value?: string }> | undefined
    ): void {
        if (!headers) {
            return;
        }
        for (const pair of headers) {
            if (pair.name && pair.value !== undefined) {
                target[pair.name] = pair.value;
            }
        }
    }

    private onRequestWillBeSent(params: Record<string, unknown>): void {
        const requestId = params.requestId as string | undefined;
        const type = params.type as string | undefined;
        if (!requestId || (type !== 'XHR' && type !== 'Fetch')) {
            return;
        }
        const request = params.request as
            | { url?: string; method?: string; headers?: Record<string, string>; postData?: string }
            | undefined;
        if (!request?.url) {
            return;
        }
        this.pendingCaptures.set(requestId, {
            requestId,
            url: request.url,
            method: (request.method || 'GET').toUpperCase(),
            headers: CdpPreviewBridge.headersObjectToRecord(request.headers),
            postData: request.postData,
            timestamp: Date.now(),
            resourceType: type,
        });
    }

    private onRequestWillBeSentExtraInfo(params: Record<string, unknown>): void {
        const requestId = params.requestId as string | undefined;
        if (!requestId) {
            return;
        }
        const pending = this.pendingCaptures.get(requestId);
        if (!pending) {
            return;
        }
        const headers = params.headers as Array<{ name?: string; value?: string }> | undefined;
        CdpPreviewBridge.mergeHeaderPairs(pending.headers, headers);
    }

    private async finalizeCapture(requestId: string): Promise<void> {
        const pending = this.pendingCaptures.get(requestId);
        if (!pending) {
            return;
        }
        this.pendingCaptures.delete(requestId);
        if (pending.method !== 'GET' && pending.method !== 'HEAD' && (pending.postData === undefined || pending.postData === '')) {
            try {
                const data = (await this.sendCommand('Network.getRequestPostData', { requestId })) as {
                    postData?: string;
                };
                if (typeof data?.postData === 'string') {
                    pending.postData = data.postData;
                }
            } catch {
                /* no body */
            }
        }
        const id = this.nextCaptureId++;
        const full: CapturedRequest = {
            id,
            requestId: pending.requestId,
            url: pending.url,
            method: pending.method,
            headers: pending.headers,
            postData: pending.postData,
            timestamp: pending.timestamp,
            resourceType: pending.resourceType,
        };
        this.capturesByNumericId.set(id, full);
        while (this.capturesByNumericId.size > NETWORK_LOG_MAX) {
            const oldest = Math.min(...this.capturesByNumericId.keys());
            this.capturesByNumericId.delete(oldest);
        }
        this.onNetworkEntry?.({
            id: full.id,
            url: full.url,
            method: full.method,
            timestamp: full.timestamp,
            resourceType: full.resourceType,
        });
    }

    private async onLoadingFinished(params: { requestId?: string }): Promise<void> {
        const requestId = params.requestId;
        if (!requestId || !this.pendingCaptures.has(requestId)) {
            return;
        }
        await this.finalizeCapture(requestId);
    }

    private async onRequestFailed(params: { requestId?: string }): Promise<void> {
        const requestId = params.requestId;
        if (!requestId || !this.pendingCaptures.has(requestId)) {
            return;
        }
        await this.finalizeCapture(requestId);
    }
}

export function isCdpWebviewMessage(o: unknown): o is CdpWebviewMessage {
    if (!o || typeof o !== 'object') {
        return false;
    }
    const c = o as { command?: string };
    return (
        c.command === 'screencastAck' ||
        c.command === 'cdpMouse' ||
        c.command === 'cdpWheel' ||
        c.command === 'cdpKey' ||
        c.command === 'cdpDeviceMetrics' ||
        c.command === 'cdpClearDeviceMetrics' ||
        c.command === 'cdpReload' ||
        c.command === 'cdpNetworkClear'
    );
}
