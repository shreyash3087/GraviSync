import { useEffect, useRef, useState, useCallback } from 'react'

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

export interface SnapshotData {
  html: string
  css?: string
  scrollTop?: number
  scrollHeight?: number
  clientHeight?: number
}

export interface AppStateData {
  model?: string
  mode?: string
  hasPendingActions?: boolean
  isGenerating?: boolean
}

export interface WsMessage {
  type: 'snapshot' | 'state' | 'notification' | 'clients' | 'ping'
  data?: SnapshotData | AppStateData | { title?: string; body?: string; actions?: unknown[] }
  timestamp?: number
}

const WS_RECONNECT_INITIAL = 1000
const WS_RECONNECT_MAX = 30000
const PING_INTERVAL = 25000

export function useWebSocket() {
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [latency, setLatency] = useState<number | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotData | null>(null)
  const [appState, setAppState] = useState<AppStateData>({})

  const wsRef = useRef<WebSocket | null>(null)
  const reconnectDelay = useRef(WS_RECONNECT_INITIAL)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastPingTime = useRef(0)
  const lastHtml = useRef('')

  const send = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    }
  }, [])

  const sanitize = (html: string) =>
    html
      .replace(/\b\d+ms\b/g, '')
      .replace(/\bWorked for [\d\s\w]+s?\b/gi, '')
      .replace(/\bThought for [\d\s\w]+s?\b/gi, '')
      .replace(/\b(Waiting for user input|Exploring|Analyzing|Thinking|Running|Generating|Loading).*/gi, '$1')

  const connect = useCallback(() => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${location.host}/ws`)
    wsRef.current = ws
    setStatus('connecting')

    ws.onopen = () => {
      setStatus('connected')
      reconnectDelay.current = WS_RECONNECT_INITIAL
      pingTimer.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          lastPingTime.current = Date.now()
          ws.send(JSON.stringify({ type: 'pong' }))
        }
      }, PING_INTERVAL)
    }

    ws.onmessage = (event) => {
      try {
        const msg: WsMessage = JSON.parse(event.data)
        switch (msg.type) {
          case 'snapshot': {
            const data = msg.data as SnapshotData
            if (!data?.html) break
            if (sanitize(data.html) === sanitize(lastHtml.current)) break
            lastHtml.current = data.html
            setSnapshot(data)
            if (msg.timestamp) {
              setLatency(Math.max(0, Date.now() - msg.timestamp))
            }
            break
          }
          case 'state':
            setAppState(msg.data as AppStateData)
            break
          case 'ping':
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'pong' }))
            }
            break
          case 'notification': {
            const n = msg.data as { title?: string; body?: string }
            if (Notification.permission === 'granted') {
              new Notification(n?.title || 'AG Remote', { body: n?.body || '' })
            }
            break
          }
          default:
            break
        }
      } catch {}
    }

    ws.onclose = () => {
      setStatus('disconnected')
      wsRef.current = null
      lastHtml.current = ''
      if (pingTimer.current) clearInterval(pingTimer.current)
      if (!reconnectTimer.current) {
        reconnectTimer.current = setTimeout(() => {
          reconnectTimer.current = null
          connect()
        }, reconnectDelay.current)
        reconnectDelay.current = Math.min(reconnectDelay.current * 2, WS_RECONNECT_MAX)
      }
    }

    ws.onerror = () => {}
  }, [])

  useEffect(() => {
    connect()
    return () => {
      if (pingTimer.current) clearInterval(pingTimer.current)
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
    }
  }, [connect])

  return { status, latency, snapshot, appState, send }
}
