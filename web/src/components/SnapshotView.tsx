import { useRef, useCallback, useEffect } from 'react'
import type { SnapshotData } from '../hooks/useWebSocket'

interface SnapshotViewProps {
  snapshot: SnapshotData | null
  onAction: (type: string, data: object) => void
  isInputFocused: boolean
  onOpenFile?: (path: string, name: string) => void
}

const MODEL_NAMES: Record<string, string> = {
  'gemini-3.5-flash-high': 'Gemini 3.5 Flash (High)',
  'gemini-3.5-flash-medium': 'Gemini 3.5 Flash (Medium)',
  'gemini-3.5-flash-low': 'Gemini 3.5 Flash (Low)',
  'gemini-3.1-pro-high': 'Gemini 3.1 Pro (High)',
  'gemini-3.1-pro-low': 'Gemini 3.1 Pro (Low)',
  'claude-sonnet-4.6': 'Claude Sonnet 4.6',
  'claude-opus-4.6': 'Claude Opus 4.6',
  'gpt-oss-120b': 'GPT-OSS 120B',
}

function normalizeModel(name: string) {
  if (!name) return 'unknown'
  const clean = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (clean.includes('gemini35') && clean.includes('high')) return 'gemini-3.5-flash-high'
  if (clean.includes('gemini35') && clean.includes('medium')) return 'gemini-3.5-flash-medium'
  if (clean.includes('gemini35') && clean.includes('low')) return 'gemini-3.5-flash-low'
  if (clean.includes('gemini31') && clean.includes('high')) return 'gemini-3.1-pro-high'
  if (clean.includes('gemini31') && clean.includes('low')) return 'gemini-3.1-pro-low'
  if (clean.includes('claudesonnet')) return 'claude-sonnet-4.6'
  if (clean.includes('claudeopus')) return 'claude-opus-4.6'
  if (clean.includes('gptoss')) return 'gpt-oss-120b'
  return name
}

export function SnapshotView({ snapshot, onAction, isInputFocused, onOpenFile }: SnapshotViewProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const prevHtmlRef = useRef('')
  const cssInjectedRef = useRef(false)

  // Inject snapshot HTML + CSS into the wrapper div
  useEffect(() => {
    if (!snapshot || isInputFocused) return
    const wrap = wrapRef.current
    if (!wrap) return
    if (snapshot.html === prevHtmlRef.current) return
    prevHtmlRef.current = snapshot.html

    // Preserve scroll position
    const parent = wrap.parentElement
    const prevScroll = parent?.scrollTop ?? 0

    // Inject
    wrap.innerHTML = snapshot.html

    // Restore scroll (if we were near the bottom, stay there)
    if (parent) {
      const nearBottom = (prevScroll + parent.clientHeight + 100) >= parent.scrollHeight
      if (nearBottom) {
        parent.scrollTop = parent.scrollHeight
      } else {
        parent.scrollTop = prevScroll
      }
    }
  }, [snapshot, isInputFocused])

  // Inject the VS Code snapshot CSS into <head> once when it first arrives.
  // The server sends snapshot.css only on the first snapshot after connect, so we
  // track injection via a ref and persist the <style> tag for the session.
  useEffect(() => {
    if (!snapshot?.css || cssInjectedRef.current) return
    cssInjectedRef.current = true
    const existing = document.getElementById('ag-snapshot-css')
    if (!existing) {
      const style = document.createElement('style')
      style.id = 'ag-snapshot-css'
      style.textContent = snapshot.css
      document.head.appendChild(style)
    }
  }, [snapshot?.css])

  // Click delegation
  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const wrap = wrapRef.current
    if (!wrap) return

    // Walk up from the clicked element to find an interactive one
    let el = e.target as HTMLElement | null
    while (el && el !== wrap) {
      const tag = el.tagName
      const role = el.getAttribute('role')
      const isButton = tag === 'BUTTON' || role === 'button'
      const isLink = tag === 'A'
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
      const isSummary = tag === 'SUMMARY' || tag === 'DETAILS'
      const isLabel = tag === 'LABEL'
      const isCard = el.classList.contains('artifact-card') || (el.className && typeof el.className === 'string' && el.className.includes('artifact-card'))
      const isListItem = tag === 'LI' || role === 'option' || role === 'radio' || role === 'listitem' || isLabel || isCard
      const hasAgId = el.hasAttribute('data-ag-id')

      if (isButton || isLink || isInput || isSummary || isListItem || hasAgId) {
        // Don't capture contenteditable or plain text inputs
        if (el.getAttribute('contenteditable') === 'true') return

        const type = (el as HTMLInputElement).type?.toLowerCase() ?? ''
        const isCheckOrRadio = tag === 'INPUT' && (type === 'checkbox' || type === 'radio')

        // LOCAL UX UPDATE: If clicking an option, radio, label, or list item, immediately highlight it locally
        const targetOption = el.closest('li, [role="option"], [role="radio"], label, [class*="option"], [class*="choice"]')
        if (targetOption) {
          // Find the parent container or sibling group to scope unselection
          const group = targetOption.closest('[role="radiogroup"], [role="listbox"]') || targetOption.parentElement
          if (group) {
            group.querySelectorAll('li, [role="option"], [role="radio"], label, [class*="option"], [class*="choice"]').forEach(sibling => {
              sibling.removeAttribute('data-ag-selected')
              sibling.classList.remove('ag-selected', 'bg-secondary', 'border-border')
              // Uncheck child input if checkbox or radio
              const input = sibling.querySelector('input')
              if (input) {
                input.checked = false
                input.removeAttribute('checked')
              }
            })
          }
          targetOption.setAttribute('data-ag-selected', 'true')
          targetOption.classList.add('ag-selected')
          // Check child input if checkbox or radio
          const input = targetOption.querySelector('input')
          if (input) {
            input.checked = true
            input.setAttribute('checked', '')
          }
        }

        if (!isCheckOrRadio && !isSummary) {
          e.preventDefault()
        }
        e.stopPropagation()

        const agId = el.getAttribute('data-ag-id')
        const text = (el.textContent || '').trim()
        const label = (el.getAttribute('aria-label') || '').trim()
        const testid = (el.getAttribute('data-testid') || '').trim()
        const actionText = text || label || testid || type || tag

        // Compute occurrence index
        let occurrenceIndex = 0
        if (actionText) {
          const lower = actionText.toLowerCase()
          const matches = Array.from(wrap.querySelectorAll('[data-ag-id]')).filter(m => {
            const t = (m.textContent || '').trim().toLowerCase()
            const l = (m.getAttribute('aria-label') || '').trim().toLowerCase()
            const d = (m.getAttribute('data-testid') || '').trim().toLowerCase()
            return t.includes(lower) || l.includes(lower) || d.includes(lower)
          })
          occurrenceIndex = matches.indexOf(el)
          if (occurrenceIndex < 0) occurrenceIndex = 0
        }

        const cardEl = el.closest('.artifact-card')
        if (cardEl && onOpenFile) {
          const cardText = cardEl.textContent || ''
          let targetFile = ''
          let neatName = ''
          const lowerText = cardText.toLowerCase()
          
          // Check for special/known artifacts first so text contents (like mentioning "Next.js") don't hijack them
          if (lowerText.includes('implementation') && lowerText.includes('plan')) {
            targetFile = 'implementation_plan.md'
            neatName = 'Implementation Plan'
          } else if (lowerText.includes('walkthrough')) {
            targetFile = 'walkthrough.md'
            neatName = 'Walkthrough'
          } else {
            // Check for explicit files ending in common extensions
            const fileMatch = cardText.match(/[\w\-_\.\/]+\.(md|txt|json|js|ts|tsx|css|py|sh|yml|yaml|go|rs|c|cpp|h)\b/i)
            if (fileMatch) {
              targetFile = fileMatch[0]
              neatName = targetFile.substring(targetFile.lastIndexOf('/') + 1)
            }
          }
          if (targetFile) {
            e.preventDefault()
            e.stopPropagation()
            onOpenFile(targetFile, neatName)

            // Notify server of the click
            const agId = el.getAttribute('data-ag-id') || cardEl.getAttribute('data-ag-id')
            onAction('click', { target: { tag, text: actionText, occurrenceIndex, agId } })
            return
          }
        }

        if (isLink && onOpenFile) {
          const href = el.getAttribute('href') || ''
          const isFileLink = href.startsWith('file://') || 
                             href.startsWith('vscode-file://') ||
                             /\.(md|txt|json|js|ts|tsx|css|py|sh|yml|yaml|go|rs|c|cpp|h)$/i.test(href) ||
                             href.includes('implementation_plan.md') ||
                             href.includes('walkthrough.md')

          if (isFileLink) {
            e.preventDefault()
            e.stopPropagation()
            // Extract a neat filename for header
            const name = el.textContent?.trim() || href.substring(href.lastIndexOf('/') + 1)
            onOpenFile(href, name)

            // Still send the click event to VS Code so it's in sync
            const agId = el.getAttribute('data-ag-id')
            onAction('click', { target: { tag, text: actionText, occurrenceIndex, agId } })
            return
          }
        }

        onAction('click', { target: { tag, text: actionText, occurrenceIndex, agId } })

        if (isCheckOrRadio) {
          onAction('formInput', {
            target: { agId, value: (el as HTMLInputElement).value, checked: (el as HTMLInputElement).checked }
          })
        }

        return
      }
      el = el.parentElement
    }
  }, [onAction, onOpenFile])

  if (!snapshot) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 px-6 text-center">
        <div className="spinner" />
        <p className="text-white/50 text-sm">Waiting for Antigravity session...</p>
        <p className="text-white/30 text-xs">Make sure Antigravity has an active chat open</p>
      </div>
    )
  }

  return (
    <div
      className="snapshot-wrap"
      ref={wrapRef}
      onClick={handleClick}
    />
  )
}
