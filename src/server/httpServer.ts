/**
 * Express HTTP/HTTPS server
 * Serves the mobile web app and provides REST API endpoints
 */
import express, { Request, Response, NextFunction } from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { AuthManager } from './auth';
import { CDPBridge } from './cdpBridge';
import { WSHandler } from './wsHandler';
import { SSLCerts } from './ssl';
import { ConnectedClient, ExtensionConfig, ServerStatus, ConnectionMode, CDPState } from '../types';
import { getLocalIP } from '../utils/networkUtils';
import { logInfo, logWarn, logError } from '../utils/logger';

export class AppServer {
    private app: express.Application;
    private server: http.Server | https.Server | null = null;
    private authManager: AuthManager;
    private cdpBridge: CDPBridge;
    private wsHandler: WSHandler;
    private mode: ConnectionMode;
    private port: number;
    private startTime: number = 0;
    private sslCerts: SSLCerts | null;
    private extensionPath: string;
    private onClientChange?: (clients: ConnectedClient[]) => void;
    private onCDPStateChange?: (state: CDPState) => void;

    constructor(
        config: ExtensionConfig,
        mode: ConnectionMode,
        extensionPath: string,
        sslCerts: SSLCerts | null,
        onClientChange?: (clients: ConnectedClient[]) => void,
        onCDPStateChange?: (state: CDPState) => void
    ) {
        this.mode = mode;
        this.port = config.serverPort;
        this.extensionPath = extensionPath;
        this.sslCerts = sslCerts;
        this.onClientChange = onClientChange;
        this.onCDPStateChange = onCDPStateChange;

        // Initialize managers
        this.authManager = new AuthManager(config.sessionTimeoutHours);
        this.cdpBridge = new CDPBridge(config.cdpPorts, onCDPStateChange);
        this.wsHandler = new WSHandler(
            this.authManager,
            this.cdpBridge,
            config.maxClients,
            config.snapshotIntervalMs,
            onClientChange
        );

        // Setup Express
        this.app = express();
        this.setupMiddleware();
        this.setupRoutes();
    }

    /**
     * Start the server
     */
    async start(): Promise<{ localUrl: string; magicToken: string }> {
        this.startTime = Date.now();

        // Create HTTP or HTTPS server
        if (this.sslCerts) {
            this.server = https.createServer({
                key: this.sslCerts.key,
                cert: this.sslCerts.cert
            }, this.app);
            logInfo('HTTPS server created');
        } else {
            this.server = http.createServer(this.app);
            logInfo('HTTP server created (no SSL certs found)');
        }

        // Attach WebSocket handler
        this.wsHandler.attach(this.server);

        // Start listening
        await new Promise<void>((resolve, reject) => {
            this.server!.listen(this.port, '0.0.0.0', () => {
                resolve();
            });
            this.server!.on('error', reject);
        });

        const protocol = this.sslCerts ? 'https' : 'http';
        const localIP = getLocalIP();
        const localUrl = `${protocol}://${localIP}:${this.port}`;

        logInfo(`Server listening on ${localUrl}`);

        // Connect to CDP (non-blocking)
        this.cdpBridge.connect().catch(err => {
            logWarn('Initial CDP connection failed (will retry)', err);
        });

        // Generate magic link token
        const { token } = this.authManager.generateMagicToken();
        const magicToken = token;

        return { localUrl, magicToken };
    }

    /**
     * Stop the server
     */
    async stop(): Promise<void> {
        logInfo('Stopping server...');

        this.wsHandler.dispose();
        this.cdpBridge.disconnect();
        this.authManager.dispose();

        if (this.server) {
            await new Promise<void>((resolve) => {
                this.server!.close(() => resolve());
                // Force close after 5 seconds
                setTimeout(() => resolve(), 5000);
            });
            this.server = null;
        }

        logInfo('Server stopped');
    }

    /**
     * Get the auth manager (for generating new tokens)
     */
    getAuthManager(): AuthManager {
        return this.authManager;
    }

    /**
     * Get server status
     */
    getStatus(): ServerStatus {
        return {
            state: this.server ? 'running' : 'stopped',
            mode: this.mode,
            port: this.port,
            url: this.server ? `${this.sslCerts ? 'https' : 'http'}://${getLocalIP()}:${this.port}` : null,
            tunnelUrl: null, // Set by the command layer when tunnel is active
            cdpState: this.cdpBridge.getState(),
            clients: this.wsHandler.getConnectedClients(),
            uptime: this.startTime ? Date.now() - this.startTime : 0
        };
    }

    /**
     * Disconnect all clients
     */
    disconnectAllClients(): void {
        this.wsHandler.disconnectAll();
        this.authManager.destroyAllSessions();
    }

    // --- Middleware ---

    private setupMiddleware(): void {
        this.app.use(compression());
        this.app.use(cookieParser());
        this.app.use(express.json({ limit: '15mb' }));

        // Security headers
        this.app.use((_req: Request, res: Response, next: NextFunction) => {
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Frame-Options', 'DENY');
            res.setHeader('X-XSS-Protection', '1; mode=block');
            res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
            res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
            next();
        });

        // Serve static files (mobile web app — Vite React build output)
        const webDir = path.join(this.extensionPath, 'web', 'dist');

        // Public assets — served WITHOUT auth so browsers can fetch them freely.
        // manifest.json, sw.js and favicon need to be accessible before a session cookie exists.
        this.app.get('/app/manifest.json', (_req: Request, res: Response) => {
            const manifestPath = path.join(webDir, 'manifest.json');
            res.setHeader('Content-Type', 'application/manifest+json');
            res.setHeader('Cache-Control', 'no-cache');
            res.sendFile(manifestPath);
        });

        this.app.get('/app/sw.js', (_req: Request, res: Response) => {
            const swPath = path.join(webDir, 'sw.js');
            res.setHeader('Content-Type', 'application/javascript');
            res.setHeader('Cache-Control', 'no-cache');
            res.sendFile(swPath);
        });

        // Serve the logo_without_bg PNG file as the favicon
        this.app.get('/favicon.ico', (_req: Request, res: Response) => {
            const logoPath = path.join(this.extensionPath, 'media', 'logo_without_bg.png');
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.sendFile(logoPath);
        });

        // Auth-gated static files
        this.app.use('/app', this.requireAuth.bind(this), express.static(webDir, {
            setHeaders: (res) => {
                // Strict CSP — no external CDN sources (fonts and icons are self-hosted/inline)
                res.setHeader('Content-Security-Policy',
                    "default-src 'none'; " +
                    "script-src 'self'; " +
                    "style-src 'self' 'unsafe-inline'; " +
                    "font-src 'self'; " +
                    "img-src 'self' data: blob:; " +
                    "connect-src 'self' wss: ws:; " +
                    "manifest-src 'self'; " +
                    "base-uri 'self'; " +
                    "form-action 'self'; " +
                    "frame-ancestors 'none'"
                );
            }
        }));
    }

    /**
     * Auth middleware — validates session cookie
     */
    private requireAuth(req: Request, res: Response, next: NextFunction): void {
        const sessionId = req.cookies?.['ag_session'];

        if (!sessionId) {
            res.status(401).json({ error: 'Not authenticated' });
            return;
        }

        const session = this.authManager.validateSession(sessionId);
        if (!session) {
            res.status(401).json({ error: 'Session expired' });
            return;
        }

        // Attach session to request for route handlers
        (req as any).session = session;
        next();
    }

    // --- Routes ---

    private setupRoutes(): void {
        // === Public routes ===

        // Health check (no auth)
        this.app.get('/api/health', (_req: Request, res: Response) => {
            res.json({
                status: 'ok',
                cdp: this.cdpBridge.getState(),
                clients: this.wsHandler.getConnectedClients().length,
                uptime: this.startTime ? Date.now() - this.startTime : 0,
                mode: this.mode
            });
        });

        // Magic link authentication
        this.app.get('/auth', (req: Request, res: Response) => {
            const token = req.query.t as string;
            const clientIP = req.headers['x-forwarded-for'] as string || req.ip || 'unknown';

            if (!token) {
                res.status(400).json({ error: 'Missing token' });
                return;
            }

            if (!this.authManager.validateMagicToken(token, clientIP)) {
                res.status(403).json({ error: 'Invalid or expired token' });
                return;
            }

            // Create session and set cookie
            const sessionId = this.authManager.createSession(clientIP, req.headers['user-agent']);

            res.cookie('ag_session', sessionId, {
                httpOnly: true,
                secure: !!this.sslCerts,
                sameSite: this.mode === 'remote' ? 'none' : 'strict',
                maxAge: 24 * 60 * 60 * 1000, // 24 hours
                path: '/'
            });

            // Redirect to the app
            res.redirect('/app/index.html');
        });

        // === Authenticated routes ===

        // Logout
        this.app.post('/api/logout', this.requireAuth.bind(this), (req: Request, res: Response) => {
            const sessionId = req.cookies?.['ag_session'];
            if (sessionId) {
                this.authManager.destroySession(sessionId);
            }
            res.clearCookie('ag_session');
            res.json({ success: true });
        });

        // Get snapshot
        this.app.get('/api/snapshot', this.requireAuth.bind(this), async (_req: Request, res: Response) => {
            try {
                const snapshot = await this.cdpBridge.captureSnapshot();
                if (snapshot) {
                    res.json(snapshot);
                } else {
                    res.status(503).json({ error: 'No snapshot available' });
                }
            } catch (error) {
                res.status(500).json({ error: 'Snapshot capture failed' });
            }
        });

        // Get app state
        this.app.get('/api/app-state', this.requireAuth.bind(this), async (_req: Request, res: Response) => {
            try {
                const state = await this.cdpBridge.getAppState();
                res.json(state);
            } catch (error) {
                res.status(500).json({ error: 'Failed to get app state' });
            }
        });

        // Send message
        this.app.post('/api/send', this.requireAuth.bind(this), async (req: Request, res: Response) => {
            const { text } = req.body;
            if (!text) {
                res.status(400).json({ error: 'Missing text' });
                return;
            }

            try {
                const success = await this.cdpBridge.sendMessage(text);
                res.json({ success });
            } catch (error) {
                res.status(500).json({ error: 'Failed to send message' });
            }
        });

        // Stop generation
        this.app.post('/api/stop', this.requireAuth.bind(this), async (_req: Request, res: Response) => {
            try {
                const success = await this.cdpBridge.stopGeneration();
                res.json({ success });
            } catch (error) {
                res.status(500).json({ error: 'Failed to stop generation' });
            }
        });

        // Approve/deny action
        this.app.post('/api/approve', this.requireAuth.bind(this), async (req: Request, res: Response) => {
            const { action, occurrenceIndex } = req.body;
            if (!action) {
                res.status(400).json({ error: 'Missing action' });
                return;
            }

            try {
                const success = await this.cdpBridge.clickAction(action, occurrenceIndex || 0);
                res.json({ success });
            } catch (error) {
                res.status(500).json({ error: 'Failed to execute action' });
            }
        });

        // Set model
        this.app.post('/api/set-model', this.requireAuth.bind(this), async (req: Request, res: Response) => {
            const { model } = req.body;
            if (!model) {
                res.status(400).json({ error: 'Missing model' });
                return;
            }

            try {
                const success = await this.cdpBridge.setModel(model);
                res.json({ success });
            } catch (error) {
                res.status(500).json({ error: 'Failed to set model' });
            }
        });

        // Set mode
        this.app.post('/api/set-mode', this.requireAuth.bind(this), async (req: Request, res: Response) => {
            const { mode } = req.body;
            if (!mode) {
                res.status(400).json({ error: 'Missing mode' });
                return;
            }

            try {
                const success = await this.cdpBridge.setMode(mode);
                res.json({ success });
            } catch (error) {
                res.status(500).json({ error: 'Failed to set mode' });
            }
        });

        // New chat
        this.app.post('/api/new-chat', this.requireAuth.bind(this), async (_req: Request, res: Response) => {
            try {
                const success = await this.cdpBridge.startNewChat();
                res.json({ success });
            } catch (error) {
                res.status(500).json({ error: 'Failed to start new chat' });
            }
        });

        // Chat history
        this.app.get('/api/chat-history', this.requireAuth.bind(this), async (_req: Request, res: Response) => {
            try {
                const history = await this.cdpBridge.getChatHistory();
                res.json({ history });
            } catch (error) {
                res.status(500).json({ error: 'Failed to get chat history' });
            }
        });

        // Remote click
        this.app.post('/api/remote-click', this.requireAuth.bind(this), async (req: Request, res: Response) => {
            const { text, occurrenceIndex } = req.body;
            if (!text) {
                res.status(400).json({ error: 'Missing click target' });
                return;
            }

            try {
                const success = await this.cdpBridge.clickAction(text, occurrenceIndex || 0);
                res.json({ success });
            } catch (error) {
                res.status(500).json({ error: 'Failed to execute click' });
            }
        });

        // Remote scroll
        this.app.post('/api/remote-scroll', this.requireAuth.bind(this), async (req: Request, res: Response) => {
            const { position } = req.body;
            if (position === undefined) {
                res.status(400).json({ error: 'Missing scroll position' });
                return;
            }

            try {
                await this.cdpBridge.remoteScroll(position);
                res.json({ success: true });
            } catch (error) {
                res.status(500).json({ error: 'Failed to sync scroll' });
            }
        });

        // Close history (dispatch Escape)
        this.app.post('/api/close-history', this.requireAuth.bind(this), async (_req: Request, res: Response) => {
            try {
                await this.cdpBridge.dispatchKey('Escape');
                res.json({ success: true });
            } catch (error) {
                res.status(500).json({ error: 'Failed to close history' });
            }
        });

        // Upload file from mobile
        this.app.post('/api/upload', this.requireAuth.bind(this), async (req: Request, res: Response) => {
            const { fileName, fileType, fileData } = req.body;
            if (!fileName || !fileData) {
                res.status(400).json({ error: 'Missing fileName or fileData' });
                return;
            }

            try {
                const matches = fileData.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
                let buffer: Buffer;
                if (matches && matches.length === 3) {
                    buffer = Buffer.from(matches[2], 'base64');
                } else {
                    buffer = Buffer.from(fileData, 'base64');
                }

                const tempDir = path.join(this.extensionPath, 'temp');
                if (!fs.existsSync(tempDir)) {
                    fs.mkdirSync(tempDir, { recursive: true });
                }

                const tempFilePath = path.join(tempDir, fileName);
                fs.writeFileSync(tempFilePath, buffer);
                logInfo(`Saved uploaded file locally: ${tempFilePath}`);

                const success = await this.cdpBridge.attachFile(tempFilePath);
                res.json({ success, path: tempFilePath });
            } catch (error) {
                logError('Failed to handle upload', error);
                res.status(500).json({ error: 'Failed to upload and attach file' });
            }
        });

        // Clear uploaded file (no-op helper for frontend sync)
        this.app.post('/api/clear-upload', this.requireAuth.bind(this), (_req: Request, res: Response) => {
            res.json({ success: true });
        });

        // Get list of workspace files for autocomplete recommendations
        this.app.get('/api/workspace-files', this.requireAuth.bind(this), async (_req: Request, res: Response) => {
            try {
                // Find up to 300 files, excluding node_modules, git, and agents folder
                const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**,**/.git/**,**/.agents/**', 300);
                const relativePaths = files.map(file => vscode.workspace.asRelativePath(file));
                res.json({ files: relativePaths });
            } catch (error) {
                logError('Failed to get workspace files', error);
                res.status(500).json({ error: 'Failed to retrieve workspace files' });
            }
        });

// Helper to locate the most recently updated agent artifact by filename in the brain directory
function findLatestArtifact(filename: string): string | null {
    const brainDir = path.join(os.homedir(), '.gemini', 'antigravity-ide', 'brain');
    if (!fs.existsSync(brainDir)) {
        return null;
    }

    try {
        const conversations = fs.readdirSync(brainDir);
        let latestFile: string | null = null;
        let latestMtime = 0;

        for (const convId of conversations) {
            const filePath = path.join(brainDir, convId, filename);
            if (fs.existsSync(filePath)) {
                const stat = fs.statSync(filePath);
                if (stat.isFile() && stat.mtimeMs > latestMtime) {
                    latestMtime = stat.mtimeMs;
                    latestFile = filePath;
                }
            }
        }
        return latestFile;
    } catch {
        return null;
    }
}

        // Get file contents (for plan / script previewing in frontend)
        this.app.get('/api/file-content', this.requireAuth.bind(this), async (req: Request, res: Response) => {
            const filePathQuery = req.query.path as string;
            if (!filePathQuery) {
                res.status(400).json({ error: 'Missing path parameter' });
                return;
            }

            try {
                let targetPath = filePathQuery;
                if (targetPath.startsWith('file://')) {
                    try {
                        targetPath = vscode.Uri.parse(targetPath).fsPath;
                    } catch {
                        targetPath = targetPath.replace(/^file:\/\/\/?/, '');
                    }
                }

                // Check if path is absolute. If not, resolve against workspace root.
                const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!path.isAbsolute(targetPath)) {
                    if (!workspaceRoot) {
                        res.status(400).json({ error: 'No workspace open' });
                        return;
                    }
                    const localPath = path.resolve(workspaceRoot, targetPath);
                    if (fs.existsSync(localPath)) {
                        targetPath = localPath;
                    } else {
                        // Fallback to the latest artifact in the agent's brain directory if it doesn't exist in the workspace
                        const latestArtifact = findLatestArtifact(targetPath);
                        if (latestArtifact) {
                            targetPath = latestArtifact;
                        } else {
                            targetPath = localPath; // Fallback to workspace path so it fails with 404
                        }
                    }
                }

                // Security check: ensure targetPath is within the workspace folder OR the agent's brain directory
                const agentBrainDir = path.join(os.homedir(), '.gemini', 'antigravity-ide', 'brain');
                let isAllowed = false;

                if (workspaceRoot) {
                    const relative = path.relative(workspaceRoot, targetPath);
                    const isSubdir = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
                    const isSame = targetPath === workspaceRoot;
                    if (isSubdir || isSame) {
                        isAllowed = true;
                    }
                }

                // Check if it is inside the agent's brain directory
                const relativeToBrain = path.relative(agentBrainDir, targetPath);
                const isInsideBrain = relativeToBrain && !relativeToBrain.startsWith('..') && !path.isAbsolute(relativeToBrain);
                if (isInsideBrain) {
                    isAllowed = true;
                }

                if (!isAllowed) {
                    res.status(403).json({ error: 'Access denied: path is outside the workspace' });
                    return;
                }

                // Read file
                if (!fs.existsSync(targetPath)) {
                    res.status(404).json({ error: 'File not found' });
                    return;
                }

                const stat = fs.statSync(targetPath);
                if (!stat.isFile()) {
                    res.status(400).json({ error: 'Not a file' });
                    return;
                }

                if (stat.size > 2 * 1024 * 1024) {
                    res.status(400).json({ error: 'File too large to preview' });
                    return;
                }

                const content = fs.readFileSync(targetPath, 'utf8');
                res.json({ content, path: targetPath });
            } catch (error) {
                logError('Failed to read file content', error);
                res.status(500).json({ error: 'Failed to read file content' });
            }
        });


        // Fallback: redirect root to auth or app
        this.app.get('/', (_req: Request, res: Response) => {
            res.redirect('/app/index.html');
        });
    }
}
