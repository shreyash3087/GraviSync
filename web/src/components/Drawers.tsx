import { useState, useEffect } from 'react'
import type { ConnectionStatus } from '../hooks/useWebSocket'

interface SettingsDrawerProps {
  isOpen: boolean
  onClose: () => void
  status: ConnectionStatus
  latency: number | null
}

export function SettingsDrawer({ isOpen, onClose, status, latency }: SettingsDrawerProps) {
  const handleLogout = () => {
    fetch('/api/logout', { method: 'POST', credentials: 'same-origin' })
      .finally(() => { window.location.href = '/' })
  }

  if (!isOpen) return null

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <div className="fixed bottom-0 left-0 right-0 z-50 bg-[#111118] rounded-t-2xl border-t border-white/[0.08] shadow-2xl max-h-[70vh] overflow-y-auto">
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-white/20" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
          <h3 className="text-white font-semibold text-[15px]">Settings</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/[0.06] transition-colors">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="px-5 py-4 space-y-1">
          <p className="text-white/40 text-[11px] uppercase tracking-wide font-medium mb-3">Connection</p>
          <div className="flex items-center justify-between py-2.5 border-b border-white/[0.05]">
            <span className="text-white/70 text-sm">Status</span>
            <span className="text-white/90 text-sm font-medium capitalize">{status}</span>
          </div>
          <div className="flex items-center justify-between py-2.5">
            <span className="text-white/70 text-sm">Latency</span>
            <span className="text-white/90 text-sm font-mono">{latency !== null ? `${latency}ms` : '--'}</span>
          </div>
        </div>

        <div className="px-5 pb-[max(20px,var(--safe-bottom))]">
          <button
            onClick={handleLogout}
            className="w-full py-3 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] text-white/80 text-sm font-medium transition-colors border border-white/[0.08]"
          >
            Disconnect
          </button>
        </div>
      </div>
    </>
  )
}

interface HistoryItem {
  title: string
  time?: string
}

interface HistoryDrawerProps {
  isOpen: boolean
  onClose: () => void
}

export function HistoryDrawer({ isOpen, onClose }: HistoryDrawerProps) {
  const [items, setItems] = useState<HistoryItem[] | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    setLoading(true)
    fetch('/api/chat-history', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(d => setItems(d.history || []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
  }, [isOpen])

  const select = (title: string) => {
    fetch('/api/remote-click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: title, occurrenceIndex: 0 }),
      credentials: 'same-origin'
    }).then(() => onClose())
  }

  const handleClose = () => {
    fetch('/api/close-history', { method: 'POST', credentials: 'same-origin' }).catch(() => {})
    onClose()
  }

  if (!isOpen) return null

  return (
    <>
      <div className="drawer-overlay" onClick={handleClose} />
      <div className="fixed bottom-0 left-0 right-0 z-50 bg-[#111118] rounded-t-2xl border-t border-white/[0.08] shadow-2xl max-h-[75vh] flex flex-col">
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 rounded-full bg-white/20" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06] shrink-0">
          <h3 className="text-white font-semibold text-[15px]">Chat History</h3>
          <button onClick={handleClose} className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/[0.06] transition-colors">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* List */}
        <div className="overflow-y-auto flex-1 pb-[max(16px,var(--safe-bottom))]">
          {loading && (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <div className="spinner" />
              <p className="text-white/40 text-sm">Loading history...</p>
            </div>
          )}
          {!loading && items?.length === 0 && (
            <div className="flex items-center justify-center py-12">
              <p className="text-white/40 text-sm">No conversations found</p>
            </div>
          )}
          {!loading && items && items.length > 0 && items.map((item, i) => (
            <button
              key={i}
              onClick={() => select(item.title)}
              className="w-full flex items-start gap-3 px-5 py-3.5 text-left hover:bg-white/[0.04] transition-colors border-b border-white/[0.04] last:border-0"
            >
              <div className="flex-1 min-w-0">
                <p className="text-white/90 text-sm font-medium truncate">{item.title}</p>
                {item.time && <p className="text-white/40 text-xs mt-0.5">{item.time}</p>}
              </div>
              <svg className="shrink-0 mt-0.5 text-white/20" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </button>
          ))}
        </div>
      </div>
    </>
  )
}

interface FileViewerDrawerProps {
  isOpen: boolean
  onClose: () => void
  filePath: string | null
  fileName: string | null
  onProceed?: () => void
}

function renderMarkdown(md: string) {
  if (!md) return null
  const lines = md.split('\n')
  let inCodeBlock = false
  let codeBlockContent: string[] = []
  
  const rendered: React.ReactNode[] = []
  
  lines.forEach((line, idx) => {
    // Code block handling
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        inCodeBlock = false
        const code = codeBlockContent.join('\n')
        codeBlockContent = []
        rendered.push(
          <pre key={`cb-${idx}`} className="bg-white/[0.04] p-3 rounded-lg font-mono text-xs text-indigo-200 overflow-x-auto my-3 border border-white/[0.06]">
            <code>{code}</code>
          </pre>
        )
      } else {
        inCodeBlock = true
      }
      return
    }
    
    if (inCodeBlock) {
      codeBlockContent.push(line)
      return
    }

    // Headers
    if (line.startsWith('# ')) {
      rendered.push(<h1 key={idx} className="text-base font-bold text-white mt-4 mb-2 pb-1 border-b border-white/[0.08]">{line.substring(2)}</h1>)
      return
    }
    if (line.startsWith('## ')) {
      rendered.push(<h2 key={idx} className="text-sm font-bold text-white mt-3.5 mb-1.5">{line.substring(3)}</h2>)
      return
    }
    if (line.startsWith('### ')) {
      rendered.push(<h3 key={idx} className="text-xs font-bold text-white/90 mt-3 mb-1">{line.substring(4)}</h3>)
      return
    }
    if (line.startsWith('#### ')) {
      rendered.push(<h4 key={idx} className="text-xs font-bold text-white/80 mt-2 mb-1">{line.substring(5)}</h4>)
      return
    }

    // Lists & Checkboxes
    if (line.trim().startsWith('- [ ]') || line.trim().startsWith('- [x]') || line.trim().startsWith('- [/]')) {
      const checked = line.trim().startsWith('- [x]')
      const inProgress = line.trim().startsWith('- [/]')
      const text = line.replace(/^-\s*\[[ x\/]\]\s*/, '')
      rendered.push(
        <div key={idx} className="flex items-start gap-2 my-1 text-xs text-white/85">
          <input
            type="checkbox"
            checked={checked}
            readOnly
            className={`w-3.5 h-3.5 rounded mt-0.5 accent-indigo-500 bg-white/15 border-0 ${inProgress ? 'opacity-70' : ''}`}
          />
          <span className={checked ? 'line-through text-white/40' : inProgress ? 'text-indigo-300 font-medium' : ''}>{text}</span>
        </div>
      )
      return
    }
    if (line.trim().startsWith('- ') || line.trim().startsWith('* ')) {
      rendered.push(<li key={idx} className="ml-4 list-disc text-xs text-white/80 my-0.5">{line.trim().substring(2)}</li>)
      return
    }

    // Horizontal Rule
    if (line.trim() === '---' || line.trim() === '***') {
      rendered.push(<hr key={idx} className="border-white/[0.08] my-3" />)
      return
    }

    // Blockquotes (GitHub Alerts)
    if (line.trim().startsWith('>')) {
      const quoteText = line.replace(/^>\s*/, '')
      if (quoteText.startsWith('[!NOTE]') || quoteText.startsWith('[!TIP]') || quoteText.startsWith('[!IMPORTANT]') || quoteText.startsWith('[!WARNING]') || quoteText.startsWith('[!CAUTION]')) {
        const type = quoteText.match(/\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/)?.[1] || 'NOTE'
        const alertColors: Record<string, string> = {
          NOTE: 'border-blue-500 bg-blue-500/10 text-blue-300',
          TIP: 'border-green-500 bg-green-500/10 text-green-300',
          IMPORTANT: 'border-indigo-500 bg-indigo-500/10 text-indigo-300',
          WARNING: 'border-yellow-500 bg-yellow-500/10 text-yellow-300',
          CAUTION: 'border-red-500 bg-red-500/10 text-red-300',
        }
        rendered.push(
          <div key={idx} className={`p-2.5 my-2 border-l-4 rounded-r-lg text-xs ${alertColors[type]}`}>
            <strong>{type}: </strong> {quoteText.replace(/\[!.*?\]/, '').trim()}
          </div>
        )
        return
      }
      rendered.push(
        <blockquote key={idx} className="border-l-4 border-white/20 pl-3 py-0.5 italic text-white/60 my-2 text-xs">
          {quoteText}
        </blockquote>
      )
      return
    }

    // Empty lines
    if (!line.trim()) {
      rendered.push(<div key={idx} className="h-1.5" />)
      return
    }

    // Regular paragraph (with basic inline formatting for code and bold)
    let content: React.ReactNode = line
    // Basic inline code helper
    if (line.includes('`')) {
      const parts = line.split('`')
      content = parts.map((part, pIdx) => {
        if (pIdx % 2 === 1) {
          return <code key={pIdx} className="bg-white/10 px-1 py-0.5 rounded font-mono text-[10px] text-indigo-300">{part}</code>
        }
        return part
      })
    }

    rendered.push(<p key={idx} className="text-xs text-white/80 leading-relaxed my-1">{content}</p>)
  })
  
  return rendered
}

export function FileViewerDrawer({ isOpen, onClose, filePath, fileName, onProceed }: FileViewerDrawerProps) {
  const [content, setContent] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen || !filePath) return
    setLoading(true)
    setError(null)
    setContent('')

    const url = `/api/file-content?path=${encodeURIComponent(filePath)}`
    fetch(url, { credentials: 'same-origin' })
      .then(async r => {
        if (!r.ok) {
          const errData = await r.json().catch(() => ({}))
          throw new Error(errData.error || `HTTP error ${r.status}`)
        }
        return r.json()
      })
      .then(d => {
        setContent(d.content || '')
      })
      .catch((err) => {
        setError(err.message || 'Failed to load file content')
      })
      .finally(() => {
        setLoading(false)
      })
  }, [isOpen, filePath])

  if (!isOpen) return null

  const isMarkdown = fileName?.toLowerCase().includes('.md') || filePath?.toLowerCase().includes('.md') || fileName === 'Implementation Plan' || fileName === 'Walkthrough'

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <div className="fixed bottom-0 left-0 right-0 z-50 bg-[#111118] rounded-t-2xl border-t border-white/[0.08] shadow-2xl h-[80vh] flex flex-col">
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 rounded-full bg-white/20" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06] shrink-0">
          <div className="min-w-0 flex-1 overflow-hidden pr-2">
            <h3 className="text-white font-semibold text-[15px] truncate">{fileName || 'File Viewer'}</h3>
            {filePath && <p className="text-white/40 text-[9px] font-mono truncate mt-0.5 w-full block" title={filePath}>{filePath}</p>}
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-3">
            {onProceed && (fileName === 'Implementation Plan' || filePath?.includes('implementation_plan.md')) && (
              <button
                onClick={() => {
                  onProceed()
                  onClose()
                }}
                className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold shadow-lg shadow-indigo-600/20 transition-all flex items-center gap-1.5"
              >
                <span>Proceed</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <polyline points="9 18 15 12 9 6"/>
                </svg>
              </button>
            )}
            <button onClick={onClose} className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/[0.06] transition-colors shrink-0">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 pb-[max(16px,var(--safe-bottom))] bg-[#0a0a0f]">
          {loading && (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <div className="spinner" />
              <p className="text-white/40 text-sm">Loading file content...</p>
            </div>
          )}
          {error && (
            <div className="flex flex-col items-center justify-center h-full text-center p-4">
              <svg className="text-red-400/80 mb-2" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <p className="text-red-400 text-sm font-medium">{error}</p>
            </div>
          )}
          {!loading && !error && (
            <div className="select-text selection:bg-indigo-500/30">
              {isMarkdown ? (
                <div className="markdown-body space-y-1.5 text-white/90">
                  {renderMarkdown(content || '')}
                </div>
              ) : (
                <pre className="font-mono text-xs md:text-sm whitespace-pre-wrap text-white/90 leading-relaxed break-all">
                  {content || <span className="text-white/20 italic">File is empty</span>}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

