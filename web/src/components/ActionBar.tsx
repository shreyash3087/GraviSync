import { useState, useRef, useEffect } from 'react'

interface ActionBarProps {
  activeModel: string
  availableModels: { id: string; label: string; badge?: string }[]
  onSetModel: (model: string) => void
  onStop: () => void
  onNewChat: () => void
  onHistory: () => void
  isGenerating?: boolean
}

export function ActionBar({ activeModel, availableModels, onSetModel, onStop, onNewChat, onHistory, isGenerating }: ActionBarProps) {
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  
  const activeModelObj = availableModels.find(m => m.id === activeModel)
  const currentLabel = activeModelObj?.label ?? activeModel

  // Close dropdown on click away
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  return (
    <div className="px-3 py-2 flex items-center gap-2 border-t border-white/[0.04] bg-[#0a0a0f] shrink-0 z-30">
      {/* Model selector — left side */}
      <div className="flex-1 min-w-0 relative" ref={dropdownRef}>
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="w-full flex items-center justify-between gap-1 bg-white/[0.03] hover:bg-white/[0.06] text-white/70 hover:text-white text-[12px] font-medium px-2.5 py-1.5 rounded-xl border border-white/[0.05] transition-all truncate"
          aria-label="Select model"
        >
          <span className="truncate pr-1 text-left">{currentLabel}</span>
          <svg className={`shrink-0 w-3 h-3 text-white/30 transition-transform ${isOpen ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>

        {/* Custom redesigned dropdown popover menu */}
        {isOpen && (
          <div className="absolute bottom-full left-0 mb-2 w-64 bg-[#111118]/95 border border-white/[0.08] rounded-xl shadow-2xl backdrop-blur-xl overflow-hidden z-40 max-h-72 overflow-y-auto">
            <div className="px-3 py-2 text-[10px] text-white/40 font-bold uppercase tracking-wider border-b border-white/[0.04]">
              Model Selection
            </div>
            <div className="py-1">
              {availableModels.map(m => {
                const isActive = m.id === activeModel
                return (
                  <button
                    key={m.id}
                    onClick={() => {
                      onSetModel(m.id)
                      setIsOpen(false)
                    }}
                    className={`w-full flex items-center justify-between px-3 py-2.5 text-left text-xs transition-colors ${
                      isActive 
                        ? 'bg-indigo-500/10 text-indigo-400 font-medium' 
                        : 'text-white/70 hover:bg-white/[0.04] hover:text-white'
                    }`}
                  >
                    <span className="truncate pr-2">{m.label}</span>
                    {m.badge && (
                      <span className={`text-[9px] px-1.5 py-0.5 rounded-md font-semibold uppercase tracking-wider ${
                        isActive
                          ? 'bg-indigo-500/20 text-indigo-300'
                          : 'bg-white/[0.06] text-white/40'
                      }`}>
                        {m.badge}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* Divider */}
      <div className="w-px h-5 bg-white/[0.08] shrink-0" />

      {/* Stop */}
      {isGenerating && (
        <>
          <button
            onClick={onStop}
            className="flex items-center gap-1.5 text-red-400/80 hover:text-red-400 transition-colors text-[12px] px-2 py-1.5 rounded-lg hover:bg-red-500/10 font-medium shrink-0 animate-pulse"
            aria-label="Stop generation"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
              <rect x="5" y="5" width="14" height="14" rx="2"/>
            </svg>
            <span>Stop</span>
          </button>
          <div className="w-px h-5 bg-white/[0.08] shrink-0" />
        </>
      )}

      {/* New Chat */}
      <button
        onClick={onNewChat}
        className="flex items-center gap-1.5 text-white/50 hover:text-white/90 transition-colors text-[12px] px-2 py-1.5 rounded-lg hover:bg-white/[0.05]"
        aria-label="New chat"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>
        </svg>
        <span>New</span>
      </button>

      {/* History */}
      <button
        onClick={onHistory}
        className="flex items-center gap-1.5 text-white/50 hover:text-white/90 transition-colors text-[12px] px-2 py-1.5 rounded-lg hover:bg-white/[0.05]"
        aria-label="Chat history"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="1 4 1 10 7 10"/>
          <path d="M3.51 15a9 9 0 102.13-9.36L1 10"/>
        </svg>
        <span>History</span>
      </button>
    </div>
  )
}
