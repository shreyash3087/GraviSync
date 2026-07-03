/**
 * WebSocket connection handler
 * Manages mobile client connections, snapshot streaming, and remote control
 */
import { WebSocketServer, WebSocket, RawData } from 'ws';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import { parse as parseCookie } from 'cookie';
import { AuthManager } from './auth';
import { CDPBridge } from './cdpBridge';
import { ServerMessage, ClientMessage, ConnectedClient } from '../types';
import { logInfo, logWarn, logError, logDebug } from '../utils/logger';

const PING_INTERVAL = 15000; // 15 seconds
const PONG_TIMEOUT = 10000; // 10 seconds

interface WSClient {
    ws: WebSocket;
    id: string;
    ip: string;
    sessionId: string;
    connectedAt: number;
    lastActivity: number;
    userAgent?: string;
    alive: boolean;
    lastSentHtml?: string;
    cssSent?: boolean;
}

export class WSHandler {
    private wss: WebSocketServer | null = null;
    private clients: Map<string, WSClient> = new Map();
    private pingInterval: NodeJS.Timeout | null = null;
    private snapshotInterval: NodeJS.Timeout | null = null;
    private authManager: AuthManager;
    private cdpBridge: CDPBridge;
    private maxClients: number;
    private snapshotIntervalMs: number;
    private onClientChange?: (clients: ConnectedClient[]) => void;

    constructor(
        authManager: AuthManager,
        cdpBridge: CDPBridge,
        maxClients: number = 5,
        snapshotIntervalMs: number = 1000,
        onClientChange?: (clients: ConnectedClient[]) => void
    ) {
        this.authManager = authManager;
        this.cdpBridge = cdpBridge;
        this.maxClients = maxClients;
        this.snapshotIntervalMs = snapshotIntervalMs;
        this.onClientChange = onClientChange;
    }

    /**
     * Attach WebSocket server to HTTP/HTTPS server
     */
    attach(server: http.Server | https.Server): void {
        this.wss = new WebSocketServer({ server, path: '/ws' });

        this.wss.on('connection', (ws, req) => {
            this.handleConnection(ws, req);
        });

        // Start heartbeat
        this.pingInterval = setInterval(() => this.heartbeat(), PING_INTERVAL);

        // Start snapshot streaming
        this.startSnapshotStreaming();

        logInfo('WebSocket handler attached');
    }

    /**
     * Handle new WebSocket connection
     */
    private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
        const ip = req.headers['x-forwarded-for'] as string || req.socket.remoteAddress || 'unknown';
        const userAgent = req.headers['user-agent'];

        // Validate session cookie
        const cookies = parseCookie(req.headers.cookie || '');
        const sessionId = cookies['ag_session'];

        if (!sessionId || !this.authManager.validateSession(sessionId)) {
            logWarn(`WebSocket rejected: invalid session from ${ip}`);
            ws.close(4001, 'Unauthorized');
            return;
        }

        // Check max clients
        if (this.clients.size >= this.maxClients) {
            logWarn(`WebSocket rejected: max clients (${this.maxClients}) from ${ip}`);
            ws.close(4003, 'Max clients reached');
            return;
        }

        const clientId = crypto.randomBytes(8).toString('hex');
        const client: WSClient = {
            ws,
            id: clientId,
            ip,
            sessionId,
            connectedAt: Date.now(),
            lastActivity: Date.now(),
            userAgent: userAgent || undefined,
            alive: true
        };

        this.clients.set(clientId, client);
        logInfo(`Client connected: ${clientId.slice(0, 8)} from ${ip} (total: ${this.clients.size})`);
        this.notifyClientChange();

        // Send initial state
        this.sendToClient(client, {
            type: 'clients',
            data: { count: this.clients.size }
        });

        // Send cached snapshot if available
        const lastSnapshot = this.cdpBridge.getLastSnapshot();
        if (lastSnapshot) {
            this.sendSnapshotToClient(client, lastSnapshot);
        }

        // Handle messages
        ws.on('message', (data) => {
            this.handleMessage(client, data);
        });

        ws.on('close', () => {
            this.clients.delete(clientId);
            logInfo(`Client disconnected: ${clientId.slice(0, 8)} (total: ${this.clients.size})`);
            this.notifyClientChange();
        });

        ws.on('error', (err) => {
            logError(`WebSocket error for ${clientId.slice(0, 8)}`, err);
        });

        ws.on('pong', () => {
            client.alive = true;
        });
    }

    /**
     * Handle incoming message from mobile client
     */
    private async handleMessage(client: WSClient, raw: RawData): Promise<void> {
        try {
            const msg: ClientMessage = JSON.parse(raw.toString());
            client.lastActivity = Date.now();

            switch (msg.type) {
                case 'message':
                    logInfo(`Remote message from ${client.id.slice(0, 8)}: ${msg.text.slice(0, 50)}...`);
                    await this.cdpBridge.sendMessage(msg.text);
                    this.pushSnapshotSoon(350);
                    break;

                case 'command':
                    logInfo(`Remote command from ${client.id.slice(0, 8)}: ${msg.cmd}`);
                    await this.handleCommand(msg);
                    this.pushSnapshotSoon(500);
                    break;

                case 'action':
                    logInfo(`Remote action from ${client.id.slice(0, 8)}: ${msg.action}`);
                    await this.cdpBridge.clickAction(msg.action, 0);
                    this.pushSnapshotSoon(400);
                    break;

                case 'scroll':
                    await this.cdpBridge.remoteScroll(msg.position);
                    break;

                case 'click':
                    if (msg.target) {
                        await this.cdpBridge.clickAction(msg.target.text, msg.target.occurrenceIndex || 0, msg.target.agId);
                    } else {
                        // Backward compatibility for old client (direct properties at root)
                        const legacyMsg = msg as any;
                        await this.cdpBridge.clickAction(legacyMsg.text, legacyMsg.occurrenceIndex || 0);
                    }
                    this.pushSnapshotSoon(400);
                    break;

                case 'formInput':
                    await this.cdpBridge.formInput(msg.target.agId, msg.target.value, msg.target.checked);
                    this.pushSnapshotSoon(300);
                    break;

                case 'pong':
                    client.alive = true;
                    break;

                default:
                    logWarn(`Unknown message type from ${client.id.slice(0, 8)}`);
            }
        } catch (error) {
            logError('Failed to handle WS message', error);
        }
    }

    /**
     * Push a snapshot to all clients after a short delay.
     * Used to give VS Code time to update its UI after a user action,
     * then immediately reflect that change without waiting for the next interval tick.
     */
    private pushSnapshotSoon(delayMs: number): void {
        setTimeout(async () => {
            try {
                const snapshot = await this.cdpBridge.captureSnapshot();
                if (snapshot) {
                    this.sendSnapshotToAllClients(snapshot);
                }
            } catch (e) {
                // Non-critical — the interval will catch up
            }
        }, delayMs);
    }

    private async handleCommand(msg: { cmd: string; params?: Record<string, string> }): Promise<void> {
        switch (msg.cmd) {
            case 'stop':
                await this.cdpBridge.stopGeneration();
                break;
            case 'newChat':
                await this.cdpBridge.startNewChat();
                break;
            case 'setModel':
                if (msg.params?.model) {
                    await this.cdpBridge.setModel(msg.params.model);
                }
                break;
            case 'setMode':
                if (msg.params?.mode) {
                    await this.cdpBridge.setMode(msg.params.mode);
                }
                break;
        }
    }

    /**
     * Start periodic snapshot streaming to all clients
     */
    private startSnapshotStreaming(): void {
        if (this.snapshotInterval) {
            clearInterval(this.snapshotInterval);
        }

        logInfo(`[WS Trace] Starting snapshot streaming interval with ms: ${this.snapshotIntervalMs}`);

        this.snapshotInterval = setInterval(async () => {
            if (this.clients.size === 0) {
                return;
            }

            logInfo(`[WS Trace] Interval ticked. Connected clients: ${this.clients.size}. CDP State: ${this.cdpBridge.getState()}`);

            try {
                const snapshot = await this.cdpBridge.captureSnapshot();
                if (snapshot) {
                    this.sendSnapshotToAllClients(snapshot);
                } else {
                    logInfo(`[WS Trace] captureSnapshot returned null.`);
                }

                // Also send app state periodically
                const state = await this.cdpBridge.getAppState();
                this.broadcast({ type: 'state', data: state });
            } catch (error) {
                logError('[WS Trace] Exception in snapshot interval', error);
            }
        }, this.snapshotIntervalMs);
    }

    /**
     * Send snapshot to all clients with optimizations:
     * - Only send CSS if client hasn't received it yet (cssSent is false).
     * - Only send HTML if the HTML changed (after sanitizing time-based changes).
     */
    private sendSnapshotToAllClients(snapshot: any): void {
        const html = snapshot.html || '';

        // Helper to strip dynamic visual artifacts (times, loading dots) from comparisons
        const sanitizeHtml = (str: string): string => {
            return str
                .replace(/\b\d+ms\b/g, '')
                .replace(/\bWorked for [\d\s\w]+s?\b/gi, '')
                .replace(/\bThought for [\d\s\w]+s?\b/gi, '')
                .replace(/\b(Waiting for user input|Exploring|Analyzing|Thinking|Running|Generating|Loading)\.*/gi, '$1');
        };

        const sanitizedHtml = sanitizeHtml(html);

        for (const client of this.clients.values()) {
            if (client.ws.readyState !== WebSocket.OPEN) {
                continue;
            }

            // 1. Deduplication check
            if (client.lastSentHtml && sanitizeHtml(client.lastSentHtml) === sanitizedHtml) {
                // HTML is unchanged for this client, skip payload to save bandwidth
                continue;
            }

            this.sendSnapshotToClient(client, snapshot);
        }
    }

    /**
     * Send a snapshot to a single client, stripping CSS if it has already been sent to that client.
     */
    private sendSnapshotToClient(client: WSClient, snapshot: any): void {
        const timestamp = Date.now();
        const html = snapshot.html || '';

        // 1. CSS-stripping check
        let cssPayload = '';
        if (!client.cssSent) {
            cssPayload = snapshot.css || '';
            client.cssSent = true;
        }

        // 2. Construct optimized snapshot
        const optimizedData = {
            ...snapshot,
            css: cssPayload // Send CSS only once on connect
        };

        logInfo(`[WS Trace] Sending snapshot to client ${client.id.slice(0, 8)}. HTML: ${html.length} chars, CSS: ${cssPayload.length} chars.`);

        client.ws.send(JSON.stringify({
            type: 'snapshot',
            data: optimizedData,
            timestamp: timestamp
        }));

        // Track last sent HTML
        client.lastSentHtml = html;
    }

    /**
     * WebSocket heartbeat — detect dead connections
     */
    private heartbeat(): void {
        for (const [id, client] of this.clients) {
            if (!client.alive) {
                logInfo(`Client ${id.slice(0, 8)} timed out, disconnecting`);
                client.ws.terminate();
                this.clients.delete(id);
                this.notifyClientChange();
                continue;
            }

            client.alive = false;
            client.ws.ping();
        }
    }

    /**
     * Broadcast a message to all connected clients
     */
    broadcast(msg: ServerMessage): void {
        const data = JSON.stringify(msg);
        for (const client of this.clients.values()) {
            if (client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(data);
            }
        }
    }

    /**
     * Send a message to a specific client
     */
    private sendToClient(client: WSClient, msg: ServerMessage): void {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(msg));
        }
    }

    /**
     * Get list of connected clients
     */
    getConnectedClients(): ConnectedClient[] {
        return Array.from(this.clients.values()).map(c => ({
            id: c.id,
            ip: c.ip,
            connectedAt: c.connectedAt,
            lastActivity: c.lastActivity,
            userAgent: c.userAgent
        }));
    }

    /**
     * Disconnect all clients
     */
    disconnectAll(): void {
        for (const client of this.clients.values()) {
            client.ws.close(1000, 'Server shutdown');
        }
        this.clients.clear();
        this.notifyClientChange();
    }

    private notifyClientChange(): void {
        this.onClientChange?.(this.getConnectedClients());
    }

    /**
     * Clean shutdown
     */
    dispose(): void {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        if (this.snapshotInterval) {
            clearInterval(this.snapshotInterval);
            this.snapshotInterval = null;
        }

        this.disconnectAll();

        if (this.wss) {
            this.wss.close();
            this.wss = null;
        }
    }
}
