import { useState, useRef, useEffect, useCallback } from 'react'

interface InputBarProps {
  onSend: (text: string) => void
  onFocusChange: (focused: boolean) => void
  filePreview: { name: string; dataUrl: string } | null
  onClearFile: () => void
  isGenerating?: boolean
  onStop?: () => void
}

const AUTOCOMPLETE_CATEGORIES = [
  { name: 'Files', icon: '📄' },
  { name: 'Directories', icon: '📁' },
  { name: 'Code Context Items', icon: '🔍' },
  { name: 'Rules', icon: '📜' },
  { name: 'Terminal', icon: '💻' },
  { name: 'Conversation', icon: '💬' },
]

type AcItem = { type: 'category' | 'file'; name: string; icon: string; textToInsert: string }

export function InputBar({
  onSend,
  onFocusChange,
  filePreview,
  onClearFile,
  isGenerating,
  onStop
}: InputBarProps) {
  const [text, setText] = useState('')
  const [isRecording, setIsRecording] = useState(false)
  const [acItems, setAcItems] = useState<AcItem[]>([])
  const [acVisible, setAcVisible] = useState(false)
  const [acIdx, setAcIdx] = useState(-1)
  const [atPos, setAtPos] = useState(-1)
  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([])

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Load workspace files
  useEffect(() => {
    const load = () => {
      fetch('/api/workspace-files', { credentials: 'same-origin' })
        .then(r => r.json())
        .then(d => { if (d?.files) setWorkspaceFiles(d.files) })
        .catch(() => {})
    }
    const t = setTimeout(load, 2000)
    const i = setInterval(load, 45000)
    return () => { clearTimeout(t); clearInterval(i) }
  }, [])

  // Auto-grow textarea
  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 120) + 'px'
  }, [])

  const handleChange = (val: string) => {
    setText(val)
    resizeTextarea()
    // @mention autocomplete
    const cursor = textareaRef.current?.selectionStart ?? val.length
    const before = val.slice(0, cursor)
    const lastAt = before.lastIndexOf('@')
    if (lastAt !== -1 && (lastAt === 0 || /\s/.test(before[lastAt - 1]))) {
      const term = before.slice(lastAt + 1)
      if (!/\s/.test(term)) {
        showAc(term, lastAt)
        return
      }
    }
    hideAc()
  }

  const showAc = (term: string, pos: number) => {
    const tl = term.toLowerCase()
    const cats: AcItem[] = AUTOCOMPLETE_CATEGORIES
      .filter(c => c.name.toLowerCase().includes(tl))
      .map(c => ({ type: 'category', name: c.name, icon: c.icon, textToInsert: `@${c.name} ` }))
    const files: AcItem[] = (tl ? workspaceFiles.filter(f => f.toLowerCase().includes(tl)) : workspaceFiles.slice(0, 5))
      .slice(0, 12)
      .map(f => ({ type: 'file', name: f, icon: '📄', textToInsert: `@${f} ` }))
    const items = [...cats, ...files]
    if (items.length === 0) { hideAc(); return }
    setAcItems(items)
    setAtPos(pos)
    setAcIdx(-1)
    setAcVisible(true)
  }

  const hideAc = () => { setAcVisible(false); setAcIdx(-1); setAtPos(-1) }

  const insertAc = (item: AcItem) => {
    const el = textareaRef.current
    if (!el) return
    const before = text.slice(0, atPos)
    const after = text.slice(el.selectionStart)
    const next = before + item.textToInsert + after
    setText(next)
    hideAc()
    el.focus()
    requestAnimationFrame(resizeTextarea)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (acVisible) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setAcIdx(i => (i + 1) % acItems.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setAcIdx(i => (i - 1 + acItems.length) % acItems.length); return }
      if ((e.key === 'Enter' || e.key === 'Tab') && acIdx >= 0) { e.preventDefault(); insertAc(acItems[acIdx]); return }
      if (e.key === 'Escape') { e.preventDefault(); hideAc(); return }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleSend = () => {
    const t = text.trim()
    if (!t) return
    onSend(t)
    setText('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.blur()
    }
  }

  // Speech
  const toggleRecording = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const win = window as any
    const SR = win.SpeechRecognition || win.webkitSpeechRecognition
    if (!SR) return

    if (isRecording) {
      recognitionRef.current?.stop()
      setIsRecording(false)
      return
    }
    const r = new SR()
    r.continuous = false
    r.interimResults = false
    r.lang = 'en-US'
    r.onstart = () => setIsRecording(true)
    r.onend = () => setIsRecording(false)
    r.onerror = () => setIsRecording(false)
    r.onresult = (ev: { results: { [x: number]: { [x: number]: { transcript: string } } } }) => {
      const t = ev.results[0][0].transcript
      if (t) {
        setText(prev => (prev + ' ' + t).trim())
        requestAnimationFrame(resizeTextarea)
      }
    }
    recognitionRef.current = r
    r.start()
  }

  const hasText = text.trim().length > 0

  return (
    <div className="bg-[#0a0a0f] border-t border-white/[0.06] px-3 pt-2 pb-[max(12px,var(--safe-bottom))] shrink-0">
      {/* File preview */}
      {filePreview && (
        <div className="mb-2 px-1">
          <div className="file-preview-item">
            <img src={filePreview.dataUrl} alt={filePreview.name} />
            <button className="file-preview-remove" onClick={onClearFile}>×</button>
          </div>
        </div>
      )}

      {/* Autocomplete popup */}
      {acVisible && acItems.length > 0 && (
        <div className="mb-2 bg-[#1a1a2e] border border-white/[0.08] rounded-xl overflow-hidden max-h-48 overflow-y-auto shadow-xl">
          <div className="px-3 py-2 text-[11px] text-white/40 font-medium uppercase tracking-wide border-b border-white/[0.05]">
            Recommendations
          </div>
          {acItems.map((item, idx) => (
            <button
              key={idx}
              className={`autocomplete-item w-full text-left ${idx === acIdx ? 'selected' : ''}`}
              onMouseDown={e => { e.preventDefault(); insertAc(item) }}
            >
              <span className="text-sm">{item.icon}</span>
              <span className="truncate">{item.name}</span>
            </button>
          ))}
        </div>
      )}

      {/* Input pill */}
      <div className="flex items-end gap-2 bg-white/[0.05] rounded-2xl px-3 py-2 border border-white/[0.07]">
        {/* Attach */}
        <button
          className="text-white/40 hover:text-white/80 transition-colors p-1 shrink-0 mb-0.5"
          aria-label="Attach file"
          onClick={() => fileInputRef.current?.click()}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept="image/*,video/*,application/pdf"
          onChange={e => {
            const file = e.target.files?.[0]
            if (!file) return
            const reader = new FileReader()
            reader.onload = (ev) => {
              const dataUrl = ev.target?.result as string
              fetch('/api/upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fileName: file.name, fileType: file.type, fileData: dataUrl }),
                credentials: 'same-origin'
              }).catch(() => {})
            }
            reader.readAsDataURL(file)
            e.target.value = ''
          }}
        />

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          placeholder="Ask anything, @ to mention..."
          className="flex-1 bg-transparent text-white text-[14px] resize-none outline-none placeholder:text-white/30 leading-5 max-h-[120px] py-1"
          onChange={e => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => onFocusChange(true)}
          onBlur={() => onFocusChange(false)}
          autoComplete="off"
        />

        {/* Mic */}
        <button
          className={`text-white/40 hover:text-white/80 transition-colors p-1 shrink-0 mb-0.5 rounded-full ${isRecording ? 'recording text-indigo-400' : ''}`}
          aria-label="Voice input"
          onClick={toggleRecording}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/>
            <path d="M19 10v2a7 7 0 01-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="23"/>
            <line x1="8" y1="23" x2="16" y2="23"/>
          </svg>
        </button>

        {/* Stop or Send */}
        {isGenerating ? (
          <button
            onClick={onStop}
            className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-600/30 transition-all mb-0.5"
            aria-label="Stop generation"
          >
            {/* Red Stop Square Icon */}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <rect x="4" y="4" width="16" height="16" rx="2" />
            </svg>
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!hasText}
            className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-all mb-0.5 ${
              hasText
                ? 'bg-indigo-500 hover:bg-indigo-400 text-white shadow-lg shadow-indigo-500/30'
                : 'bg-white/[0.06] text-white/30 cursor-not-allowed'
            }`}
            aria-label="Send message"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}
