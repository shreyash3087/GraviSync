/**
 * Chrome DevTools Protocol Bridge
 * Connects to Antigravity via CDP for session mirroring and remote control.
 * 
 * Inspired by antigravity_phone_chat's approach but with:
 * - Whitelisted-only CDP operations (no raw eval passthrough)
 * - Centralized message handler (prevents MaxListeners leak)
 * - Automatic reconnection with exponential backoff
 * - Typed responses
 */
import * as http from 'http';
import WebSocket from 'ws';
import { SnapshotData, AppState, CDPState } from '../types';
import { logInfo, logWarn, logError, logDebug } from '../utils/logger';

const CDP_CALL_TIMEOUT = 30000; // 30 seconds
const MAX_RECONNECT_DELAY = 30000; // 30 seconds
const INITIAL_RECONNECT_DELAY = 1000; // 1 second

interface CDPTarget {
    id: string;
    title: string;
    url: string;
    type: string;
    webSocketDebuggerUrl?: string;
}

interface PendingCall {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    timeoutId: NodeJS.Timeout;
}

interface ExecutionContext {
    id: number;
    name?: string;
    origin?: string;
}

export class CDPBridge {
    private ws: WebSocket | null = null;
    private idCounter = 1;
    private pendingCalls: Map<number, PendingCall> = new Map();
    private contexts: ExecutionContext[] = [];
    private cdpPorts: number[];
    private state: CDPState = 'disconnected';
    private reconnectDelay = INITIAL_RECONNECT_DELAY;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private shouldReconnect = false;
    private lastSnapshot: SnapshotData | null = null;
    private workingContextId: number | null = null; // cached context that produced a real snapshot
    private onStateChange?: (state: CDPState) => void;

    constructor(cdpPorts: number[], onStateChange?: (state: CDPState) => void) {
        this.cdpPorts = cdpPorts;
        this.onStateChange = onStateChange;
    }

    getState(): CDPState {
        return this.state;
    }

    getLastSnapshot(): SnapshotData | null {
        return this.lastSnapshot;
    }

    private setState(state: CDPState): void {
        this.state = state;
        this.onStateChange?.(state);
    }

    /**
     * Connect to Antigravity via CDP
     */
    async connect(): Promise<void> {
        this.shouldReconnect = true;
        this.setState('connecting');

        try {
            const target = await this.discoverCDP();
            if (!target.webSocketDebuggerUrl) {
                throw new Error('No WebSocket debugger URL found');
            }

            logInfo(`Connecting to CDP: ${target.title} (${target.url})`);
            await this.connectWebSocket(target.webSocketDebuggerUrl);
            this.setState('connected');
            this.reconnectDelay = INITIAL_RECONNECT_DELAY;
            logInfo('CDP connected successfully');
        } catch (error) {
            logError('CDP connection failed', error);
            this.setState('error');
            this.scheduleReconnect();
        }
    }

    /**
     * Disconnect from CDP
     */
    disconnect(): void {
        this.shouldReconnect = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        // Clean up pending calls
        for (const [id, pending] of this.pendingCalls) {
            clearTimeout(pending.timeoutId);
            pending.reject(new Error('CDP disconnected'));
        }
        this.pendingCalls.clear();

        if (this.ws) {
            try {
                this.ws.close();
            } catch { /* ignore */ }
            this.ws = null;
        }

        this.contexts = [];
        this.setState('disconnected');
        logInfo('CDP disconnected');
    }

    // --- CDP Discovery ---

    private async discoverCDP(): Promise<CDPTarget> {
        const errors: string[] = [];

        for (const port of this.cdpPorts) {
            try {
                const targets = await this.getJson<CDPTarget[]>(
                    `http://127.0.0.1:${port}/json/list`
                );

                // Priority 1: Extension Development Host (when debugging/testing)
                const devHost = targets.find(
                    t => t.title && t.title.includes('Extension Development Host')
                );
                if (devHost?.webSocketDebuggerUrl) {
                    logInfo(`Found Extension Development Host on port ${port}: ${devHost.title}`);
                    return devHost;
                }

                // Priority 2: Workbench (main Antigravity window)
                const workbench = targets.find(
                    t => t.url?.includes('workbench.html') ||
                        (t.title && t.title.toLowerCase().includes('workbench'))
                );
                if (workbench?.webSocketDebuggerUrl) {
                    logInfo(`Found Workbench on port ${port}: ${workbench.title}`);
                    return workbench;
                }

                // Priority 2: Jetski/Launchpad
                const jetski = targets.find(
                    t => t.url?.includes('jetski') || t.title === 'Launchpad'
                );
                if (jetski?.webSocketDebuggerUrl) {
                    logInfo(`Found Jetski/Launchpad on port ${port}: ${jetski.title}`);
                    return jetski;
                }

                // Priority 3: Any target with a debugger URL
                const any = targets.find(t => t.webSocketDebuggerUrl);
                if (any?.webSocketDebuggerUrl) {
                    logInfo(`Found target on port ${port}: ${any.title}`);
                    return any;
                }
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                errors.push(`${port}: ${msg}`);
            }
        }

        throw new Error(
            `Antigravity CDP not found on ports [${this.cdpPorts.join(', ')}]. ` +
            `Make sure Antigravity is running with --remote-debugging-port=<port>. ` +
            `Errors: ${errors.join('; ')}`
        );
    }

    // --- WebSocket Connection ---

    private async connectWebSocket(url: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url);

            const timeout = setTimeout(() => {
                ws.close();
                reject(new Error('CDP WebSocket connection timeout'));
            }, 10000);

            ws.on('open', async () => {
                clearTimeout(timeout);
                this.ws = ws;
                this.setupMessageHandler(ws);

                try {
                    // Enable Runtime to track execution contexts
                    await this.call('Runtime.enable', {});
                    // Enable DOM to support file attachments
                    await this.call('DOM.enable', {});
                    // Wait for contexts to populate
                    await new Promise(r => setTimeout(r, 1000));
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });

            ws.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });

            ws.on('close', () => {
                this.ws = null;
                this.contexts = [];
                this.workingContextId = null; // reset cached context on CDP reconnect
                if (this.state === 'connected') {
                    logWarn('CDP connection closed unexpectedly');
                    this.setState('disconnected');
                    this.scheduleReconnect();
                }
            });
        });
    }

    /**
     * Single centralized message handler — prevents MaxListenersExceeded
     */
    private setupMessageHandler(ws: WebSocket): void {
        ws.on('message', (msg: WebSocket.Data) => {
            try {
                const data = JSON.parse(msg.toString());

                // Handle method responses
                if (data.id !== undefined && this.pendingCalls.has(data.id)) {
                    const pending = this.pendingCalls.get(data.id)!;
                    clearTimeout(pending.timeoutId);
                    this.pendingCalls.delete(data.id);

                    if (data.error) {
                        pending.reject(data.error);
                    } else {
                        pending.resolve(data.result);
                    }
                }

                // Handle execution context events
                if (data.method === 'Runtime.executionContextCreated') {
                    this.contexts.push(data.params.context);
                } else if (data.method === 'Runtime.executionContextDestroyed') {
                    const ctxId = data.params.executionContextId;
                    const idx = this.contexts.findIndex(c => c.id === ctxId);
                    if (idx !== -1) { this.contexts.splice(idx, 1); }
                } else if (data.method === 'Runtime.executionContextsCleared') {
                    this.contexts.length = 0;
                    this.workingContextId = null; // contexts changed, rediscover
                }
            } catch { /* ignore parse errors */ }
        });
    }

    /**
     * Make a CDP call with timeout
     */
    private call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                reject(new Error('CDP not connected'));
                return;
            }

            const id = this.idCounter++;
            const timeoutId = setTimeout(() => {
                if (this.pendingCalls.has(id)) {
                    this.pendingCalls.delete(id);
                    reject(new Error(`CDP call ${method} timed out after ${CDP_CALL_TIMEOUT}ms`));
                }
            }, CDP_CALL_TIMEOUT);

            this.pendingCalls.set(id, { resolve, reject, timeoutId });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    private scheduleReconnect(): void {
        if (!this.shouldReconnect || this.reconnectTimer) { return; }

        logInfo(`Reconnecting in ${this.reconnectDelay / 1000}s...`);
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            if (this.shouldReconnect) {
                await this.connect();
            }
        }, this.reconnectDelay);

        // Exponential backoff
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
    }

    // --- Whitelisted CDP Operations ---

    /**
     * Capture a snapshot of the Antigravity chat DOM
     */
    async captureSnapshot(): Promise<SnapshotData | null> {
        logInfo(`[CDP Trace] captureSnapshot called. state = ${this.state}`);
        if (this.state !== 'connected') { return this.lastSnapshot; }

        const script = this.getCaptureScript();

        const tryContext = async (contextId?: number): Promise<SnapshotData | null> => {
            try {
                const callParams: Record<string, unknown> = {
                    expression: script,
                    returnByValue: true,
                    awaitPromise: true
                };
                if (contextId !== undefined) callParams.contextId = contextId;

                const result = await this.call('Runtime.evaluate', callParams) as {
                    result?: { value?: SnapshotData };
                    exceptionDetails?: { text: string; exception?: { description?: string } };
                };

                if (result.exceptionDetails) {
                    logError(`[CDP Trace] Exception in context ${contextId ?? 'default'}: ${result.exceptionDetails.text} - ${result.exceptionDetails.exception?.description}`);
                    return null;
                }
                const val = result.result?.value;
                if (!val || 'error' in val) { return null; }
                return val;
            } catch (err) {
                logError(`[CDP Trace] Runtime.evaluate threw for context ${contextId ?? 'default'}`, err);
                return null;
            }
        };

        // 1. Try the cached working context first — fastest path (single CDP call)
        if (this.workingContextId !== null) {
            const val = await tryContext(this.workingContextId);
            if (val) {
                this.lastSnapshot = val;
                return val;
            }
            // Cached context failed — reset so we rediscover
            logInfo(`[CDP Trace] Cached context ${this.workingContextId} failed, rediscovering...`);
            this.workingContextId = null;
        }

        // 2. Try all contexts and pick the LARGEST valid snapshot
        const candidates: Array<{ snapshot: SnapshotData; contextId: number | undefined }> = [];

        // Try default context first
        const defaultVal = await tryContext();
        if (defaultVal) {
            candidates.push({ snapshot: defaultVal, contextId: undefined });
        }

        // Try all named execution contexts
        logInfo(`[CDP Trace] Checking ${this.contexts.length} execution contexts...`);
        for (const ctx of this.contexts) {
            logInfo(`[CDP Trace] Trying Context ID: ${ctx.id}, Name: ${ctx.name}, Origin: ${ctx.origin}`);
            const val = await tryContext(ctx.id);
            if (val) {
                candidates.push({ snapshot: val, contextId: ctx.id });
            }
        }

        if (candidates.length > 0) {
            // Pick the candidate with the largest HTML (most content = most likely the right one)
            const best = candidates.reduce((a, b) => a.snapshot.html.length >= b.snapshot.html.length ? a : b);
            logInfo(`[CDP Trace] Best snapshot: ${best.snapshot.html.length} chars from context ${best.contextId ?? 'default'} — caching.`);
            // Always cache the winning context, even for small snapshots (empty panel).
            // This reduces subsequent captures from O(N contexts) to O(1).
            if (best.contextId !== undefined) {
                this.workingContextId = best.contextId;
            }
            this.lastSnapshot = best.snapshot;
            return best.snapshot;
        }

        return this.lastSnapshot;
    }

    /**
     * Send a message to the Antigravity chat
     */
    async sendMessage(text: string): Promise<boolean> {
        const escapedText = JSON.stringify(text);
        const script = `(async () => {
            const editors = document.querySelectorAll('.antigravity-agent-side-panel [contenteditable="true"], .antigravity-agent-side-panel [data-lexical-editor], [contenteditable="true"], [data-lexical-editor]');
            for (const editor of editors) {
                const style = window.getComputedStyle(editor);
                if (style.display !== 'none' && style.visibility !== 'hidden') {
                    editor.focus();
                    document.execCommand('selectAll');
                    document.execCommand('insertText', false, ${escapedText});
                    await new Promise(r => setTimeout(r, 100));
                    
                    // Try to find and click the submit button
                    const submitBtns = document.querySelectorAll('.antigravity-agent-side-panel button[type="submit"], .antigravity-agent-side-panel button[aria-label*="send" i], .antigravity-agent-side-panel button[aria-label*="submit" i], button[type="submit"], button[aria-label*="send" i], button[aria-label*="submit" i]');
                    for (const btn of submitBtns) {
                        if (btn.offsetParent !== null) {
                            btn.click();
                            return { success: true };
                        }
                    }
                    
                    // Fallback: press Enter
                    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
                    return { success: true };
                }
            }
            return { success: false, error: 'No editor found' };
        })()`;

        return this.evaluateInContexts(script, 'success');
    }

    /**
     * Attach a file using CDP file input automation
     */
    async attachFile(filePath: string): Promise<boolean> {
        if (this.state !== 'connected') { return false; }
        try {
            logInfo(`CDP attaching file: ${filePath}`);
            const doc = await this.call('DOM.getDocument', { depth: 1 }) as { root: { nodeId: number } };
            if (!doc.root) {
                logError('Failed to get DOM document root');
                return false;
            }
            
            const queryResult = await this.call('DOM.querySelector', {
                nodeId: doc.root.nodeId,
                selector: 'input[type="file"]'
            }) as { nodeId: number };
            
            if (!queryResult || !queryResult.nodeId) {
                logError('File input element not found in DOM');
                return false;
            }
            
            await this.call('DOM.setFileInputFiles', {
                nodeId: queryResult.nodeId,
                files: [filePath]
            });
            logInfo('File attached successfully via CDP');
            return true;
        } catch (error) {
            logError('Failed to attach file via CDP', error);
            return false;
        }
    }


    /**
     * Stop the current AI generation
     */
    async stopGeneration(): Promise<boolean> {
        const script = `(() => {
            const stopBtns = document.querySelectorAll('a, button, [role="button"], [data-testid*="stop" i], [id*="stop" i]');
            for (const btn of stopBtns) {
                const text = (btn.textContent || '').toLowerCase();
                const label = (btn.getAttribute('aria-label') || '').toLowerCase();
                const testId = (btn.getAttribute('data-testid') || '').toLowerCase();
                const title = (btn.getAttribute('title') || '').toLowerCase();
                const isMatch = text.includes('stop') || text.includes('cancel') || text.includes('disconnect') ||
                                label.includes('stop') || label.includes('cancel') || label.includes('disconnect') ||
                                testId.includes('stop') || testId.includes('cancel') ||
                                title.includes('stop') || title.includes('cancel') || title.includes('disconnect');
                if (isMatch) {
                    const style = window.getComputedStyle(btn);
                    if (style.display !== 'none' && style.visibility !== 'hidden') {
                        btn.click();
                        return { success: true };
                    }
                }
            }
            return { success: false };
        })()`;

        return this.evaluateInContexts(script, 'success');
    }

    async clickAction(action: string, occurrenceIndex: number = 0, agId?: string): Promise<boolean> {
        const escapedAction = JSON.stringify(action.toLowerCase());
        const escapedAgId = agId ? JSON.stringify(agId) : 'undefined';
        const script = `(async () => {
            const dispatchClick = (el) => {
                const trigger = (type) => {
                    const evt = new MouseEvent(type, { bubbles: true, cancelable: true, view: window });
                    el.dispatchEvent(evt);
                };
                
                // If it is a label option, also trigger click/change directly on the associated input
                if (el.tagName === 'LABEL') {
                    const htmlLabel = el;
                    const inputId = htmlLabel.getAttribute('for');
                    let input = null;
                    if (inputId) {
                        input = document.getElementById(inputId);
                    } else {
                        input = htmlLabel.querySelector('input');
                    }
                    if (input) {
                        input.click();
                        input.checked = true; // force selection
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }
                
                // If it is a parent element containing an input (like a custom choice div), click that input too
                const childInput = el.querySelector('input[type="radio"], input[type="checkbox"]');
                if (childInput && childInput !== el) {
                    childInput.click();
                    childInput.checked = true;
                    childInput.dispatchEvent(new Event('input', { bubbles: true }));
                    childInput.dispatchEvent(new Event('change', { bubbles: true }));
                }

                
                trigger('mousedown');
                trigger('mouseup');
                trigger('click');
            };

            if (${escapedAgId} !== 'undefined') {
                const el = document.querySelector('[data-ag-id="' + ${escapedAgId} + '"]');
                if (el) {
                    dispatchClick(el);
                    return { success: true };
                }
            }

            const findAndClick = () => {
                const buttons = document.querySelectorAll('button, [role="button"], [role="option"], [role="menuitem"], a');
                const matches = [];
                for (const btn of buttons) {
                    const text = (btn.textContent || '').trim().toLowerCase();
                    const label = (btn.getAttribute('aria-label') || '').trim().toLowerCase();
                    const testid = (btn.getAttribute('data-testid') || '').trim().toLowerCase();
                    const style = window.getComputedStyle(btn);
                    const isVisible = style.display !== 'none' && style.visibility !== 'hidden';
                    if ((text.includes(${escapedAction}) || label.includes(${escapedAction}) || testid.includes(${escapedAction})) && isVisible) {
                        matches.push(btn);
                    }
                }
                if (matches.length > ${occurrenceIndex}) {
                    let target = matches[${occurrenceIndex}];
                    dispatchClick(target);
                    return true;
                }
                return false;
            };

            // First attempt to find and click the element
            if (findAndClick()) {
                return { success: true };
            }

            // If not found, check if we need to open the past conversations list
            const toggle = document.querySelector('[data-past-conversations-toggle="true"]');
            if (toggle) {
                toggle.click();
                await new Promise(r => setTimeout(r, 450));
                if (findAndClick()) {
                    return { success: true };
                }
            }

            return { success: false };
        })()`;

        return this.evaluateInContexts(script, 'success');
    }

    async formInput(agId: string, value: string, checked: boolean): Promise<boolean> {
        const escapedAgId = JSON.stringify(agId);
        const escapedValue = JSON.stringify(value);
        const script = `(() => {
            const el = document.querySelector('[data-ag-id="' + ${escapedAgId} + '"]');
            if (el) {
                if (el.type === 'checkbox' || el.type === 'radio') {
                    el.checked = ${checked};
                } else {
                    el.value = ${escapedValue};
                }
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return { success: true };
            }
            return { success: false };
        })()`;

        return this.evaluateInContexts(script, 'success');
    }

    /**
     * Set the AI model
     */
    async setModel(model: string): Promise<boolean> {
        const cleanQuery = model.toLowerCase().replace(/[^a-z0-9]/g, '');
        const escapedQuery = JSON.stringify(cleanQuery);
        const script = `(async () => {
            // Find and click the model selector
            const selectors = document.querySelectorAll('button, [role="button"], [role="combobox"]');
            for (const sel of selectors) {
                const text = (sel.textContent || '').toLowerCase();
                const style = window.getComputedStyle(sel);
                const isVisible = style.display !== 'none' && style.visibility !== 'hidden';
                if ((text.includes('gemini') || text.includes('claude') || text.includes('gpt') || text.includes('model')) && isVisible) {
                    sel.click();
                    await new Promise(r => setTimeout(r, 350));
                    
                    // Find the option in dropdown
                    const options = document.querySelectorAll('[role="option"], [role="menuitem"], li, button');
                    for (const opt of options) {
                        const optTextClean = (opt.textContent || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                        if (optTextClean.includes(${escapedQuery})) {
                            opt.click();
                            return { success: true };
                        }
                    }
                    // Close the dropdown if option was not found to avoid UI clutter
                    sel.click();
                    return { success: false, error: 'Model option not found for ' + ${escapedQuery} };
                }
            }
            return { success: false, error: 'Model selector not found' };
        })()`;

        return this.evaluateInContexts(script, 'success');
    }

    /**
     * Set the mode (Fast/Planning)
     */
    async setMode(mode: string): Promise<boolean> {
        const escapedMode = JSON.stringify(mode.toLowerCase());
        const script = `(async () => {
            const elements = document.querySelectorAll('button, [role="button"], [role="tab"], [role="switch"]');
            for (const el of elements) {
                const text = (el.textContent || '').toLowerCase();
                const label = (el.getAttribute('aria-label') || '').toLowerCase();
                const style = window.getComputedStyle(el);
                const isVisible = style.display !== 'none' && style.visibility !== 'hidden';
                if ((text.includes(${escapedMode}) || label.includes(${escapedMode})) && isVisible) {
                    el.click();
                    return { success: true };
                }
            }
            return { success: false };
        })()`;

        return this.evaluateInContexts(script, 'success');
    }

    /**
     * Start a new chat
     */
    async startNewChat(): Promise<boolean> {
        const script = `(() => {
            const btns = document.querySelectorAll('a, button, [role="button"], [data-testid*="new" i], [data-testid*="clear" i]');
            for (const btn of btns) {
                const text = (btn.textContent || '').toLowerCase();
                const label = (btn.getAttribute('aria-label') || '').toLowerCase();
                const testId = (btn.getAttribute('data-testid') || '').toLowerCase();
                const title = (btn.getAttribute('title') || '').toLowerCase();
                const isMatch = text.includes('new chat') || text.includes('new conversation') || text.includes('new session') || text.includes('new thread') || text.includes('clear chat') || text.includes('clear conversation') ||
                                label.includes('new chat') || label.includes('new conversation') || label.includes('new session') || label.includes('new thread') || label.includes('clear chat') || label.includes('clear conversation') ||
                                testId.includes('new-chat') || testId.includes('new-conversation') || testId.includes('new-session') || testId.includes('clear-chat') ||
                                title.includes('new chat') || title.includes('new conversation') || title.includes('new session') || title.includes('new thread') || title.includes('clear chat') || title.includes('clear conversation');
                if (isMatch) {
                    const style = window.getComputedStyle(btn);
                    if (style.display !== 'none' && style.visibility !== 'hidden') {
                        btn.click();
                        return { success: true };
                    }
                }
            }
            return { success: false };
        })()`;

        return this.evaluateInContexts(script, 'success');
    }

    async getAppState(): Promise<AppState> {
        const script = `(() => {
            let model = 'unknown';
            let mode = 'unknown';
            let chatStatus = 'unknown';
            let hasPendingActions = false;

            // Detect model from UI
            const modelBtn = document.querySelector('[aria-label*="Select model, current:"]');
            if (modelBtn) {
                const text = (modelBtn.textContent || '').trim();
                if (text) model = text;
            } else {
                const allText = document.body.innerText.toLowerCase();
                if (allText.includes('gemini')) model = 'gemini';
                else if (allText.includes('claude')) model = 'claude';
                else if (allText.includes('gpt')) model = 'gpt';
            }

            // Detect mode
            const modeElements = document.querySelectorAll('[role="tab"][aria-selected="true"], .active');
            for (const el of modeElements) {
                const text = (el.textContent || '').toLowerCase();
                if (text.includes('fast') || text.includes('planning')) {
                    mode = text.includes('fast') ? 'fast' : 'planning';
                }
            }

            // Detect chat status
            const chatContainer = document.getElementById('conversation') || document.getElementById('chat') || document.getElementById('cascade');
            chatStatus = chatContainer ? 'open' : 'closed';

            // Detect pending actions (limit checks to buttons in the last few messages/prompts of the chat list)
            if (chatContainer) {
                const children = Array.from(chatContainer.children);
                // Look at the last 2 messages/prompts to capture active prompts
                const lastTwo = children.slice(-2);
                for (const container of lastTwo) {
                    const actionBtns = container.querySelectorAll('button');
                    for (const btn of actionBtns) {
                        const text = (btn.textContent || '').toLowerCase();
                        // Only match security-related permission buttons to trigger the client banner
                        if (text.includes('allow') || text.includes('deny') || text.includes('approve')) {
                            const style = window.getComputedStyle(btn);
                            if (style.display !== 'none' && style.visibility !== 'hidden') {
                                hasPendingActions = true;
                                break;
                            }
                        }
                    }
                    if (hasPendingActions) break;
                }
            // Detect if agent is generating/working (stop button is visible)
            let isGenerating = false;
            try {
                const stopBtns = document.querySelectorAll('a, button, [role="button"], [data-testid*="stop" i], [id*="stop" i]');
                for (const btn of stopBtns) {
                    const text = (btn.textContent || '').toLowerCase();
                    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
                    const testId = (btn.getAttribute('data-testid') || '').toLowerCase();
                    const title = (btn.getAttribute('title') || '').toLowerCase();
                    const isMatch = text.includes('stop') || text.includes('cancel') ||
                                    label.includes('stop') || label.includes('cancel') ||
                                    testId.includes('stop') || testId.includes('cancel') ||
                                    title.includes('stop') || title.includes('cancel');
                    if (isMatch) {
                        const style = window.getComputedStyle(btn);
                        if (style.display !== 'none' && style.visibility !== 'hidden') {
                            isGenerating = true;
                            break;
                        }
                    }
                }
            } catch(e) {}

            return { model, mode, chatStatus, hasPendingActions, isGenerating };
        })()`;

        // Try the default context first (omitting contextId)
        try {
            const result = await this.call('Runtime.evaluate', {
                expression: script,
                returnByValue: true
            }) as { result?: { value?: AppState }; exceptionDetails?: unknown };

            if (!result.exceptionDetails && result.result?.value) {
                return result.result.value;
            }
        } catch { /* ignore and fallback */ }

        for (const ctx of this.contexts) {
            try {
                const result = await this.call('Runtime.evaluate', {
                    expression: script,
                    returnByValue: true,
                    contextId: ctx.id
                }) as { result?: { value?: AppState }; exceptionDetails?: unknown };

                if (!result.exceptionDetails && result.result?.value) {
                    return result.result.value;
                }
            } catch { /* try next context */ }
        }

        return { model: 'unknown', mode: 'unknown', chatStatus: 'unknown', hasPendingActions: false };
    }

    async getChatHistory(): Promise<{ title: string; time: string }[]> {
        const script = `(async () => {
            const toggle = document.querySelector('[data-past-conversations-toggle="true"]');
            let listbox = document.getElementById('fastpick-listbox');
            
            if (!listbox && toggle) {
                toggle.click();
                await new Promise(r => setTimeout(r, 450));
                listbox = document.getElementById('fastpick-listbox');
            }
            
            if (!listbox) return [];
            
            const historyItems = listbox.querySelectorAll('[role="option"]');
            const items = [];
            for (const item of historyItems) {
                const titleEl = item.querySelector('.flex-1') || item.firstElementChild || item;
                const timeEl = item.querySelector('.text-xs, span[class*="opacity-50"]');
                const title = (titleEl.textContent || '').trim();
                const time = timeEl ? (timeEl.textContent || '').trim() : '';
                if (title && title.length < 200) {
                    items.push({ title, time });
                }
            }
            
            // Close the quick pick after scanning to avoid leaving it open
            if (toggle) {
                toggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            }
            
            return items;
        })()`;

        // Try the default context first (omitting contextId)
        try {
            const result = await this.call('Runtime.evaluate', {
                expression: script,
                returnByValue: true,
                awaitPromise: true
            }) as { result?: { value?: { title: string; time: string }[] } };

            if (result.result?.value && Array.isArray(result.result.value)) {
                return result.result.value;
            }
        } catch { /* ignore and fallback */ }

        for (const ctx of this.contexts) {
            try {
                const result = await this.call('Runtime.evaluate', {
                    expression: script,
                    returnByValue: true,
                    awaitPromise: true,
                    contextId: ctx.id
                }) as { result?: { value?: { title: string; time: string }[] } };

                if (result.result?.value && Array.isArray(result.result.value)) {
                    return result.result.value;
                }
            } catch { /* try next context */ }
        }

        return [];
    }

    /**
     * Sync scroll position from mobile
     */
    async remoteScroll(scrollTop: number): Promise<void> {
        const script = `(() => {
            const container = document.querySelector('.overflow-y-auto, [data-scroll-area]');
            if (container) {
                container.scrollTop = ${scrollTop};
            }
        })()`;

        for (const ctx of this.contexts) {
            try {
                await this.call('Runtime.evaluate', {
                    expression: script,
                    contextId: ctx.id
                });
                return;
            } catch { /* try next */ }
        }
    }

    /**
     * Dispatch a keyboard event (e.g., Escape to close history)
     */
    async dispatchKey(key: string): Promise<void> {
        try {
            await this.call('Input.dispatchKeyEvent', {
                type: 'keyDown',
                key,
                code: key === 'Escape' ? 'Escape' : key,
                windowsVirtualKeyCode: key === 'Escape' ? 27 : 0
            });
            await this.call('Input.dispatchKeyEvent', {
                type: 'keyUp',
                key,
                code: key === 'Escape' ? 'Escape' : key,
                windowsVirtualKeyCode: key === 'Escape' ? 27 : 0
            });
        } catch (error) {
            logError('Failed to dispatch key event', error);
        }
    }

    // --- Internal helpers ---

    private async evaluateInContexts(script: string, successKey: string): Promise<boolean> {
        // Try the default context first (omitting contextId)
        try {
            const result = await this.call('Runtime.evaluate', {
                expression: script,
                returnByValue: true,
                awaitPromise: true
            }) as { result?: { value?: Record<string, unknown> }; exceptionDetails?: unknown };

            if (!result.exceptionDetails && result.result?.value && result.result.value[successKey]) {
                return true;
            }
        } catch { /* ignore and fallback */ }

        for (const ctx of this.contexts) {
            try {
                const result = await this.call('Runtime.evaluate', {
                    expression: script,
                    returnByValue: true,
                    awaitPromise: true,
                    contextId: ctx.id
                }) as { result?: { value?: Record<string, unknown> }; exceptionDetails?: unknown };

                if (result.exceptionDetails) { continue; }
                if (result.result?.value && result.result.value[successKey]) {
                    return true;
                }
            } catch { /* try next context */ }
        }
        return false;
    }

    private getCaptureScript(): string {
        return `(async () => {
            // --- Step 1: Find the chat messages container ---
            //
            // Strategy: locate the agent input (contenteditable / lexical editor) which
            // sendMessage() already proves is present in the correct context, then walk
            // UP the DOM to find the scrollable messages container that sits above it.
            // Fall back to known IDs and the largest scrollable div as a last resort.

            function findMessagesContainer() {
                // Strict check: if this context doesn't have the agent panel, bail early
                const hasAgentPanel = !!document.querySelector('.antigravity-agent-side-panel') || 
                                      !!document.getElementById('conversation') ||
                                      !!document.getElementById('chat') ||
                                      !!document.querySelector('[data-testid="chat-messages"]');
                if (!hasAgentPanel) {
                    return null;
                }

                // Priority 1: Specific conversation/messages containers — NOT the whole panel.
                // The whole panel includes the input area, model selector and disclaimer, which
                // we do NOT want in the snapshot (our custom UI handles those).
                const specific = 
                    document.querySelector('.antigravity-agent-side-panel #conversation') ||
                    document.getElementById('conversation') ||
                    document.getElementById('chat') ||
                    document.getElementById('cascade') ||
                    document.querySelector('[data-testid="chat-messages"]') ||
                    document.querySelector('[data-testid="conversation"]') ||
                    document.querySelector('.chat-container') ||
                    document.querySelector('.conversation-container') ||
                    document.querySelector('.messages-container') ||
                    document.querySelector('.agent-chat');
                
                if (specific) {
                    return specific;
                }

                // Priority 2: Anchor on the visible input (contenteditable / lexical editor),
                // then walk UP the DOM to find the SIBLING scrollable messages area that sits
                // above the input. This returns ONLY the messages, leaving the input section,
                // model selector and disclaimer outside the captured container.
                const editors = Array.from(
                    document.querySelectorAll('.antigravity-agent-side-panel [contenteditable="true"], .antigravity-agent-side-panel [data-lexical-editor], [contenteditable="true"], [data-lexical-editor]')
                ).filter(el => {
                    const s = window.getComputedStyle(el);
                    const isMainEditor = el.closest('.monaco-editor') || el.closest('.editor-container');
                    return s.display !== 'none' && s.visibility !== 'hidden' && !isMainEditor;
                });

                if (editors.length > 0) {
                    const editor = editors[0];
                    let el = editor.parentElement;
                    for (let i = 0; i < 15; i++) {
                        if (!el || el === document.body || el === document.documentElement) break;
                        // Look for a PRECEDING sibling that is overflow:scroll/auto.
                        // Accept it even when empty (clientHeight > 0 is the only requirement)
                        // so that the empty-chat state still isolates the messages area correctly.
                        let sib = el.previousElementSibling;
                        while (sib) {
                            const s = window.getComputedStyle(sib);
                            if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && sib.clientHeight > 0) {
                                return sib;
                            }
                            // Sibling might wrap the scrollable child one level down
                            const scrollChild = sib.querySelector('div, section, main');
                            if (scrollChild) {
                                const sc = window.getComputedStyle(scrollChild);
                                if ((sc.overflowY === 'auto' || sc.overflowY === 'scroll') && scrollChild.clientHeight > 0) {
                                    return scrollChild;
                                }
                            }
                            sib = sib.previousElementSibling;
                        }
                        // If the parent itself is a unified scroll container (messages+input combined),
                        // use it as the container — input stripping will clean it up
                        const ps = window.getComputedStyle(el);
                        if ((ps.overflowY === 'auto' || ps.overflowY === 'scroll') && el.scrollHeight > 200) {
                            return el;
                        }
                        el = el.parentElement;
                    }
                    // Anchor found but walk couldn't isolate messages — fall through to panel
                }


                // Priority 3: Whole panel as last resort (strip phase will clean up input/footer)
                const panel = document.querySelector('.antigravity-agent-side-panel');
                if (panel) return panel;

                // Priority 4: Largest scrollable div in the page
                const scrollables = Array.from(document.querySelectorAll('div')).filter(el => {
                    const s = window.getComputedStyle(el);
                    return (s.overflowY === 'auto' || s.overflowY === 'scroll') &&
                           el.scrollHeight > 200 && el.children.length > 0;
                });
                return scrollables.sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || null;
            }

            const cascade = findMessagesContainer();
            if (!cascade) {
                return { error: 'chat container not found' };
            }

            // Assign unique IDs to interactive elements in the real DOM
            try {
                const interactive = cascade.querySelectorAll(
                    'button, input, textarea, select, a, summary, details, li, label, ' +
                    '[role], [onclick], [class*="option"], [class*="item"], [class*="btn"], [class*="choice"], [class*="card"]'
                );
                interactive.forEach((el, index) => {
                    el.setAttribute('data-ag-id', index.toString());
                });

                // Tag primary/secondary action buttons
                cascade.querySelectorAll('button').forEach(btn => {
                    const text = (btn.textContent || '').trim().toLowerCase();
                    if (text.includes('worked for') || text.includes('exploring') || text.includes('thinking') || text.includes('analyzing')) {
                        btn.classList.add('ag-hoverable');
                        return;
                    }
                    if (text.includes('proceed') || text.includes('submit') || text.includes('approve') || text.includes('yes') || text.includes('allow')) {
                        btn.classList.add('ag-btn-primary');
                    } else if (text.includes('skip') || text.includes('no') || text.includes('deny')) {
                        btn.classList.add('ag-btn-secondary');
                    }
                });

                // Sync form element properties (checked, value, selected) to attributes in the real DOM
                // so they are serialized correctly by cloneNode(true).
                cascade.querySelectorAll('input, select, textarea').forEach(el => {
                    if (el.tagName === 'INPUT') {
                        const input = el;
                        if (input.type === 'checkbox' || input.type === 'radio') {
                            if (input.checked) {
                                input.setAttribute('checked', '');
                            } else {
                                input.removeAttribute('checked');
                            }
                        } else {
                            input.setAttribute('value', input.value || '');
                        }
                    } else if (el.tagName === 'TEXTAREA') {
                        el.textContent = el.value || '';
                    } else if (el.tagName === 'SELECT') {
                        const select = el;
                        Array.from(select.options).forEach(opt => {
                            if (opt.selected) {
                                opt.setAttribute('selected', '');
                            } else {
                                opt.removeAttribute('selected');
                            }
                        });
                    }
                });

                // Tag list items and options in the approval dialog as hoverable and selected
                cascade.querySelectorAll('li, [role="option"], [role="radio"], [class*="option"], [class*="choice"]').forEach(el => {
                    el.classList.add('ag-hoverable');
                    
                    const isSelected = el.getAttribute('aria-selected') === 'true' || 
                                       el.getAttribute('aria-checked') === 'true' ||
                                       el.classList.contains('selected') ||
                                       el.classList.contains('active') ||
                                       !!el.querySelector('input:checked');
                    if (isSelected) {
                        el.classList.add('ag-selected');
                    }
                });


                // Tag user messages directly using VS Code's own aria-labels and testids
                cascade.querySelectorAll(
                    '[aria-label*="User message" i], ' +
                    '[data-testid*="user-input" i], ' +
                    '[data-testid*="user-message" i], ' +
                    '.user-message, ' +
                    '[class*="user-message"]'
                ).forEach(el => {
                    // EXCLUDE divider / spacer elements
                    const cls = (el.className || '').toString().toLowerCase();
                    if (el.getAttribute('aria-hidden') === 'true' || cls.includes('h-px') || cls.includes('divider')) {
                        return;
                    }
                    // Tag the leaf content container for neat bubble styling
                    let target = el;
                    const leaf = el.querySelector('p, span, [data-testid="user-input-step"]');
                    if (leaf) target = leaf;
                    target.setAttribute('data-ag-turn', 'user');
                });

                // Tag agent responses directly using VS Code's own aria-labels
                cascade.querySelectorAll(
                    '[aria-label*="Agent response" i], ' +
                    '[data-testid*="agent-response" i], ' +
                    '.agent-response, ' +
                    '[class*="agent-response"]'
                ).forEach(el => {
                    el.setAttribute('data-ag-turn', 'agent');
                });

                // Hide empty divider divs / spacer anchors that VS Code places between rows
                // to prevent them from showing background or padding lines
                cascade.querySelectorAll('div[aria-hidden="true"], div.h-px, div.h-2').forEach(el => {
                    const htmlEl = el;
                    htmlEl.style.display = 'none';
                    htmlEl.style.padding = '0';
                    htmlEl.style.margin = '0';
                    htmlEl.style.height = '0';
                });
            } catch(e) {}

            const cascadeStyles = window.getComputedStyle(cascade);
            const scrollContainer = cascade.querySelector('.overflow-y-auto, [data-scroll-area]') || cascade;
            const scrollInfo = {
                scrollTop: scrollContainer.scrollTop,
                scrollHeight: scrollContainer.scrollHeight,
                clientHeight: scrollContainer.clientHeight,
                scrollPercent: scrollContainer.scrollTop / (scrollContainer.scrollHeight - scrollContainer.clientHeight) || 0
            };

            // Mark fixed/absolute elements before cloning
            const candidates = cascade.querySelectorAll('*');
            candidates.forEach(el => {
                try {
                    const style = window.getComputedStyle(el);
                    const pos = style.position;
                    if (pos === 'fixed' || pos === 'absolute') {
                        const w = parseFloat(style.width);
                        const h = parseFloat(style.height);
                        const cls = (el.className || '').toString().toLowerCase();
                        const tag = el.tagName.toLowerCase();
                        if (
                            cls.includes('icon') || cls.includes('logo') || cls.includes('symbol') || cls.includes('spinner') || 
                            cls.includes('avatar') || cls.includes('badge') || tag === 'svg' || tag === 'img' ||
                            (!isNaN(w) && w <= 32) || (!isNaN(h) && h <= 32)
                        ) {
                            el.setAttribute('data-ag-keep-pos', 'true');
                        } else {
                            el.setAttribute('data-ag-rem', 'true');
                        }
                    }
                } catch(e) {}
            });

            const clone = cascade.cloneNode(true);
            candidates.forEach(el => {
                el.removeAttribute('data-ag-rem');
                el.removeAttribute('data-ag-keep-pos');
            });

            // Reset the root clone element's inline positioning styles to render beautifully on mobile
            try {
                clone.style.position = 'static';
                clone.style.left = 'auto';
                clone.style.top = 'auto';
                clone.style.width = '100%';
                clone.style.height = 'auto';
                clone.style.minHeight = '100%';
                clone.style.transform = 'none';
            } catch(e) {}

            // ─── Pre-strip: Remove the entire input section block ──────────────────────────────
            // The Antigravity panel puts messages, input, and disclaimer in the same scroll
            // container. We use the contenteditable as an anchor: walk UP until we reach a
            // node that also contains tagged message content, then remove everything from
            // that boundary node DOWNWARD (input wrapper + all following siblings = disclaimer).
            // This runs BEFORE absoluteSelectors so the editor element is still present as anchor.
            try {
                // Helper to check if an element is inside a message/turn
                const isMsgEl = (el) => {
                    return !!(
                        el.closest('[data-ag-turn]') ||
                        el.closest('.message') ||
                        el.closest('[data-ag-id*="turn"]') ||
                        el.closest('.user-message') ||
                        el.closest('.agent-response') ||
                        el.closest('[class*="message"]') ||
                        el.closest('[class*="Message"]') ||
                        el.closest('[class*="turn"]') ||
                        el.closest('[class*="Turn"]')
                    );
                };

                let inputEl = null;
                const primaryCandidates = clone.querySelectorAll(
                    '[contenteditable="true"], [data-lexical-editor], [role="textbox"], ' +
                    '.chat-input-part, .interactive-input-part, [class*="input-part"], [class*="inputPart"], ' +
                    'button[aria-label*="stop" i], button[title*="stop" i], button[data-tooltip-id*="stop" i], ' +
                    '[class*="stop-button"], [class*="stopButton"], [id*="stop-button"], [id*="stopButton"]'
                );
                for (const cand of primaryCandidates) {
                    if (!isMsgEl(cand)) {
                        inputEl = cand;
                        break;
                    }
                }
                
                // Fallback 1: Look for any SVG with a rect element (stop icon)
                if (!inputEl) {
                    const svgs = clone.querySelectorAll('svg');
                    for (const svg of svgs) {
                        if (svg.querySelector('rect') && !isMsgEl(svg)) {
                            inputEl = svg.closest('button') || svg.closest('[role="button"]') || svg.parentElement || svg;
                            break;
                        }
                    }
                }
                
                // Fallback 2: Look for elements with class containing 'stop' or text containing 'stop'
                if (!inputEl) {
                    const candidates = clone.querySelectorAll('button, [role="button"], a');
                    for (const cand of candidates) {
                        if (isMsgEl(cand)) continue;
                        const txt = (cand.textContent || '').toLowerCase();
                        const cls = (cand.className || '').toString().toLowerCase();
                        const aria = (cand.getAttribute('aria-label') || '').toLowerCase();
                        if (txt.includes('stop') || cls.includes('stop') || aria.includes('stop') ||
                            txt.includes('cancel') || cls.includes('cancel') || aria.includes('cancel')) {
                            inputEl = cand;
                            break;
                        }
                    }
                }

                // Fallback 3: Text matching (for when input is idle/empty)
                if (!inputEl) {
                    const targetTexts = ['ask anything', '@ to mention', 'ai may make mistakes'];
                    const candidates = Array.from(clone.querySelectorAll('p, span, div, footer'));
                    for (const cand of candidates) {
                        if (isMsgEl(cand)) continue;
                        const txt = (cand.textContent || '').toLowerCase();
                        if (targetTexts.some(t => txt.includes(t))) {
                            inputEl = cand;
                            break;
                        }
                    }
                }

                if (inputEl) {
                    let section = inputEl;
                    for (let i = 0; i < 10; i++) {
                        const parent = section.parentElement;
                        if (!parent || parent === clone) break;
                        // Stop walking up if this ancestor also contains tagged message content
                        const hasMsgs = parent.querySelector('[data-ag-turn]') ||
                                        parent.querySelector('[aria-label*="Agent response" i]') ||
                                        parent.querySelector('[aria-label*="User message" i]') ||
                                        parent.querySelector('.user-message') ||
                                        parent.querySelector('.agent-response');
                        
                        // Stop walking up if the parent contains approval/permission actions or text
                        const txt = (parent.textContent || '').toLowerCase();
                        const hasApproval = txt.includes('allow running') || 
                                            txt.includes('allow this time') || 
                                            txt.includes('allow once') || 
                                            txt.includes('allow always') ||
                                            txt.includes('action requires your attention') ||
                                            txt.includes('allow running this command') ||
                                            txt.includes('yes, allow') ||
                                            txt.includes('yes, and always allow') ||
                                            parent.querySelector('[class*="approval"]') ||
                                            parent.querySelector('[id*="approval"]') ||
                                            parent.querySelector('[class*="permission"]') ||
                                            parent.querySelector('[id*="permission"]') ||
                                            parent.querySelector('button[aria-label*="allow" i]') ||
                                            parent.querySelector('button[aria-label*="deny" i]') ||
                                            parent.querySelector('button[aria-label*="approve" i]');
                                            
                        if (hasMsgs || hasApproval) break;
                        section = parent;
                    }
                    if (section && section !== clone) {
                        // Only remove the input section itself, do not blindly remove siblings
                        // as they might contain overlay elements (like the approval card)
                        section.remove();
                    }
                }
            } catch(e) {}

            // ─── Pre-strip: Remove panel title / project name heading ─────────────────────────
            // The panel renders a project/chat title (e.g. "InfluenzeAI_Agent") above the
            // messages. Remove any h1-h3 / title-class element that is NOT inside a message.
            try {
                clone.querySelectorAll('h1, h2, h3, [class*="panel-title"], [class*="chat-title"]').forEach(el => {
                    if (!el.closest('[data-ag-turn]') && !el.querySelector('[data-ag-turn]')) {
                        el.remove();
                    }
                });
            } catch(e) {}

            // Clean up editors and input areas from the clone
            try {
                // Absolute selectors: elements that are ALWAYS textboxes/editors or task toolbars and should be stripped
                const absoluteSelectors = [
                    '[contenteditable="true"]', '[data-lexical-editor]',
                    '[role="textbox"]',
                    'textarea',
                    '.outline-solid',
                    '[class*="outline-solid"]',
                    // Strip the unnecessary context/quick action buttons at the bottom of the chat pane (Image 4 icons)
                    'button[aria-label*="context" i]',
                    'button[aria-label*="terminal" i]',
                    'button[aria-label*="rule" i]',
                    'button[aria-label*="conversation" i]',
                    'button[data-tooltip-id*="context" i]',
                    'button[data-tooltip-id*="terminal" i]',
                    'button[data-tooltip-id*="rule" i]',
                    'button[data-tooltip-id*="conversation" i]',
                    'button[title*="context" i]',
                    'button[title*="terminal" i]',
                    'button[title*="rule" i]',
                    'button[title*="conversation" i]',
                    // Strip the unnecessary inline utility buttons (copy, globe, CLI, revert, undo, feedback)
                    'button[aria-label*="copy" i]',
                    'button[aria-label*="globe" i]',
                    'button[aria-label*="browser" i]',
                    'button[aria-label*="cli" i]',
                    'button[aria-label*="revert" i]',
                    'button[aria-label*="undo" i]',
                    'button[aria-label*="good" i]',
                    'button[aria-label*="bad" i]',
                    'button[aria-label*="thumbs" i]',
                    'button[data-tooltip-id*="copy" i]',
                    'button[data-tooltip-id*="browser" i]',
                    'button[data-tooltip-id*="cli" i]',
                    'button[data-tooltip-id*="undo" i]',
                    'button[data-tooltip-id*="feedback" i]',
                    'button[title*="copy" i]',
                    'button[title*="browser" i]',
                    'button[title*="cli" i]',
                    'button[title*="undo" i]'
                ];
                absoluteSelectors.forEach(selector => {
                    clone.querySelectorAll(selector).forEach(el => {
                        // Remove only the element itself or its immediate input wrapper.
                        // Do not walk up multiple levels to avoid removing adjacent elements (like the approval box).
                        let target = el;
                        const parent = el.parentElement;
                        if (parent && parent !== clone) {
                            const cls = (parent.className || '').toString().toLowerCase();
                            // Walk up to input wrappers or task toolbar container outer wrappers (px-2)
                            if (cls.includes('editor-wrapper') || cls.includes('textbox-container') || cls.includes('px-2')) {
                                target = parent;
                            }
                        }
                        if (target !== clone) target.remove();
                        else el.remove();
                    });
                });

                // Conditional selectors: elements that are layout forms or bottom bars, which are only removed if they don't contain action flow elements
                const conditionalSelectors = [
                    'form', '.fixed.bottom-0', '.absolute.bottom-0'
                ];
                conditionalSelectors.forEach(selector => {
                    clone.querySelectorAll(selector).forEach(el => {
                        const text = (el.textContent || '').toLowerCase();
                        if (
                            text.includes('allow') || 
                            text.includes('deny') || 
                            text.includes('review') ||
                            text.includes('plan') ||
                            text.includes('walkthrough') ||
                            text.includes('approve') ||
                            text.includes('revert') ||
                            text.includes('comment') ||
                            text.includes('changes')
                        ) return;
                        
                        // Remove the element directly rather than walking up and deleting siblings
                        el.remove();
                    });
                });

                // Remove fixed/absolute overlays marked before clone
                clone.querySelectorAll('[data-ag-rem]').forEach(el => {
                    const text = (el.textContent || '').toLowerCase();
                    if (
                        text.includes('allow') || 
                        text.includes('deny') || 
                        text.includes('review') ||
                        text.includes('plan') ||
                        text.includes('walkthrough') ||
                        text.includes('approve') ||
                        text.includes('revert') ||
                        text.includes('comment') ||
                        text.includes('changes')
                    ) {
                        el.removeAttribute('data-ag-rem');
                        return;
                    }
                    el.remove();
                });
            } catch (e) {}

            // Strip VS Code's chat toolbar container, mic, and utility buttons (copy, browser, CLI)
            try {
                const toolbarSelectors = [
                    '.chat-input-part',
                    '.interactive-input-part',
                    '.chat-input-toolbars',
                    '.interactive-input-and-actions',
                    '.chat-input-actions',
                    '.chat-actions',
                    '[class*="chatInput"]',
                    '[class*="chat-input"]',
                    '[class*="inputEditor"]',
                    '[class*="input-editor"]',
                    '[class*="chat-actions"]',
                    '[class*="chatActions"]',
                    '[class*="actions-container"]',
                    '[class*="actionsContainer"]',
                    '[class*="toolbar"]',
                    // Strip utility button groups directly
                    'button[aria-label*="copy" i]',
                    'button[aria-label*="globe" i]',
                    'button[aria-label*="browser" i]',
                    'button[aria-label*="chrome" i]',
                    'button[aria-label*="cli" i]',
                    'button[aria-label*="terminal" i]',
                    'button[aria-label*="mic" i]',
                    'button[aria-label*="voice" i]',
                    'button[aria-label*="speech" i]',
                    'button[data-tooltip-id*="copy" i]',
                    'button[data-tooltip-id*="browser" i]',
                    'button[data-tooltip-id*="cli" i]',
                    'button[title*="copy" i]',
                    'button[title*="browser" i]',
                    'button[title*="cli" i]',
                    'button[title*="chrome" i]',
                    'button[title*="mic" i]',
                    'button[title*="voice" i]',
                    // General mic/disclaimer elements
                    '[class*="voice"]',
                    '[class*="microphone"]',
                    '.chat-disclaimer',
                    '[class*="disclaimer"]',
                ];
                toolbarSelectors.forEach(sel => {
                    clone.querySelectorAll(sel).forEach(el => { el.remove(); });
                });
                // Also strip any elements that look like model toolbars or chat selectors
                clone.querySelectorAll('div, section, button, a').forEach((el) => {
                    const htmlEl = el;
                    const text = (htmlEl.textContent || '').trim().toLowerCase();
                    const cls = (htmlEl.className || '').toString().toLowerCase();
                    const aria = (htmlEl.getAttribute('aria-label') || '').toLowerCase();
                    const title = (htmlEl.getAttribute('title') || '').toLowerCase();
                    const id = (htmlEl.getAttribute('id') || '').toLowerCase();
                    if (
                        (cls.includes('model') || cls.includes('selector') || aria.includes('model') || aria.includes('select')) &&
                        (text.includes('gemini') || text.includes('claude') || text.includes('gpt')) &&
                        text.length < 200
                    ) {
                        htmlEl.remove();
                    } else if (
                        aria.includes('copy') || aria.includes('chrome') || aria.includes('browser') || aria.includes('cli') || aria.includes('mic') ||
                        title.includes('copy') || title.includes('chrome') || title.includes('browser') || title.includes('cli') || title.includes('mic') ||
                        id.includes('copy') || id.includes('chrome') || id.includes('browser') || id.includes('cli') || id.includes('mic')
                    ) {
                        htmlEl.remove();
                    }
                });

                // Also strip task control toolbars and outline-solid file bars
                try {
                    // Match unique sub-buttons
                    const subButtons = clone.querySelectorAll(
                        '[data-tooltip-id*="changesOverview"], ' +
                        '[data-tooltip-id*="terminal"], ' +
                        '[data-tooltip-id*="artifacts"], ' +
                        '[data-tooltip-id*="browser"]'
                    );
                    subButtons.forEach((btn) => {
                        // Find the closest outline-solid task toolbar wrapper
                        const toolbar = btn.closest('.outline-solid') || btn.closest('[class*="outline-solid"]') || btn.closest('[class*="outline-1"]');
                        if (toolbar) {
                            // Target parent wrapper <div class="px-2"> if present
                            const wrapper = toolbar.parentElement;
                            if (wrapper && wrapper.className.includes('px-2')) {
                                wrapper.remove();
                            } else {
                                toolbar.remove();
                            }
                        }
                    });
                } catch(e) {}
            } catch(e) {}

            // ─── Post-strip: Content-based sweep for any remaining placeholder / disclaimer / input container ───
            try {
                const targetTerms = ['ask anything', '@ to mention', '/ for actions', 'ai may make mistakes', 'double-check all generated code'];
                clone.querySelectorAll('p, span, div, section, footer').forEach(el => {
                    // Do not touch message content
                    if (el.closest('[data-ag-turn]') || el.closest('[data-ag-id]')) return;
                    
                    const text = (el.textContent || '').trim().toLowerCase();
                    const hasMatch = targetTerms.some(t => text.includes(t));
                    if (hasMatch) {
                        let section = el;
                        for (let i = 0; i < 12; i++) {
                            const parent = section.parentElement;
                            if (!parent || parent === clone) break;
                            const hasMsgs = parent.querySelector('[data-ag-turn]') ||
                                            parent.querySelector('[aria-label*="Agent response" i]') ||
                                            parent.querySelector('[aria-label*="User message" i]') ||
                                            parent.querySelector('.user-message') ||
                                            parent.querySelector('.agent-response');
                            
                            const parentTxt = (parent.textContent || '').toLowerCase();
                            const hasApproval = parentTxt.includes('allow running') || 
                                                parentTxt.includes('allow this time') || 
                                                parentTxt.includes('allow once') || 
                                                parentTxt.includes('allow always') ||
                                                parentTxt.includes('action requires your attention') ||
                                                parentTxt.includes('yes, allow') ||
                                                parentTxt.includes('yes, and always allow') ||
                                                parent.querySelector('[class*="approval"]') ||
                                                parent.querySelector('[id*="approval"]') ||
                                                parent.querySelector('[class*="permission"]') ||
                                                parent.querySelector('[id*="permission"]');
                                                
                            if (hasMsgs || hasApproval) break;
                            section = parent;
                        }
                        if (section && section !== clone) {
                            section.remove();
                        } else {
                            el.remove();
                        }
                    }
                });
            } catch(e) {}

            // 1. Flatten absolute/fixed positioning (fixes virtual list row overlaps on mobile)
            // 2. Remove CSS containment constraints (fixes collapsed height)
            // 3. Reset viewport / container query height calculations (fixes container empty scroll heights)
            try {
                clone.querySelectorAll('*').forEach((el) => {
                    const htmlEl = el;
                    if (htmlEl.className && typeof htmlEl.className === 'string') {
                        htmlEl.className = htmlEl.className
                            .replace(/\bborder\b/g, '')
                            .replace(/\bborder-[a-z0-9\/-]+/g, '')
                            .replace(/\bborder-t\b/g, '')
                            .replace(/\bborder-b\b/g, '')
                            .replace(/\bborder-l\b/g, '')
                            .replace(/\bborder-r\b/g, '');
                    }
                    if (htmlEl.style) {
                        htmlEl.style.border = 'none';
                        htmlEl.style.borderWidth = '0';
                        htmlEl.style.borderColor = 'transparent';
                        htmlEl.style.outline = 'none';
                        htmlEl.style.boxShadow = 'none';
                    }
                    if (!htmlEl.style) return;
                    if (htmlEl.getAttribute('data-ag-keep-pos') === 'true') {
                        return;
                    }
                    // Flatten absolute/fixed positioning
                    const pos = htmlEl.style.position;
                    if (pos === 'absolute' || pos === 'fixed' || htmlEl.hasAttribute('data-ag-rem')) {
                        // EXCLUDE small icons / logos / badges from flattening (prevents breaking flex layouts)
                        const w = htmlEl.style.width || '';
                        const h = htmlEl.style.height || '';
                        const cls = (htmlEl.className || '').toString().toLowerCase();
                        if (
                            cls.includes('icon') || cls.includes('logo') || cls.includes('symbol') || cls.includes('spinner') || cls.includes('avatar') ||
                            (w && parseFloat(w) <= 32) || (h && parseFloat(h) <= 32)
                        ) {
                            // Do not flatten tiny logos
                        } else {
                            htmlEl.style.position = 'relative';
                            htmlEl.style.top = 'auto';
                            htmlEl.style.left = 'auto';
                            htmlEl.style.right = 'auto';
                            htmlEl.style.bottom = 'auto';
                            htmlEl.style.transform = 'none';
                            htmlEl.style.zIndex = 'auto';
                            if (!htmlEl.style.width) htmlEl.style.width = '100%';
                            htmlEl.style.height = 'auto';
                            htmlEl.style.minHeight = '0';
                        }
                    }
                    // Reset viewport/container query heights (calc(100cqh - 50px))
                    const minH = htmlEl.style.minHeight;
                    if (minH && (minH.includes('cqh') || minH.includes('vh') || minH.includes('calc'))) {
                        htmlEl.style.minHeight = '0px';
                    }
                    const h = htmlEl.style.height;
                    if (h && (h.includes('cqh') || h.includes('vh') || h.includes('calc'))) {
                        htmlEl.style.height = 'auto';
                    }
                    // Remove containment constraints
                    const styleAttr = htmlEl.getAttribute('style') || '';
                    if (styleAttr.includes('container-type') || styleAttr.includes('contain')) {
                        htmlEl.style.containerType = 'normal';
                        htmlEl.style.contain = 'none';
                    }
                });
            } catch(e) {}

            // Convert local images to base64 so they load on mobile
            const images = clone.querySelectorAll('img');
            const promises = Array.from(images).map(async (img) => {
                const rawSrc = img.getAttribute('src');
                if (rawSrc && (rawSrc.startsWith('/') || rawSrc.startsWith('vscode-file:')) && !rawSrc.startsWith('data:')) {
                    try {
                        const res = await fetch(rawSrc);
                        const blob = await res.blob();
                        await new Promise(r => {
                            const reader = new FileReader();
                            reader.onloadend = () => { img.src = reader.result; r(); };
                            reader.onerror = () => r();
                            reader.readAsDataURL(blob);
                        });
                    } catch(e) {}
                }
            });
            await Promise.all(promises);

            const html = clone.outerHTML;

            // --- Step 2: Collect and sanitize CSS ---
            // Strip rules that reference VS Code-internal URLs (vscode-file://, vscode-resource://)
            // or external CDN resources (@font-face, @import) that fail with 503/401 on mobile.
            const rules = [];
            const blockedPatterns = [
                'vscode-file://', 'vscode-resource://',
                'fonts.googleapis.com', 'fonts.gstatic.com',
                'cdnjs.cloudflare.com', 'cdn.jsdelivr.net'
            ];
            for (const sheet of document.styleSheets) {
                try {
                    for (const rule of sheet.cssRules) {
                        const text = rule.cssText;
                        // Drop @font-face and @import entirely — they load external fonts that fail
                        if (rule.type === CSSRule.FONT_FACE_RULE || rule.type === CSSRule.IMPORT_RULE) {
                            continue;
                        }
                        // Drop any rule that references a blocked URL
                        const hasBlocked = blockedPatterns.some(p => text.includes(p));
                        if (hasBlocked) { continue; }
                        rules.push(text);
                    }
                } catch (e) {}
            }
            // Inject safe fallback font stack so text is readable without external fonts
            rules.unshift('* { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important; }');

            // Resolve VS Code theme CSS custom properties (--vscode-*) to their computed values.
            // These variables are defined only in the VS Code host environment; the mobile browser
            // has no access to them. We read every --* property declared in :root or html rules,
            // get its getComputedStyle value, and prepend a :root{} block so references resolve.
            try {
                const computedRoot = window.getComputedStyle(document.documentElement);
                const varNames = new Set();
                for (const sheet of document.styleSheets) {
                    try {
                        for (const rule of sheet.cssRules) {
                            const sel = (rule.selectorText || '');
                            if (sel === ':root' || sel === 'html' || sel.includes(':root')) {
                                for (const prop of rule.style) {
                                    if (prop.startsWith('--')) varNames.add(prop);
                                }
                            }
                        }
                    } catch(e2) {}
                }
                const varLines = [];
                for (const name of varNames) {
                    const val = computedRoot.getPropertyValue(name).trim();
                    if (val) varLines.push('  ' + name + ': ' + val + ';');
                }
                if (varLines.length > 0) {
                    // Unshift last so :root{} ends up at index 0 (before font-family override)
                    rules.unshift(':root {\\n' + varLines.join('\\n') + '\\n}');
                }
            } catch(e) {}

            const allCSS = rules.join('\\n');

            return {
                html,
                css: allCSS,
                backgroundColor: cascadeStyles.backgroundColor,
                color: cascadeStyles.color,
                fontFamily: cascadeStyles.fontFamily,
                scrollInfo,
                stats: {
                    nodes: clone.getElementsByTagName('*').length,
                    htmlSize: html.length,
                    cssSize: allCSS.length
                }
            };
        })()`;
    }

    private getJson<T>(url: string): Promise<T> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('HTTP timeout')), 5000);
            http.get(url, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    clearTimeout(timeout);
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(e);
                    }
                });
            }).on('error', (e) => {
                clearTimeout(timeout);
                reject(e);
            });
        });
    }
}
