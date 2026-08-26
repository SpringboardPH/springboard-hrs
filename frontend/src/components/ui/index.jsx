import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, CalendarDays, Clock, LogOut, HelpCircle } from 'lucide-react'
import clsx from 'clsx'
import AlertModal from './AlertModal'
import MultiSelectCombobox from './MultiSelectCombobox'

export { AlertModal, MultiSelectCombobox }

// ─── PageHeader ───────────────────────────────────────────────
export function PageHeader({ title, description, action, help }) {
  const [helpOpen, setHelpOpen] = useState(false)
  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between mb-5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h1 className="text-lg font-semibold text-gray-900 leading-tight">{title}</h1>
            {help && (
              <button
                onClick={() => setHelpOpen(true)}
                className="text-gray-400 hover:text-brand-600 transition-colors"
                title="Page help"
              >
                <HelpCircle size={16} />
              </button>
            )}
          </div>
          {description && <p className="text-sm text-gray-500 mt-1 max-w-2xl">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {help && (
        <Modal open={helpOpen} onClose={() => setHelpOpen(false)} title={`${title} — Help`} size="md">
          <div className="space-y-5">
            {help.map((section, i) => (
              <div key={i}>
                <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">{section.heading}</p>
                <ul className="space-y-1.5">
                  {section.items.map((item, j) => (
                    <li key={j} className="flex gap-2 text-sm text-gray-700">
                      <span className="text-brand-500 shrink-0 mt-0.5">•</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </>
  )
}

// ─── StatCard ─────────────────────────────────────────────────
export function StatCard({ label, value, icon: Icon, color = 'brand', sub }) {
  const colors = {
    brand:  'bg-brand-50 text-brand-600',
    blue:   'bg-blue-50 text-blue-600',
    yellow: 'bg-yellow-50 text-yellow-600',
    red:    'bg-red-50 text-red-600',
    gray:   'bg-gray-100 text-gray-600',
  }
  return (
    <div className="card p-4 flex items-start gap-4">
      <div className={clsx('w-10 h-10 rounded-lg flex items-center justify-center shrink-0', colors[color])}>
        <Icon size={18} />
      </div>
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
        <p className="text-xl font-semibold text-gray-900 mt-0.5">{value}</p>
        {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
      </div>
    </div>
  )
}

// ─── Spinner ──────────────────────────────────────────────────
export function Spinner({ size = 'md' }) {
  const sizes = { sm: 'w-4 h-4', md: 'w-6 h-6', lg: 'w-10 h-10' }
  return (
    <div className={clsx('border-2 border-brand-600 border-t-transparent rounded-full animate-spin', sizes[size])} />
  )
}

export function PageSpinner() {
  return (
    <div className="flex items-center justify-center h-64">
      <Spinner size="lg" />
    </div>
  )
}

// ─── EmptyState ───────────────────────────────────────────────
export function EmptyState({ icon: Icon, title, description, action }) {
  return (
    <div className="flex flex-col items-center justify-center py-14 text-center">
      {Icon && <Icon size={36} className="text-gray-300 mb-4" />}
      <p className="text-sm font-medium text-gray-600">{title}</p>
      {description && <p className="text-xs text-gray-400 mt-1">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

// ─── Modal ────────────────────────────────────────────────────
export function Modal({ open, onClose, title, children, footer, headerAction, size = 'md' }) {
  useEffect(() => {
    if (!open) return
    const sw = window.innerWidth - document.documentElement.clientWidth
    document.body.style.overflow = 'hidden'
    document.body.style.paddingRight = sw + 'px'
    return () => {
      document.body.style.overflow = ''
      document.body.style.paddingRight = ''
    }
  }, [open])

  if (!open) return null
  const sizes = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className={clsx('relative bg-white rounded-xl shadow-xl w-full flex flex-col max-h-[90vh]', sizes[size])}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0">
          <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
          <div className="flex items-center gap-2">
            {headerAction}
            <button onClick={onClose} className="btn-ghost p-1.5">
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="px-5 py-4 overflow-y-auto flex-1">{children}</div>
        {footer && (
          <div className="px-5 py-4 border-t border-gray-100 shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}

// ─── FormField ────────────────────────────────────────────────
export function FormField({ label, error, children, required }) {
  return (
    <div>
      <label className="label text-xs font-medium text-gray-600 mb-1">
        {label} {required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
      {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
    </div>
  )
}

// ─── Badge helpers ────────────────────────────────────────────
export function StatusBadge({ status }) {
  const map = {
    active:      'badge-green',
    inactive:    'badge-gray',
    terminated:  'badge-red',
    present:     'badge-green',
    late:        'badge-yellow',
    absent:      'badge-red',
    pending:     'badge-yellow',
    approved:    'badge-green',
    rejected:    'badge-red',
    draft:       'badge-gray',
    finalized:   'badge-blue',
    full_time:   'badge-blue',
    part_time:   'badge-yellow',
    contractual: 'badge-gray',
    working:       'badge-green',
    on_leave:      'badge-gray',
    holiday:       'badge-purple',
    undertime:     'badge-orange',
    half_day:      'badge-orange',
    completed:     'badge-green',
    overtime:      'badge-purple',
    not_scheduled: 'badge-gray',
    not_yet:       'badge-gray',
    rest_day:      'badge-blue',
  }
  const labels = {
    on_leave:      'on leave',
    not_scheduled: 'Not Scheduled',
    not_yet:       'Not Yet',
    half_day:      'Half Day',
    rest_day:      'Rest Day',
  }
  const label = labels[status] ?? status?.replace(/_/g, ' ')
  return <span className={map[status] ?? 'badge-gray'}>{label}</span>
}

// ─── ConfirmModal ─────────────────────────────────────────────
export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title = 'Are you sure?',
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  type = 'info'
}) {
  const confirmClasses = clsx(
    'btn font-medium',
    type === 'danger' ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-brand-600 text-white hover:bg-brand-700'
  )

  return (
    <Modal open={open} onClose={onClose} title={title} size="sm">
      <div className="space-y-4">
        {message && <p className="text-sm text-gray-600 leading-relaxed">{message}</p>}
        <div className="flex flex-col-reverse gap-3 pt-2">
          <button onClick={onClose} className="btn-secondary w-full">
            {cancelLabel}
          </button>
          <button
            onClick={() => {
              onConfirm()
              onClose()
            }}
            className={clsx(confirmClasses, 'w-full')}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  )
}
import { getClockWindow } from '../../utils/attendance'

// ─── ScheduleDisplay ──────────────────────────────────────────
export function ScheduleDisplay({ schedule, compact = false, sysClock = null }) {
  const window = getClockWindow(schedule, sysClock)
  if (!window) return (
    <div className="text-xs text-gray-400 italic">No assigned schedule for this week.</div>
  )

  if (window.isInactiveDay) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        {schedule.template?.name} is not scheduled for today.
      </div>
    )
  }

  const { inStart, inEnd, outStart, outEnd, workStart, workEnd, formatTime } = window

  const WindowItem = ({ label, start, end, icon: Icon, color }) => (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">
        <Icon size={12} className={color} /> {label}
      </div>
      <div className="bg-gray-50 border border-gray-100 rounded-lg px-3 py-2">
        <p className="text-sm font-bold text-gray-900">{formatTime(start)} – {formatTime(end)}</p>
        <p className="text-[10px] text-gray-400 mt-0.5">Valid window</p>
      </div>
    </div>
  )

  if (compact) {
    return (
      <div className="text-xs space-y-1">
        <div className="flex justify-between">
          <span className="text-gray-400">IN:</span>
          <span className="font-medium">{formatTime(inStart)}-{formatTime(inEnd)}</span>
        </div>
        <div className="flex justify-between border-t border-gray-50 pt-1">
          <span className="text-gray-400">OUT:</span>
          <span className="font-medium">{formatTime(outStart)}-{formatTime(outEnd)}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-brand-50 flex items-center justify-center text-brand-600">
            <CalendarDays size={16} />
          </div>
          <div>
            <p className="text-xs font-medium text-gray-900">{schedule.template?.name}</p>
            <p className="text-[10px] text-gray-400 uppercase font-bold tracking-tight">Assigned Schedule</p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-xs font-bold text-gray-900">{workStart} – {workEnd}</p>
          <p className="text-[10px] text-gray-400">Today's Shift</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <WindowItem label="Clock In" start={inStart} end={inEnd} icon={Clock} color="text-brand-500" />
        <WindowItem label="Clock Out" start={outStart} end={outEnd} icon={LogOut} color="text-gray-500" />
      </div>
    </div>
  )
}

// ─── PagePagination ───────────────────────────────────────────
export function PagePagination({ pagination, onPageChange }) {
  if (!pagination || pagination.last_page <= 1) return null
  
  const { current_page, last_page } = pagination

  return (
    <div className="flex items-center justify-between">
      <p className="text-xs text-gray-500">
        Page <span className="font-semibold text-gray-900">{current_page}</span> of <span className="font-semibold text-gray-900">{last_page}</span>
      </p>
      <div className="flex items-center gap-2">
        <button
          disabled={current_page === 1}
          onClick={() => onPageChange(current_page - 1)}
          className="btn-secondary py-1 px-3 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Previous
        </button>
        <button
          disabled={current_page === last_page}
          onClick={() => onPageChange(current_page + 1)}
          className="btn-secondary py-1 px-3 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Next
        </button>
      </div>
    </div>
  )
}