import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import clsx from 'clsx'

function toggleValue(values, value) {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value]
}

export default function MultiSelectCombobox({
  options = [],
  value = [],
  onChange,
  getLabel,
  placeholder = 'Select…',
  disabled = false,
}) {
  const rootRef = useRef(null)
  const panelRef = useRef(null)
  const inputRef = useRef(null)
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [panelStyle, setPanelStyle] = useState(null)

  const labelOf = (option) => (getLabel ? getLabel(option) : option)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter((option) => labelOf(option).toLowerCase().includes(q))
  }, [options, query, getLabel])

  function closePanel() {
    setOpen(false)
    setQuery('')
  }

  useLayoutEffect(() => {
    if (!open || !rootRef.current) return

    function place() {
      const rect = rootRef.current.getBoundingClientRect()
      const gap = 4
      const maxPanel = 240
      const spaceBelow = window.innerHeight - rect.bottom - gap
      const spaceAbove = rect.top - gap
      const openUp = spaceBelow < 160 && spaceAbove > spaceBelow
      const maxHeight = Math.min(maxPanel, Math.max(120, openUp ? spaceAbove : spaceBelow))
      setPanelStyle({
        position: 'fixed',
        left: rect.left,
        width: rect.width,
        maxHeight,
        zIndex: 80,
        ...(openUp
          ? { bottom: window.innerHeight - rect.top + gap }
          : { top: rect.bottom + gap }),
      })
    }

    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    function onPointerDown(event) {
      const t = event.target
      if (rootRef.current?.contains(t) || panelRef.current?.contains(t)) return
      closePanel()
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') closePanel()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const selectedSet = useMemo(() => new Set(value), [value])
  const empty = options.length === 0
  const isDisabled = disabled || empty
  const allSelected = !empty && options.every((option) => selectedSet.has(option))

  const summary = allSelected
    ? 'All'
    : value.length === 0
      ? placeholder
      : value.length === 1
        ? labelOf(value[0])
        : `${value.length} selected`

  const panel = open && !isDisabled && panelStyle && createPortal(
    <div
      ref={panelRef}
      id={listId}
      style={panelStyle}
      className="rounded-lg border border-gray-100 bg-white shadow-lg overflow-hidden flex flex-col"
    >
      <div className="p-2 border-b border-gray-100 shrink-0">
        <input
          ref={inputRef}
          type="text"
          className="input text-sm w-full"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search…"
        />
        <div className="flex gap-3 text-xs mt-2">
          <button
            type="button"
            className="text-brand-600 hover:underline disabled:opacity-40"
            disabled={filtered.length === 0}
            onClick={() => onChange([...new Set([...value, ...filtered])])}
          >
            Select all
          </button>
          <button
            type="button"
            className="text-gray-500 hover:underline disabled:opacity-40"
            disabled={value.length === 0}
            onClick={() => onChange([])}
          >
            Clear
          </button>
        </div>
      </div>
      <div className="overflow-y-auto p-1 min-h-0 flex-1">
        {filtered.length === 0 ? (
          <p className="text-xs text-gray-400 px-2 py-3">No matches.</p>
        ) : (
          filtered.map((option) => (
            <label
              key={option}
              className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer px-2 py-1.5 rounded hover:bg-gray-50"
            >
              <input
                type="checkbox"
                className="rounded border-gray-300 text-brand-600 focus:ring-brand-600 h-4 w-4"
                checked={selectedSet.has(option)}
                onChange={() => onChange(toggleValue(value, option))}
              />
              <span className="truncate">{labelOf(option)}</span>
            </label>
          ))
        )}
      </div>
    </div>,
    document.body,
  )

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={isDisabled}
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          if (open) closePanel()
          else if (!isDisabled) setOpen(true)
        }}
        className={clsx(
          'input text-sm w-full flex items-center gap-2 text-left h-10 py-1.5',
          isDisabled && 'opacity-60 cursor-not-allowed',
        )}
      >
        <span className={clsx('flex-1 min-w-0 truncate', value.length === 0 && 'text-gray-400')}>
          {empty ? 'No options' : summary}
        </span>
        <ChevronDown size={14} className={clsx('shrink-0 text-gray-400 transition-transform', open && 'rotate-180')} />
      </button>
      {panel}
    </div>
  )
}
