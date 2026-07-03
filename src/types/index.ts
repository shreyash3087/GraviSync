/**
 * Shared TypeScript interfaces for Antigravity Remote Connect
 */

/** Connection mode */
export type ConnectionMode = 'local' | 'remote';

/** Server state */
export type ServerState = 'stopped' | 'starting' | 'running' | 'error';

/** CDP connection state */
export type CDPState = 'disconnected' | 'connecting' | 'connected' | 'error';

/** Connected client info */
export interface ConnectedClient {
    id: string;
    ip: string;
    connectedAt: number;
    lastActivity: number;
    userAgent?: string;
}

/** Session stored in memory */
export interface Session {
    id: string;
    clientIP: string;
    connectedAt: number;
    lastActivity: number;
    userAgent?: string;
}

/** Auth token payload (embedded in QR magic link) */
export interface MagicLinkPayload {
    nonce: string;
    timestamp: number;
    signature: string;
}

/** Snapshot data from CDP */
export interface SnapshotData {
    html: string;
    css: string;
    backgroundColor?: string;
    color?: string;
    fontFamily?: string;
    scrollInfo?: ScrollInfo;
    stats?: SnapshotStats;
}

export interface ScrollInfo {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    scrollPercent: number;
}

export interface SnapshotStats {
    nodes: number;
    htmlSize: number;
    cssSize: number;
}

/** App state from Antigravity */
export interface AppState {
    model: string;
    mode: string;
    chatStatus: 'open' | 'closed' | 'unknown';
    hasPendingActions: boolean;
    isGenerating?: boolean;
}

/** WebSocket message types — Server to Client */
export type ServerMessage =
    | { type: 'snapshot'; data: SnapshotData; timestamp: number }
    | { type: 'state'; data: AppState }
    | { type: 'notification'; data: { title: string; body: string; actions?: string[] } }
    | { type: 'clients'; data: { count: number } }
    | { type: 'ping' }
    | { type: 'error'; message: string };

/** WebSocket message types — Client to Server */
export type ClientMessage =
    | { type: 'action'; action: 'approve' | 'deny' | 'allowOnce'; target?: string }
    | { type: 'message'; text: string }
    | { type: 'command'; cmd: 'stop' | 'newChat' | 'setModel' | 'setMode'; params?: Record<string, string> }
    | { type: 'scroll'; position: number }
    | { type: 'click'; target: ClickTarget }
    | { type: 'formInput'; target: { agId: string; value: string; checked: boolean } }
    | { type: 'pong' };

export interface ClickTarget {
    tag: string;
    text: string;
    occurrenceIndex?: number;
    agId?: string;
}

/** Server status for the extension sidebar */
export interface ServerStatus {
    state: ServerState;
    mode: ConnectionMode | null;
    port: number;
    url: string | null;
    tunnelUrl: string | null;
    cdpState: CDPState;
    clients: ConnectedClient[];
    uptime: number;
}

/** Tunnel provider selection */
export type TunnelProvider = 'cloudflare' | 'ngrok';

/** Configuration from VS Code settings */
export interface ExtensionConfig {
    serverPort: number;
    tunnelProvider: TunnelProvider;
    ngrokAuthToken: string;
    ngrokAuthTokens: string[];
    maxClients: number;
    sessionTimeoutHours: number;
    snapshotIntervalMs: number;
    enableTotp: boolean;
    autoStart: boolean;
    cdpPorts: number[];
}
