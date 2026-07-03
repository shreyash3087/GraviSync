import { useState, useCallback, useRef, useEffect } from 'react'
import { useWebSocket } from './hooks/useWebSocket'
import { StatusBar } from './components/StatusBar'
import { SnapshotView } from './components/SnapshotView'
import { InputBar } from './components/InputBar'
import { ActionBar } from './components/ActionBar'
import { SettingsDrawer, HistoryDrawer, FileViewerDrawer } from './components/Drawers'

const MODELS = [
  { id: 'gemini-3.5-flash-high', label: 'Gemini 3.5 Flash (High)', badge: 'Fast' },
  { id: 'gemini-3.5-flash-medium', label: 'Gemini 3.5 Flash (Medium)', badge: 'Fast' },
  { id: 'gemini-3.5-flash-low', label: 'Gemini 3.5 Flash (Low)', badge: 'Fast' },
  { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' },
  { id: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)' },
  { id: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6 (Thinking)' },
  { id: 'claude-opus-4.6', label: 'Claude Opus 4.6 (Thinking)' },
  { id: 'gpt-oss-120b', label: 'GPT-OSS 120B (Medium)' },
]

function normalizeModel(name: string) {
  if (!name) return 'gemini-3.5-flash-high'
  const c = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (c.includes('gemini35') && c.includes('high')) return 'gemini-3.5-flash-high'
  if (c.includes('gemini35') && c.includes('medium')) return 'gemini-3.5-flash-medium'
  if (c.includes('gemini35') && c.includes('low')) return 'gemini-3.5-flash-low'
  if (c.includes('gemini31') && c.includes('high')) return 'gemini-3.1-pro-high'
  if (c.includes('gemini31') && c.includes('low')) return 'gemini-3.1-pro-low'
  if (c.includes('claudesonnet')) return 'claude-sonnet-4.6'
  if (c.includes('claudeopus')) return 'claude-opus-4.6'
  if (c.includes('gptoss')) return 'gpt-oss-120b'
  return 'gemini-3.5-flash-high'
}

export default function App() {
  const { status, latency, snapshot, appState, send } = useWebSocket()
  const [isInputFocused, setIsInputFocused] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [filePreview, setFilePreview] = useState<{ name: string; dataUrl: string } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // File Viewer drawer states
  const [fileViewerOpen, setFileViewerOpen] = useState(false)
  const [viewingFilePath, setViewingFilePath] = useState<string | null>(null)
  const [viewingFileName, setViewingFileName] = useState<string | null>(null)

  const handleOpenFile = useCallback((path: string, name: string) => {
    setViewingFilePath(path)
    setViewingFileName(name)
    setFileViewerOpen(true)
  }, [])

  // Derive active model from appState
  const activeModel = normalizeModel(appState.model ?? '')

  // Show toast
  const showToast = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 3000)
  }, [])

  // Request notification permission once
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      const handle = () => {
        Notification.requestPermission()
        window.removeEventListener('click', handle)
      }
      window.addEventListener('click', handle, { once: true })
    }
  }, [])

  // Action handler from snapshot clicks
  const handleAction = useCallback((type: string, data: object) => {
    send({ type, ...data })
  }, [send])

  // Send text message
  const handleSend = useCallback((text: string) => {
    send({ type: 'message', text })
  }, [send])

  // Set model
  const handleSetModel = useCallback((model: string) => {
    send({ type: 'command', cmd: 'setModel', params: { model } })
  }, [send])

  // Stop
  const handleStop = useCallback(() => send({ type: 'command', cmd: 'stop' }), [send])

  // New chat
  const handleNewChat = useCallback(() => send({ type: 'command', cmd: 'newChat' }), [send])

  // Scroll sync
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    send({ type: 'scroll', position: el.scrollTop })
  }, [send])

  // File clear
  const handleClearFile = () => {
    setFilePreview(null)
    fetch('/api/clear-upload', { method: 'POST', credentials: 'same-origin' }).catch(() => {})
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[#0a0a0f]">
      {/* Status bar */}
      <StatusBar
        status={status}
        latency={latency}
        onSettingsOpen={() => setSettingsOpen(true)}
      />

      {/* Scrollable chat area — grows to fill all available space */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto overscroll-contain"
        onScroll={handleScroll}
      >
        <SnapshotView
          snapshot={snapshot}
          onAction={handleAction}
          isInputFocused={isInputFocused}
          onOpenFile={handleOpenFile}
        />
      </div>

      {/* Action bar — model selector + stop/new/history */}
      <ActionBar
        activeModel={activeModel}
        availableModels={MODELS}
        onSetModel={handleSetModel}
        onStop={handleStop}
        onNewChat={handleNewChat}
        onHistory={() => setHistoryOpen(true)}
        isGenerating={appState.isGenerating}
      />

      {/* Input bar */}
      <InputBar
        onSend={handleSend}
        onFocusChange={setIsInputFocused}
        filePreview={filePreview}
        onClearFile={handleClearFile}
        isGenerating={appState.isGenerating}
        onStop={handleStop}
      />

      {/* Drawers */}
      <SettingsDrawer
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        status={status}
        latency={latency}
      />
      <HistoryDrawer
        isOpen={historyOpen}
        onClose={() => setHistoryOpen(false)}
      />
      <FileViewerDrawer
        isOpen={fileViewerOpen}
        onClose={() => setFileViewerOpen(false)}
        filePath={viewingFilePath}
        fileName={viewingFileName}
        onProceed={() => {
          send({ type: 'click', target: { tag: 'BUTTON', text: 'Proceed', occurrenceIndex: 0 } })
        }}
      />

      {/* Toast */}
      {toast && <div className="ag-toast">{toast}</div>}
    </div>
  )
}
