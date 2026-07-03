/**
 * Antigravity Remote Connect — Mobile App Client
 * Handles WebSocket connection, snapshot rendering, and remote control
 */

(function() {
    'use strict';

    // --- Configuration ---
    const WS_RECONNECT_INITIAL = 1000;
    const WS_RECONNECT_MAX = 30000;
    const PING_INTERVAL = 15000;

    // --- State ---
    let ws = null;
    let reconnectDelay = WS_RECONNECT_INITIAL;
    let reconnectTimer = null;
    let pingTimer = null;
    let lastPingTime = 0;
    let currentModel = 'unknown';
    let currentMode = 'unknown';
    let lastRenderedHtml = '';
    let isInputFocused = false;

    // --- DOM Elements ---
    const connDot = document.getElementById('connDot');
    const connText = document.getElementById('connText');
    const latencyBadge = document.getElementById('latencyBadge');
    const snapshotContainer = document.getElementById('snapshotContainer');
    const loadingState = document.getElementById('loadingState');
    const messageInput = document.getElementById('messageInput');
    const actionBanner = document.getElementById('actionBanner');
    const actionText = document.getElementById('actionText');

    if (snapshotContainer) {
        snapshotContainer.addEventListener('focusin', function(e) {
            if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) {
                isInputFocused = true;
            }
        });
        snapshotContainer.addEventListener('focusout', function(e) {
            if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) {
                isInputFocused = false;
            }
        });
    }

    // --- WebSocket Connection ---

    function connectWebSocket() {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = protocol + '//' + location.host + '/ws';

        updateConnectionStatus('connecting');

        try {
            ws = new WebSocket(wsUrl);
        } catch (e) {
            console.error('WebSocket creation failed:', e);
            scheduleReconnect();
            return;
        }

        ws.onopen = function() {
            console.log('WebSocket connected');
            updateConnectionStatus('connected');
            reconnectDelay = WS_RECONNECT_INITIAL;

            // Start ping
            if (pingTimer) clearInterval(pingTimer);
            pingTimer = setInterval(sendPing, PING_INTERVAL);
        };

        ws.onmessage = function(event) {
            try {
                var msg = JSON.parse(event.data);
                handleMessage(msg);
            } catch (e) {
                console.error('Failed to parse WS message:', e);
            }
        };

        ws.onclose = function(event) {
            console.log('WebSocket closed:', event.code, event.reason);
            updateConnectionStatus('disconnected');
            ws = null;
            if (pingTimer) {
                clearInterval(pingTimer);
                pingTimer = null;
            }
            // Reset last rendered HTML so the first snapshot after reconnect always renders fresh
            lastRenderedHtml = '';
            scheduleReconnect();
        };

        ws.onerror = function(error) {
            console.error('WebSocket error:', error);
        };
    }

    function scheduleReconnect() {
        if (reconnectTimer) return;

        console.log('Reconnecting in ' + (reconnectDelay / 1000) + 's...');
        reconnectTimer = setTimeout(function() {
            reconnectTimer = null;
            connectWebSocket();
        }, reconnectDelay);

        // Exponential backoff
        reconnectDelay = Math.min(reconnectDelay * 2, WS_RECONNECT_MAX);
    }

    function sendPing() {
        if (ws && ws.readyState === WebSocket.OPEN) {
            lastPingTime = Date.now();
            ws.send(JSON.stringify({ type: 'pong' }));
        }
    }

    // --- Message Handling ---

    function handleMessage(msg) {
        switch (msg.type) {
            case 'snapshot':
                try {
                    renderSnapshot(msg.data);
                    // Update latency
                    if (msg.timestamp) {
                        var latency = Date.now() - msg.timestamp;
                        latencyBadge.textContent = Math.max(0, latency) + 'ms';
                    }
                } catch (e) {
                    console.error('Error rendering snapshot:', e);
                }
                break;

            case 'state':
                updateAppState(msg.data);
                break;

            case 'notification':
                showNotification(msg.data);
                break;

            case 'clients':
                // Could show client count if desired
                break;

            case 'ping':
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'pong' }));
                }
                break;
        }
    }

    // --- Snapshot Rendering ---

    function sanitizeHtmlForComparison(html) {
        if (!html) return '';
        return html
            .replace(/\b\d+ms\b/g, '')
            .replace(/\bWorked for [\d\s\w]+s?\b/gi, '')
            .replace(/\bThought for [\d\s\w]+s?\b/gi, '')
            .replace(/\b(Waiting for user input|Exploring|Analyzing|Thinking|Running|Generating|Loading)\.*/gi, '$1');
    }

    function renderSnapshot(data) {
        if (!data || !data.html) return;

        // Skip rendering if an input/textarea is focused to avoid cursor jumping/wiping typing
        if (isInputFocused) {
            return;
        }

        // Skip rendering if HTML is unchanged (after sanitization) to prevent approval banner animation loop and lost clicks
        if (sanitizeHtmlForComparison(data.html) === sanitizeHtmlForComparison(lastRenderedHtml)) {
            return;
        }
        lastRenderedHtml = data.html;

        // Hide loading state
        if (loadingState) {
            loadingState.classList.add('hidden');
        }

        // Create or update snapshot content
        var content = snapshotContainer.querySelector('.snapshot-content');
        if (!content) {
            content = document.createElement('div');
            content.className = 'snapshot-content';
            snapshotContainer.appendChild(content);
        }

        // 1. Capture current form state (exclude checkboxes/radios so selection highlights show correctly)
        var formStates = {};
        try {
            var oldInputs = content.querySelectorAll('input, textarea, select');
            oldInputs.forEach(function(oldInput) {
                var agId = oldInput.getAttribute('data-ag-id');
                if (agId && oldInput.type !== 'checkbox' && oldInput.type !== 'radio') {
                    formStates[agId] = {
                        value: oldInput.value
                    };
                }
            });
        } catch (e) {
            console.error('Error capturing form state:', e);
        }

        // 2. Inject the snapshot HTML
        content.innerHTML = data.html;

        try {
            console.log('[Snapshot Render] Injected HTML length:', data.html.length);
            console.log('[Snapshot Render] Content dimensions: width =', content.offsetWidth, 'height =', content.offsetHeight);
            var children = content.children;
            if (children.length > 0) {
                var firstChild = children[0];
                var style = window.getComputedStyle(firstChild);
                console.log('[Snapshot Render] First child tag:', firstChild.tagName, 'classes:', firstChild.className, 'id:', firstChild.id);
                console.log('[Snapshot Render] First child computed style: display =', style.display, 'visibility =', style.visibility, 'opacity =', style.opacity, 'height =', style.height);
            } else {
                console.log('[Snapshot Render] Content has NO children!');
            }
        } catch (e) {
            console.error('[Snapshot Render] Tracing error:', e);
        }

        // 3. Restore form state directly on the new live DOM elements
        try {
            var newInputs = content.querySelectorAll('input, textarea, select');
            newInputs.forEach(function(newInput) {
                var agId = newInput.getAttribute('data-ag-id');
                if (agId && formStates[agId] && newInput.type !== 'checkbox' && newInput.type !== 'radio') {
                    newInput.value = formStates[agId].value;
                }
            });
        } catch (e) {
            console.error('Error restoring form state:', e);
        }

        // Inject captured CSS
        try {
            var styleId = 'ag-snapshot-styles';
            var existingStyle = document.getElementById(styleId);
            if (existingStyle) {
                if (data.css) {
                    existingStyle.textContent = data.css;
                }
            } else {
                var style = document.createElement('style');
                style.id = styleId;
                style.textContent = data.css || '';
                document.head.appendChild(style);
            }
        } catch (e) {
            console.error('Error injecting CSS:', e);
        }

        // Format code highlights & file extension badges
        try {
            formatCodeHighlights(content);
        } catch (e) {
            console.error('Error formatting code highlights:', e);
        }

        // Apply dark mode overrides
        try {
            applyDarkModeOverrides(content, data);
        } catch (e) {
            console.error('Error applying dark mode overrides:', e);
        }

        // Make interactive elements clickable
        try {
            attachClickHandlers(content);
        } catch (e) {
            console.error('Error attaching click handlers:', e);
        }
    }

    function applyDarkModeOverrides(container, data) {
        // Apply text color/font only — no background on the content div itself,
        // so the agent output boxes don't get a container background.
        container.style.color = data.color || '#e2e8f0';
        if (data.fontFamily) {
            container.style.fontFamily = data.fontFamily;
        }

        // Override common light-mode styles
        var overrideStyle = document.getElementById('ag-dark-overrides');
        if (!overrideStyle) {
            overrideStyle = document.createElement('style');
            overrideStyle.id = 'ag-dark-overrides';
            overrideStyle.textContent = [
                '#snapshotContainer { height: 100%; display: flex; flex-direction: column; box-sizing: border-box; }',
                '.snapshot-content { max-width: 100%; height: 100% !important; display: flex !important; flex-direction: column !important; min-height: 0 !important; box-sizing: border-box; }',
                '#conversation { height: 100% !important; display: flex !important; flex-direction: column !important; min-height: 0 !important; }',
                // Normalize virtual list rows to stack relative to one another in natural flow
                '.snapshot-content [class*="monaco-list-rows"], .snapshot-content [class*="list-rows"], .snapshot-content .monaco-list-rows { height: auto !important; position: relative !important; }',
                '.snapshot-content [class*="monaco-list-row"], .snapshot-content .monaco-list-row, .snapshot-content [class*="message-row"], .snapshot-content [class*="chat-line"] { position: relative !important; top: auto !important; left: auto !important; height: auto !important; min-height: 0 !important; transform: none !important; margin: 12px 0 !important; display: block !important; }',
                '.snapshot-content * { max-width: 100%; }',
                '.snapshot-content img { height: auto; }',
                '.snapshot-content pre { white-space: pre-wrap; word-break: break-word; }',
                '.snapshot-content a { color: #93c5fd; }',
                '.snapshot-content button { cursor: pointer; }',
                // Space out adjacent buttons (e.g. Skip and Submit)
                '.snapshot-content button + button, .snapshot-content button + [role="button"], .snapshot-content [role="button"] + button, .snapshot-content [role="button"] + [role="button"] { margin-left: 12px !important; }',
                // Make action buttons more prominent on mobile
                '.snapshot-content button:has(> span), .snapshot-content [role="button"] {',
                '  touch-action: manipulation;',
                '}'
            ].join('\n');
            document.head.appendChild(overrideStyle);
        }
    }

    function attachClickHandlers(container) {
        // Find all interactive elements with data-ag-id in the snapshot
        var interactive = container.querySelectorAll('[data-ag-id]');

        interactive.forEach(function(el) {
            var tagName = el.tagName.toUpperCase();
            var type = (el.getAttribute('type') || '').toLowerCase();

            // We handle text inputs, textareas, and select elements via change/input events, not clicks
            var isTextInput = (tagName === 'INPUT' && (type === 'text' || type === 'password' || type === 'email' || type === 'number' || type === 'search'));
            var isTextArea = (tagName === 'TEXTAREA');
            var isSelect = (tagName === 'SELECT');

            if (isTextInput || isTextArea || isSelect) {
                el.addEventListener('input', function(e) {
                    var agId = el.getAttribute('data-ag-id');
                    sendAction('formInput', {
                        target: {
                            agId: agId,
                            value: el.value,
                            checked: el.checked
                        }
                    });
                });
                
                el.addEventListener('change', function(e) {
                    var agId = el.getAttribute('data-ag-id');
                    sendAction('formInput', {
                        target: {
                            agId: agId,
                            value: el.value,
                            checked: el.checked
                        }
                    });
                });
                return;
            }

            // Clickable elements: buttons, links, roles, labels, checkbox/radio inputs
            el.addEventListener('click', function(e) {
                // Check if it's a Copy button
                var isCopy = el.getAttribute('aria-label') === 'Copy' || 
                             (el.querySelector('svg') && (el.getAttribute('data-tooltip-id') || '').includes('copy'));
                if (isCopy) {
                    e.preventDefault();
                    e.stopPropagation();
                    // Find the message text to copy
                    var copyContainer = el.closest('[role="article"]') || el.closest('.flex.items-start') || el.closest('.group');
                    if (copyContainer) {
                        var copyTextEl = copyContainer.querySelector('.whitespace-pre-wrap, .leading-relaxed');
                        if (copyTextEl) {
                            navigator.clipboard.writeText(copyTextEl.innerText).then(function() {
                                showToast('Copied to clipboard');
                            }).catch(function(err) {
                                console.error('Failed to copy:', err);
                            });
                        }
                    }
                    return;
                }

                // If it's a checkbox, radio, summary, or details element, do not preventDefault to let it toggle/expand natively on the client
                var isCheckboxOrRadio = (tagName === 'INPUT' && (type === 'checkbox' || type === 'radio'));
                var isSummaryOrDetails = (tagName === 'SUMMARY' || tagName === 'DETAILS');
                if (!isCheckboxOrRadio && !isSummaryOrDetails) {
                    e.preventDefault();
                }
                e.stopPropagation();

                var agId = el.getAttribute('data-ag-id');
                var text = (el.textContent || '').trim();
                var label = (el.getAttribute('aria-label') || '').trim();
                var testid = (el.getAttribute('data-testid') || '').trim();
                var actionText = text || label || testid || type || tagName;

                // Calculate occurrenceIndex relative only to matching elements (as fallback)
                var occurrenceIndex = 0;
                if (actionText) {
                    var actionTextLower = actionText.toLowerCase();
                    var matchingElements = [];
                    container.querySelectorAll('[data-ag-id]').forEach(function(matchEl) {
                        var elText = (matchEl.textContent || '').trim().toLowerCase();
                        var elLabel = (matchEl.getAttribute('aria-label') || '').trim().toLowerCase();
                        var elTestid = (matchEl.getAttribute('data-testid') || '').trim().toLowerCase();
                        if (elText.includes(actionTextLower) || elLabel.includes(actionTextLower) || elTestid.includes(actionTextLower)) {
                            matchingElements.push(matchEl);
                        }
                    });
                    occurrenceIndex = matchingElements.indexOf(el);
                    if (occurrenceIndex === -1) occurrenceIndex = 0;
                }

                // Send click action
                sendAction('click', {
                    target: {
                        tag: tagName,
                        text: actionText,
                        occurrenceIndex: occurrenceIndex,
                        agId: agId
                    }
                });

                // For checkbox/radio: we also send formInput instantly so server matches checked state
                if (isCheckboxOrRadio) {
                    sendAction('formInput', {
                        target: {
                            agId: agId,
                            value: el.value,
                            checked: el.checked
                        }
                    });
                }
            });
        });
    }

    // --- App State ---

    function updateAppState(state) {
        if (!state) return;

        currentModel = state.model || 'unknown';
        currentMode = state.mode || 'unknown';

        // Update model display
        var activeModelName = document.getElementById('activeModelName');
        if (activeModelName) {
            const normalized = normalizeModelName(currentModel);
            var matchedOption = null;
            document.querySelectorAll('.model-opt-item').forEach(function(btn) {
                if (btn.dataset.model === normalized) {
                    matchedOption = btn;
                }
            });
            if (matchedOption) {
                var titleText = matchedOption.querySelector('.model-title').textContent;
                activeModelName.textContent = titleText;
                document.querySelectorAll('.model-opt-item').forEach(function(btn) {
                    btn.classList.toggle('active', btn === matchedOption);
                });
            } else {
                activeModelName.textContent = capitalizeFirst(currentModel);
            }
        }
        // Show/hide action banner
        if (state.hasPendingActions) {
            actionBanner.classList.remove('hidden');
            actionText.textContent = 'Permission required — tap to respond';
            // Vibrate if supported
            if (navigator.vibrate) {
                navigator.vibrate([100, 50, 100]);
            }
        } else {
            actionBanner.classList.add('hidden');
        }
    }

    // --- Connection Status ---

    function updateConnectionStatus(status) {
        connDot.className = 'status-dot ' + status;
        
        switch (status) {
            case 'connected':
                connText.textContent = 'Connected';
                break;
            case 'connecting':
                connText.textContent = 'Connecting...';
                latencyBadge.textContent = '--ms';
                break;
            case 'disconnected':
                connText.textContent = 'Disconnected';
                latencyBadge.textContent = '--ms';
                break;
        }

        // Update drawer status
        var drawerStatus = document.getElementById('drawerConnStatus');
        if (drawerStatus) {
            drawerStatus.textContent = capitalizeFirst(status);
        }
    }

    // --- Notifications ---

    function showNotification(data) {
        if (!data) return;

        // Browser notification if permission granted
        if (Notification.permission === 'granted') {
            new Notification(data.title || 'AG Remote', {
                body: data.body || '',
                icon: '/app/assets/icons/icon-192.png'
            });
        }

        // Vibrate
        if (navigator.vibrate && data.actions && data.actions.length > 0) {
            navigator.vibrate([200, 100, 200]);
        }
    }

    // --- Sending Messages ---

    function sendToServer(msg) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
        } else {
            console.warn('WebSocket not connected, cannot send:', msg.type);
        }
    }

    function sendAction(type, data) {
        sendToServer({ type: type, ...data });
    }

    function sendMessage() {
        var text = messageInput.value.trim();
        if (!text) return;

        sendToServer({ type: 'message', text: text });
        messageInput.value = '';
        messageInput.style.height = 'auto'; // Reset height
        messageInput.blur();
        hideFilePreview();
    }

    // --- API Calls (fallback for when WS fails) ---

    function apiPost(endpoint, body) {
        return fetch('/api/' + endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            credentials: 'same-origin'
        }).then(function(res) { return res.json(); });
    }

    function apiGet(endpoint) {
        return fetch('/api/' + endpoint, {
            credentials: 'same-origin'
        }).then(function(res) { return res.json(); });
    }

    // --- Event Handlers ---

    // Send message
    document.getElementById('sendBtn').addEventListener('click', sendMessage);
    messageInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // Stop generation
    document.getElementById('btnStop').addEventListener('click', function() {
        sendToServer({ type: 'command', cmd: 'stop' });
    });

    // New chat
    document.getElementById('btnNewChat').addEventListener('click', function() {
        sendToServer({ type: 'command', cmd: 'newChat' });
    });

    // Action banner buttons
    document.getElementById('btnAllow').addEventListener('click', function() {
        sendToServer({ type: 'action', action: 'allow' });
        actionBanner.classList.add('hidden');
    });

    document.getElementById('btnDeny').addEventListener('click', function() {
        sendToServer({ type: 'action', action: 'deny' });
        actionBanner.classList.add('hidden');
    });

    document.getElementById('btnAllowOnce').addEventListener('click', function() {
        sendToServer({ type: 'action', action: 'allowOnce' });
        actionBanner.classList.add('hidden');
    });

    // Settings drawer
    document.getElementById('settingsBtn').addEventListener('click', function() {
        document.getElementById('settingsDrawer').classList.remove('hidden');
        document.getElementById('drawerOverlay').classList.remove('hidden');
        // Update latency in drawer
        var drawerLatency = document.getElementById('drawerLatency');
        if (drawerLatency) {
            drawerLatency.textContent = latencyBadge.textContent;
        }
    });

    document.getElementById('closeDrawer').addEventListener('click', closeSettingsDrawer);
    document.getElementById('drawerOverlay').addEventListener('click', closeSettingsDrawer);

    function closeSettingsDrawer() {
        document.getElementById('settingsDrawer').classList.add('hidden');
        document.getElementById('drawerOverlay').classList.add('hidden');
    }

    // Model selector toggle
    const modelSelectorBtn = document.getElementById('modelSelectorBtn');
    const modelDropdownMenu = document.getElementById('modelDropdownMenu');
    
    if (modelSelectorBtn && modelDropdownMenu) {
        modelSelectorBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            modelSelectorBtn.classList.toggle('open');
            modelDropdownMenu.classList.toggle('hidden');
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', function() {
            modelSelectorBtn.classList.remove('open');
            modelDropdownMenu.classList.add('hidden');
        });
    }

    // Model selection options click
    document.querySelectorAll('.model-opt-item').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var model = btn.dataset.model;
            sendToServer({ type: 'command', cmd: 'setModel', params: { model: model } });
            
            // Optimistic UI update
            document.querySelectorAll('.model-opt-item').forEach(function(b) {
                b.classList.toggle('active', b === btn);
            });
            
            var activeModelName = document.getElementById('activeModelName');
            if (activeModelName) {
                var titleText = btn.querySelector('.model-title').textContent;
                activeModelName.textContent = titleText;
            }
        });
    });

    // Send button highlight when input has text & auto-grow input height
    if (messageInput) {
        messageInput.addEventListener('input', function() {
            const sendBtn = document.getElementById('sendBtn');
            if (sendBtn) {
                sendBtn.classList.toggle('has-text', messageInput.value.trim().length > 0);
            }
            
            // Auto-grow height logic
            messageInput.style.height = 'auto';
            messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
        });
    }

    // History drawer
    document.getElementById('btnHistory').addEventListener('click', function() {
        document.getElementById('historyDrawer').classList.remove('hidden');
        document.getElementById('historyOverlay').classList.remove('hidden');
        loadChatHistory();
    });

    document.getElementById('closeHistory').addEventListener('click', closeHistoryDrawer);
    document.getElementById('historyOverlay').addEventListener('click', closeHistoryDrawer);

    function closeHistoryDrawer() {
        document.getElementById('historyDrawer').classList.add('hidden');
        document.getElementById('historyOverlay').classList.add('hidden');
        // Dispatch Escape to close desktop history panel too
        apiPost('close-history', {}).catch(function() {});
    }

    // Logout
    document.getElementById('btnLogout').addEventListener('click', function() {
        apiPost('logout', {}).then(function() {
            window.location.href = '/';
        }).catch(function() {
            window.location.href = '/';
        });
    });

    // --- Chat History ---

    function loadChatHistory() {
        var historyList = document.getElementById('historyList');
        historyList.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><p>Loading history...</p></div>';

        apiGet('chat-history').then(function(data) {
            if (!data.history || data.history.length === 0) {
                historyList.innerHTML = '<div class="loading-state"><p>No conversations found</p></div>';
                return;
            }

            historyList.innerHTML = data.history.map(function(item, index) {
                const title = item.title || 'Untitled Session';
                const time = item.time || '';
                return '<div class="history-item" data-index="' + index + '">' +
                    '<div class="history-item-header">' +
                        '<div class="history-item-title">' + escapeHtml(title) + '</div>' +
                        (time ? '<div class="history-item-time">' + escapeHtml(time) + '</div>' : '') +
                    '</div>' +
                    '</div>';
            }).join('');

            // Attach click handlers
            historyList.querySelectorAll('.history-item').forEach(function(item) {
                item.addEventListener('click', function() {
                    var title = item.querySelector('.history-item-title').textContent;
                    apiPost('remote-click', { text: title, occurrenceIndex: 0 }).then(function() {
                        closeHistoryDrawer();
                    });
                });
            });
        }).catch(function(err) {
            console.error('Failed to load history:', err);
            historyList.innerHTML = '<div class="loading-state"><p>Failed to load history</p></div>';
        });
    }

    // --- Scroll Sync ---

    var scrollSyncTimer = null;
    var sessionMirror = document.getElementById('sessionMirror');

    sessionMirror.addEventListener('scroll', function() {
        if (scrollSyncTimer) clearTimeout(scrollSyncTimer);
        scrollSyncTimer = setTimeout(function() {
            sendToServer({ type: 'scroll', position: sessionMirror.scrollTop });
        }, 150); // Debounce
    });

    // --- Notification Permission ---

    if ('Notification' in window && Notification.permission === 'default') {
        // Request after first user interaction
        document.addEventListener('click', function requestNotif() {
            Notification.requestPermission();
            document.removeEventListener('click', requestNotif);
        }, { once: true });
    }

    // --- Helpers ---

    function capitalizeFirst(str) {
        if (!str) return '';
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    function escapeHtml(str) {
        var div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // --- Toast Notifications ---
    function showToast(message) {
        let toast = document.getElementById('ag-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'ag-toast';
            toast.style.cssText = [
                'position: fixed;',
                'bottom: 80px;',
                'left: 50%;',
                'transform: translateX(-50%);',
                'background: rgba(10, 10, 15, 0.85);',
                'color: #ffffff;',
                'padding: 8px 16px;',
                'border-radius: 8px;',
                'font-size: 13px;',
                'font-weight: 500;',
                'border: 1px solid rgba(255,255,255,0.06);',
                'box-shadow: 0 4px 12px rgba(0,0,0,0.4);',
                'z-index: 999;',
                'transition: opacity 300ms ease, bottom 300ms ease;',
                'opacity: 0;',
                'pointer-events: none;',
                'backdrop-filter: blur(10px);',
                '-webkit-backdrop-filter: blur(10px);'
            ].join(' ');
            document.body.appendChild(toast);
        }
        
        toast.textContent = message;
        toast.style.opacity = '1';
        toast.style.bottom = '95px';
        
        setTimeout(function() {
            toast.style.opacity = '0';
            toast.style.bottom = '80px';
        }, 3000);
    }

    // --- Model Normalization ---
    function normalizeModelName(name) {
        if (!name) return 'unknown';
        const clean = name.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (clean.includes('gemini35flashhigh')) return 'gemini-3.5-flash-high';
        if (clean.includes('gemini35flashmedium')) return 'gemini-3.5-flash-medium';
        if (clean.includes('gemini35flashlow')) return 'gemini-3.5-flash-low';
        if (clean.includes('gemini31prohigh')) return 'gemini-3.1-pro-high';
        if (clean.includes('gemini31prolow')) return 'gemini-3.1-pro-low';
        if (clean.includes('claudesonnet46')) return 'claude-sonnet-4.6';
        if (clean.includes('claudeopus46')) return 'claude-opus-4.6';
        if (clean.includes('gptoss120b')) return 'gpt-oss-120b';

        // Loose checks
        if (clean.includes('gemini35') && clean.includes('high')) return 'gemini-3.5-flash-high';
        if (clean.includes('gemini35') && clean.includes('medium')) return 'gemini-3.5-flash-medium';
        if (clean.includes('gemini35') && clean.includes('low')) return 'gemini-3.5-flash-low';
        if (clean.includes('gemini31') && clean.includes('high')) return 'gemini-3.1-pro-high';
        if (clean.includes('gemini31') && clean.includes('low')) return 'gemini-3.1-pro-low';
        if (clean.includes('claudesonnet')) return 'claude-sonnet-4.6';
        if (clean.includes('claudeopus')) return 'claude-opus-4.6';
        if (clean.includes('gptoss')) return 'gpt-oss-120b';

        return name;
    }

    // --- Code Highlighting & File Badging ---
    function formatCodeHighlights(container) {
        const codes = container.querySelectorAll('code:not(pre code)');
        codes.forEach(function(code) {
            const text = code.textContent.trim();
            if (!text) return;
            
            let fileClass = '';
            let iconHtml = '';
            
            if (text.endsWith('.ts') || text.includes('.ts ')) {
                fileClass = 'ts-file';
                iconHtml = '<span class="file-icon"><i class="fas fa-file-code"></i></span>';
            } else if (text.endsWith('.js') || text.includes('.js ')) {
                fileClass = 'js-file';
                iconHtml = '<span class="file-icon"><i class="fab fa-js"></i></span>';
            } else if (text.endsWith('.html') || text.includes('.html ')) {
                fileClass = 'html-file';
                iconHtml = '<span class="file-icon">&lt;/&gt;</span>';
            } else if (text.includes('\\') || text.includes('/') || text.startsWith('d:') || text.includes('Projects')) {
                if (!text.includes('.')) {
                    fileClass = 'folder-tag';
                    iconHtml = '<span class="file-icon"><i class="fas fa-folder"></i></span>';
                } else {
                    fileClass = 'default-file';
                    iconHtml = '<span class="file-icon"><i class="fas fa-file"></i></span>';
                }
            } else if (text.includes('.') && text.length < 30) {
                fileClass = 'default-file';
                iconHtml = '<span class="file-icon"><i class="fas fa-file"></i></span>';
            }
            
            if (fileClass) {
                code.className = 'file-tag ' + fileClass;
                code.innerHTML = iconHtml + ' ' + escapeHtml(text);
            }
        });
    }

    // --- Voice Input (Speech Recognition) ---
    var recognition = null;
    var isRecording = false;

    function initSpeechRecognition() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            console.warn('Speech recognition not supported in this browser');
            return;
        }

        recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = false;
        recognition.lang = 'en-US';

        recognition.onstart = function() {
            isRecording = true;
            const micBtn = document.getElementById('micBtn');
            if (micBtn) micBtn.classList.add('recording');
            showToast('Listening...');
        };

        recognition.onerror = function(event) {
            console.error('Speech recognition error:', event.error);
            stopRecording();
        };

        recognition.onend = function() {
            stopRecording();
        };

        recognition.onresult = function(event) {
            const transcript = event.results[0][0].transcript;
            if (transcript && messageInput) {
                messageInput.value = (messageInput.value + ' ' + transcript).trim();
                messageInput.dispatchEvent(new Event('input'));
            }
        };
    }

    function stopRecording() {
        isRecording = false;
        const micBtn = document.getElementById('micBtn');
        if (micBtn) micBtn.classList.remove('recording');
        if (recognition) {
            try { recognition.stop(); } catch(e) {}
        }
    }

    function toggleRecording() {
        if (!recognition) {
            initSpeechRecognition();
        }
        if (!recognition) {
            showToast('Voice input not supported in this browser');
            return;
        }

        if (isRecording) {
            stopRecording();
        } else {
            try {
                recognition.start();
            } catch (e) {
                console.error(e);
            }
        }
    }

    const micBtn = document.getElementById('micBtn');
    if (micBtn) {
        micBtn.addEventListener('click', toggleRecording);
    }

    // --- File Attachments ---
    const attachBtn = document.getElementById('attachBtn');
    const mobileFileInput = document.getElementById('mobileFileInput');

    function showFilePreview(fileName, dataUrl) {
        const container = document.getElementById('filePreviewContainer');
        if (!container) return;

        container.classList.remove('hidden');
        container.innerHTML = `
            <div class="file-preview-item">
                <img src="${dataUrl}" alt="${fileName}" />
                <button class="file-preview-remove" id="btnRemoveFilePreview">&times;</button>
            </div>
        `;

        document.getElementById('btnRemoveFilePreview').addEventListener('click', function(e) {
            e.stopPropagation();
            hideFilePreview();
            apiPost('clear-upload', {}).catch(function() {});
        });
    }

    function hideFilePreview() {
        const container = document.getElementById('filePreviewContainer');
        if (container) {
            container.classList.add('hidden');
            container.innerHTML = '';
        }
    }

    if (attachBtn && mobileFileInput) {
        attachBtn.addEventListener('click', function() {
            mobileFileInput.click();
        });

        mobileFileInput.addEventListener('change', function() {
            if (mobileFileInput.files.length === 0) return;
            const file = mobileFileInput.files[0];
            
            showToast('Uploading ' + file.name + '...');
            
            const reader = new FileReader();
            reader.onload = function(e) {
                const base64Data = e.target.result;
                
                // Show optimistic preview first if it is an image
                if (file.type.startsWith('image/')) {
                    showFilePreview(file.name, base64Data);
                }

                apiPost('upload', {
                    fileName: file.name,
                    fileType: file.type,
                    fileData: base64Data
                }).then(function(res) {
                    if (res.success) {
                        showToast('File attached successfully!');
                    } else {
                        showToast('Failed to attach file.');
                        hideFilePreview();
                    }
                }).catch(function(err) {
                    console.error('File upload failed:', err);
                    showToast('Failed to upload file.');
                    hideFilePreview();
                });
            };
            reader.readAsDataURL(file);
            
            mobileFileInput.value = '';
        });
    }

    // --- Autocomplete Mentions (@-menu) ---
    var workspaceFiles = [];
    var activeSuggestionIndex = -1;
    var currentAtPosition = -1;

    function loadWorkspaceFiles() {
        apiGet('workspace-files').then(function(data) {
            if (data && data.files) {
                workspaceFiles = data.files;
            }
        }).catch(function(err) {
            console.error('Failed to load workspace files:', err);
        });
    }

    // Load workspace files on start and periodically
    setTimeout(loadWorkspaceFiles, 2000);
    setInterval(loadWorkspaceFiles, 45000);

    const autocompleteSuggestions = document.getElementById('autocompleteSuggestions');
    const suggestionsList = document.getElementById('suggestionsList');
    const suggestionsHeader = document.getElementById('suggestionsHeader');

    const autocompleteCategories = [
        { name: 'Files', icon: '📄' },
        { name: 'Directories', icon: '📁' },
        { name: 'Code Context Items', icon: '🔍' },
        { name: 'Rules', icon: '📜' },
        { name: 'Terminal', icon: '💻' },
        { name: 'Conversation', icon: '💬' }
    ];

    function showAutocomplete(term, atPos) {
        if (!autocompleteSuggestions || !suggestionsList) return;

        currentAtPosition = atPos;
        const termLower = term.toLowerCase();
        
        // Filter categories
        let matchingCategories = autocompleteCategories.filter(function(cat) {
            return cat.name.toLowerCase().includes(termLower);
        });

        // Filter files
        let matchingFiles = [];
        if (termLower.length > 0) {
            matchingFiles = workspaceFiles.filter(function(file) {
                return file.toLowerCase().includes(termLower);
            }).slice(0, 12); // Limit to top 12 matches for mobile view
        } else {
            // If empty search, show top categories + first 5 files
            matchingFiles = workspaceFiles.slice(0, 5);
        }

        suggestionsList.innerHTML = '';
        activeSuggestionIndex = -1;

        const itemsToRender = [];

        matchingCategories.forEach(function(cat) {
            itemsToRender.push({
                type: 'category',
                name: cat.name,
                icon: cat.icon,
                textToInsert: '@' + cat.name + ' '
            });
        });

        matchingFiles.forEach(function(file) {
            itemsToRender.push({
                type: 'file',
                name: file,
                icon: '📄',
                textToInsert: '@' + file + ' '
            });
        });

        if (itemsToRender.length === 0) {
            hideAutocomplete();
            return;
        }

        autocompleteSuggestions.classList.remove('hidden');
        if (termLower.length > 0) {
            suggestionsHeader.textContent = 'Matching Recommendations';
        } else {
            suggestionsHeader.textContent = 'Recommendations';
        }

        itemsToRender.forEach(function(item, idx) {
            const btn = document.createElement('button');
            btn.className = 'ag-suggestion-item';
            btn.type = 'button';
            btn.innerHTML = `<span class="icon">${item.icon}</span><span style="flex-grow: 1; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${item.name}</span>`;
            
            btn.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                selectSuggestion(item.textToInsert);
            });

            suggestionsList.appendChild(btn);
        });

        function selectSuggestion(textToInsert) {
            const val = messageInput.value;
            const before = val.slice(0, currentAtPosition);
            const after = val.slice(messageInput.selectionStart);
            messageInput.value = before + textToInsert + after;
            hideAutocomplete();
            messageInput.focus();
            
            // Adjust input height if needed
            messageInput.style.height = 'auto';
            messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
        }

        // Save items on container for keyboard nav
        autocompleteSuggestions.dataset.itemCount = itemsToRender.length;
        autocompleteSuggestions.dataset.items = JSON.stringify(itemsToRender);
    }

    function hideAutocomplete() {
        if (autocompleteSuggestions) {
            autocompleteSuggestions.classList.add('hidden');
        }
        activeSuggestionIndex = -1;
        currentAtPosition = -1;
    }

    function handleAutocompleteKeydown(e) {
        if (!autocompleteSuggestions || autocompleteSuggestions.classList.contains('hidden')) return false;

        const count = parseInt(autocompleteSuggestions.dataset.itemCount || '0', 10);
        if (count === 0) return false;

        const items = JSON.parse(autocompleteSuggestions.dataset.items || '[]');

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            activeSuggestionIndex = (activeSuggestionIndex + 1) % count;
            updateSelectedSuggestion();
            return true;
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            activeSuggestionIndex = (activeSuggestionIndex - 1 + count) % count;
            updateSelectedSuggestion();
            return true;
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            if (activeSuggestionIndex >= 0 && activeSuggestionIndex < count) {
                e.preventDefault();
                const item = items[activeSuggestionIndex];
                const val = messageInput.value;
                const before = val.slice(0, currentAtPosition);
                const after = val.slice(messageInput.selectionStart);
                messageInput.value = before + item.textToInsert + after;
                hideAutocomplete();
                messageInput.focus();
                
                // Adjust input height if needed
                messageInput.style.height = 'auto';
                messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
                return true;
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            hideAutocomplete();
            return true;
        }
        return false;
    }

    function updateSelectedSuggestion() {
        const btns = suggestionsList.querySelectorAll('.ag-suggestion-item');
        btns.forEach(function(btn, idx) {
            if (idx === activeSuggestionIndex) {
                btn.classList.add('selected');
                btn.scrollIntoView({ block: 'nearest' });
            } else {
                btn.classList.remove('selected');
            }
        });
    }

    if (messageInput) {
        messageInput.addEventListener('input', function(e) {
            const val = messageInput.value;
            const cursor = messageInput.selectionStart;
            const beforeCursor = val.slice(0, cursor);
            const lastAt = beforeCursor.lastIndexOf('@');
            
            if (lastAt !== -1 && (lastAt === 0 || /\s/.test(beforeCursor[lastAt - 1]))) {
                const term = beforeCursor.slice(lastAt + 1);
                if (!/\s/.test(term)) {
                    showAutocomplete(term, lastAt);
                    return;
                }
            }
            hideAutocomplete();
        });

        messageInput.addEventListener('keydown', function(e) {
            if (handleAutocompleteKeydown(e)) {
                e.stopPropagation();
            }
        });

        // Hide autocomplete when clicking anywhere else
        document.addEventListener('click', function(e) {
            if (autocompleteSuggestions && !autocompleteSuggestions.contains(e.target) && e.target !== messageInput) {
                hideAutocomplete();
            }
        });
    }

    // --- Initialize ---

    connectWebSocket();
    
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/app/sw.js').catch(function(e) {
            console.error('Service Worker registration failed:', e);
        });
    }

    console.log('AG Remote Connect mobile app initialized');

})();
