import type { ConnectionStatus } from '../hooks/useWebSocket'

interface StatusBarProps {
  status: ConnectionStatus
  latency: number | null
  onSettingsOpen: () => void
}

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  connected: 'Connected',
  connecting: 'Connecting...',
  disconnected: 'Disconnected',
}

const STATUS_COLORS: Record<ConnectionStatus, string> = {
  connected: '#22c55e',
  connecting: '#f59e0b',
  disconnected: '#ef4444',
}

export function StatusBar({ status, latency, onSettingsOpen }: StatusBarProps) {
  return (
    <header className="flex items-center justify-between px-4 h-11 border-b border-white/[0.06] bg-[#0a0a0f] shrink-0">
      {/* Left: connection dot + label */}
      <div className="flex items-center gap-2">
        <span
          className="w-2 h-2 rounded-full"
          style={{
            background: STATUS_COLORS[status],
            boxShadow: status === 'connected' ? `0 0 6px ${STATUS_COLORS[status]}` : 'none',
          }}
        />
        <span className="text-white/70 text-[13px] font-medium">{STATUS_LABELS[status]}</span>
      </div>

      {/* Right: latency badge + settings */}
      <div className="flex items-center gap-3">
        <span className="text-white/40 text-[12px] tabular-nums">
          {latency !== null ? `${latency}ms` : '--ms'}
        </span>
        <button
          onClick={onSettingsOpen}
          className="p-1.5 rounded-lg text-white/50 hover:text-white hover:bg-white/[0.06] transition-colors"
          aria-label="Settings"
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
          </svg>
        </button>
      </div>
    </header>
  )
}
