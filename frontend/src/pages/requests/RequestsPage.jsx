import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { format, differenceInDays } from 'date-fns'
import {
  getRequests, approveRequest, rejectRequest, requestKeys,
  getLeaves, createLeave, approveLeave, rejectLeave, leaveKeys,
  createRequest,
  getLeaveTypes, getEmployees, getSystemClock, getLeaveBalance,
  leaveTypeKeys, employeeKeys, systemClockKeys, dashboardKeys,
} from '../../api/queries'
import { PageHeader, PageSpinner, StatusBadge, Modal, FormField, Spinner, ConfirmModal, PagePagination } from '../../components/ui/index.jsx'
import { Check, X, Eye, ClipboardList, Plus, CalendarOff, AlertCircle } from 'lucide-react'

const REQUEST_TYPES = [
  { value: 'overtime',        label: 'Overtime' },
  { value: 'half_day',        label: 'Half-Day' },
  { value: 'undertime',       label: 'Undertime' },
  { value: 'schedule_change', label: 'Schedule Change' },
  { value: 'coe',             label: 'Certificate of Employment' },
  { value: 'concern',         label: 'Concern' },
  { value: 'cash_advance',    label: 'Cash Advance' },
]

function formatType(type) {
  if (!type) return '—'
  return REQUEST_TYPES.find(t => t.value === type)?.label ?? type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function formatMeta(meta) {
  if (!meta || typeof meta !== 'object') return null
  return Object.entries(meta).map(([key, value]) => ({
    label: key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    value: value !== null && value !== undefined ? String(value) : '—',
  }))
}

const EMPTY_FORM = { employee_id: '', type: 'request', leave_type: '', start_date: '', end_date: '', reason: '', request_type: 'overtime', subject: '', details: '', date: '', start_time: '', end_time: '', half: 'am', departure_time: '', principal: '', term_count: '', interest_rate: '' }

export default function RequestsPage() {
  const [tab, setTab]               = useState('requests')
  const [status, setStatus]         = useState('pending')
  const [typeFilter, setTypeFilter] = useState('')
  const [reqPage, setReqPage]       = useState(1)
  const [leavePage, setLeavePage]   = useState(1)
  const [viewRequest, setViewRequest]     = useState(null)
  const [rejectModal, setRejectModal]     = useState(null)
  const [rejectNotes, setRejectNotes]     = useState('')
  const [approveTarget, setApproveTarget] = useState(null)
  const [approveNotes, setApproveNotes]   = useState('')
  const [viewLeave, setViewLeave]           = useState(null)
  const [rejectLeaveModal, setRejectLeaveModal] = useState(null)
  const [rejectLeaveReason, setRejectLeaveReason] = useState('')
  const [confirmConfig, setConfirmConfig] = useState({ open: false, onConfirm: () => {}, message: '', title: '' })
  const [createModal, setCreateModal] = useState(false)
  const [form, setForm]             = useState(EMPTY_FORM)
  const [createError, setCreateError] = useState('')
  const qc = useQueryClient()

  const { data: reqData, isLoading: loadingReq } = useQuery({
    queryKey: requestKeys.list({ status, request_type: typeFilter || undefined, page: reqPage }),
    queryFn: () => getRequests({ status, page: reqPage, ...(typeFilter ? { request_type: typeFilter } : {}) }),
  })
  const { data: leaveData, isLoading: loadingLeave } = useQuery({
    queryKey: leaveKeys.list({ status, page: leavePage }),
    queryFn: () => getLeaves({ status, page: leavePage }),
  })
  const { data: employees } = useQuery({
    queryKey: employeeKeys.list({}),
    queryFn: () => getEmployees({ status: 'active' }),
  })
  const { data: leaveTypes } = useQuery({
    queryKey: leaveTypeKeys.all,
    queryFn: () => getLeaveTypes(),
  })
  const { data: systemClock } = useQuery({
    queryKey: systemClockKeys.all,
    queryFn: getSystemClock,
  })
  const { data: balanceData } = useQuery({
    queryKey: leaveKeys.balance(form.employee_id || null),
    queryFn: () => getLeaveBalance(form.employee_id || null),
    enabled: createModal && form.type === 'leave' && !!form.employee_id,
  })

  const isWithinWindow = (createdAt) => {
    if (!systemClock?.date) return true
    return differenceInDays(new Date(systemClock.date), new Date(createdAt)) <= 3
  }

  const approveMutation = useMutation({
    mutationFn: ({ id, notes }) => approveRequest(id, notes || null),
    onSuccess: () => { qc.invalidateQueries({ queryKey: requestKeys.all }); qc.invalidateQueries({ queryKey: dashboardKeys.all }); setApproveTarget(null); setApproveNotes('') },
  })
  const rejectMutation = useMutation({
    mutationFn: ({ id, notes }) => rejectRequest(id, notes),
    onSuccess: () => { qc.invalidateQueries({ queryKey: requestKeys.all }); qc.invalidateQueries({ queryKey: dashboardKeys.all }); setRejectModal(null); setRejectNotes('') },
  })
  const approveLeaveMutation = useMutation({
    mutationFn: approveLeave,
    onSuccess: () => { qc.invalidateQueries({ queryKey: leaveKeys.all }); qc.invalidateQueries({ queryKey: dashboardKeys.all }) },
  })
  const rejectLeaveMutation = useMutation({
    mutationFn: ({ id, reason }) => rejectLeave(id, reason),
    onSuccess: () => { qc.invalidateQueries({ queryKey: leaveKeys.all }); qc.invalidateQueries({ queryKey: dashboardKeys.all }); setRejectLeaveModal(null); setRejectLeaveReason('') },
  })
  const createMutation = useMutation({
    mutationFn: (data) => form.type === 'leave'
      ? createLeave(data)
      : createRequest(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: requestKeys.all })
      qc.invalidateQueries({ queryKey: leaveKeys.all })
      setCreateModal(false)
      setForm(EMPTY_FORM)
      setCreateError('')
    },
    onError: (err) => setCreateError(err?.response?.data?.message || 'Failed to submit'),
  })

  const activeEmps  = employees?.data ?? []
  const activeTypes = leaveTypes ?? []
  const requests    = reqData?.data ?? []
  const leaves      = leaveData?.data ?? []
  const reqPagination   = reqData?.pagination
  const leavePagination = leaveData?.pagination

  const includeWeekends  = Boolean(balanceData?.policy?.include_weekends)
  const selectedBalance  = balanceData?.balances?.[form.leave_type]
  const calculateDays    = (start, end) => {
    if (!start || !end) return 0
    const s = new Date(`${start}T00:00:00`)
    const e = new Date(`${end}T00:00:00`)
    if (isNaN(s) || isNaN(e) || e < s) return 0
    let count = 0; const cur = new Date(s)
    while (cur <= e) { const d = cur.getDay(); if (includeWeekends || (d !== 0 && d !== 6)) count++; cur.setDate(cur.getDate() + 1) }
    return count
  }
  const requestedDays = calculateDays(form.start_date, form.end_date)

  useEffect(() => {
    if (!createModal) { setForm(EMPTY_FORM); setCreateError('') }
  }, [createModal])

  const handleApproveLeave = (leave) => {
    setConfirmConfig({
      open: true, title: 'Approve Leave Request',
      message: `Approve leave for ${leave.employee?.first_name} ${leave.employee?.last_name}?`,
      onConfirm: () => approveLeaveMutation.mutate(leave.id), type: 'info',
    })
  }

  const handleCreateSubmit = () => {
    setCreateError('')
    if (!form.employee_id) return setCreateError('Employee is required.')
    if (form.type === 'leave') {
      if (!form.leave_type || !form.start_date || !form.end_date) return setCreateError('Leave type, start date, and end date are required.')
      createMutation.mutate({ employee_id: form.employee_id, leave_type: form.leave_type, start_date: form.start_date, end_date: form.end_date, reason: form.reason || null })
    } else {
      if (!form.request_type || !form.subject.trim()) return setCreateError('Request type and subject are required.')
      const t = form.request_type
      if (['overtime', 'half_day', 'undertime', 'schedule_change'].includes(t) && !form.date) return setCreateError('Date is required for this request type.')
      if (t === 'overtime' && (!form.start_time || !form.end_time)) return setCreateError('Start and end time are required for overtime.')
      if (t === 'undertime' && !form.departure_time) return setCreateError('Departure time is required for undertime.')
      if (t === 'cash_advance') {
        const principal = Number(form.principal)
        const termCount = Number(form.term_count)
        if (!form.principal || isNaN(principal) || principal < 1) return setCreateError('Amount must be at least ₱1.')
        if (!form.term_count || isNaN(termCount) || termCount < 1 || !Number.isInteger(termCount)) return setCreateError('Term (number of cutoffs) must be a whole number of 1 or more.')
      }
      let meta = null
      if (t === 'overtime')        meta = { date: form.date, start_time: form.start_time, end_time: form.end_time }
      else if (t === 'half_day')   meta = { date: form.date, half: form.half }
      else if (t === 'undertime')  meta = { date: form.date, departure_time: form.departure_time }
      else if (t === 'schedule_change') meta = { date: form.date }
      else if (t === 'cash_advance') meta = { principal: Number(form.principal), term_count: Number(form.term_count), interest_rate: form.interest_rate ? Number(form.interest_rate) : 0 }
      createMutation.mutate({ employee_id: form.employee_id, request_type: form.request_type, subject: form.subject, details: form.details || null, meta })
    }
  }

  const f = (k, v) => setForm(p => ({ ...p, [k]: v }))

  return (
    <div>
      <PageHeader
        title="Employee Requests"
        description="Review and action employee requests and leaves"
        action={
          <button onClick={() => setCreateModal(true)} className="btn-primary">
            <Plus size={14} /> New Request
          </button>
        }
        help={[
          { heading: 'Tabs', items: [
            'Switch between the Requests tab (overtime, half-day, COE, concerns, etc.) and the Leaves tab using the tab buttons.',
          ]},
          { heading: 'Filtering', items: [
            'Filter by status — Pending, Approved, or Rejected — using the status buttons.',
            'On the Requests tab, further narrow by request type using the type dropdown.',
          ]},
          { heading: 'Approving & Rejecting', items: [
            'Click the check icon on a pending row to approve it. A confirmation dialog will appear.',
            'Click the X icon to reject it. A confirmation dialog will appear.',
            'Click the eye icon to view the full details of any request.',
            'Approving a Cash Advance request creates an active loan for that employee, visible on the Loans page, which is then repaid automatically as a payroll deduction each cutoff.',
          ]},
          { heading: 'New Request (on behalf of employee)', items: [
            'Click New Request to file a request for a specific employee.',
            'Select the employee, choose a category (Request or Leave), and fill in the relevant fields.',
            'Leave requests require selecting a leave type and a date range.',
            'Cash Advance requests require an amount, a term (number of cutoffs to repay over), and an optional interest rate.',
          ]},
          { heading: 'Leave Details', items: [
            'On the Leaves tab, the start date, end date, and number of working days affected are shown in each row.',
          ]},
        ]}
      />

      <ConfirmModal
        open={confirmConfig.open}
        onClose={() => setConfirmConfig({ ...confirmConfig, open: false })}
        onConfirm={confirmConfig.onConfirm}
        title={confirmConfig.title}
        message={confirmConfig.message}
        type={confirmConfig.type}
      />

      {/* Filter row */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="flex gap-1 bg-brand-50 p-1 rounded-lg w-fit">
          {[['requests', 'Requests', ClipboardList], ['leaves', 'Leaves', CalendarOff]].map(([t, lbl, Icon]) => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex items-center gap-1.5 px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${tab === t ? 'bg-brand-500 text-white shadow-sm' : 'text-brand-700 hover:text-brand-900'}`}>
              <Icon size={13} />{lbl}
            </button>
          ))}
        </div>
        <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
          {['pending', 'approved', 'rejected'].map(s => (
            <button key={s} onClick={() => { setStatus(s); setReqPage(1); setLeavePage(1) }}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors capitalize ${status === s ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
              {s}
            </button>
          ))}
        </div>
        {tab === 'requests' && (
          <select value={typeFilter} onChange={e => { setTypeFilter(e.target.value); setReqPage(1) }} className="input py-1.5 text-sm w-auto">
            <option value="">All Types</option>
            {REQUEST_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        )}
      </div>

      {/* Requests table */}
      {tab === 'requests' && (
        loadingReq ? <PageSpinner /> : (
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>{['Employee', 'Type', 'Subject', 'Filed', 'Status', 'Actions'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">{h}</th>
                ))}</tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {requests.map(r => (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">{r.employee?.first_name} {r.employee?.last_name}</td>
                    <td className="px-4 py-3 text-gray-600">{formatType(r.request_type)}</td>
                    <td className="px-4 py-3 text-gray-500 max-w-xs truncate" title={r.subject}>{r.subject || '—'}</td>
                    <td className="px-4 py-3 text-gray-400 text-[10px] leading-tight">
                      {r.created_at ? format(new Date(r.created_at), 'MMM d, yyyy') : '—'}
                      <br /><span className="text-[9px] text-gray-300">{r.created_at ? format(new Date(r.created_at), 'h:mm a') : ''}</span>
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        <button onClick={() => setViewRequest(r)} className="btn-ghost p-1.5 text-brand-500 hover:text-brand-700 hover:bg-brand-50" title="View"><Eye size={14} /></button>
                        {r.status === 'pending' && <>
                          <button onClick={() => { setApproveNotes(''); setApproveTarget(r) }} disabled={approveMutation.isPending} className="btn-ghost p-1.5 text-green-500 hover:text-green-700 hover:bg-green-50" title="Approve"><Check size={14} /></button>
                          <button onClick={() => { setRejectNotes(''); setRejectModal(r.id) }} className="btn-ghost p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50" title="Reject"><X size={14} /></button>
                        </>}
                      </div>
                    </td>
                  </tr>
                ))}
                {requests.length === 0 && (
                  <tr><td colSpan={6} className="py-12 text-center">
                    <ClipboardList size={32} className="text-gray-200 mx-auto mb-2" />
                    <p className="text-sm text-gray-400">No {status} requests</p>
                  </td></tr>
                )}
              </tbody>
            </table>
            </div>
            {reqPagination && reqPagination.last_page > 1 && (
              <div className="px-4 py-3 border-t border-gray-100 bg-gray-50">
                <PagePagination pagination={reqPagination} onPageChange={setReqPage} />
              </div>
            )}
          </div>
        )
      )}

      {/* Leaves table */}
      {tab === 'leaves' && (
        loadingLeave ? <PageSpinner /> : (
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>{['Employee', 'Type', 'Dates', 'Days', 'Filed', 'Reason', 'Status', 'Actions'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">{h}</th>
                ))}</tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {leaves.map(lv => (
                  <tr key={lv.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">{lv.employee?.first_name} {lv.employee?.last_name}</td>
                    <td className="px-4 py-3 text-gray-600 capitalize">
                      {typeof lv.leave_type === 'string' ? lv.leave_type.replace(/_/g, ' ') : (lv.leave_type?.name || 'Unknown')}
                    </td>
                    <td className="px-4 py-3 text-gray-600 text-xs">{format(new Date(lv.start_date), 'MMM d')} – {format(new Date(lv.end_date), 'MMM d, yyyy')}</td>
                    <td className="px-4 py-3 text-gray-600">{lv.days_requested}d</td>
                    <td className="px-4 py-3 text-gray-400 text-[10px] leading-tight">
                      {lv.created_at ? format(new Date(lv.created_at), 'MMM d, yyyy') : '—'}
                      <br /><span className="text-[9px] text-gray-300">{lv.created_at ? format(new Date(lv.created_at), 'h:mm a') : ''}</span>
                    </td>
                    <td className="px-4 py-3 text-gray-500 max-w-xs truncate" title={lv.status === 'rejected' ? lv.rejection_reason : lv.reason}>
                      {lv.status === 'rejected'
                        ? <span className="text-red-600 font-medium">RJ: {lv.rejection_reason || 'No reason'}</span>
                        : lv.reason}
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={lv.status} /></td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        <button onClick={() => setViewLeave(lv)} className="btn-ghost p-1.5 text-brand-500 hover:text-brand-700 hover:bg-brand-50" title="View"><Eye size={14} /></button>
                        {lv.status === 'pending' && isWithinWindow(lv.created_at) && <>
                          <button onClick={() => handleApproveLeave(lv)} disabled={approveLeaveMutation.isPending} className="btn-ghost p-1.5 text-green-500 hover:text-green-700 hover:bg-green-50" title="Approve"><Check size={14} /></button>
                          <button onClick={() => setRejectLeaveModal(lv.id)} className="btn-ghost p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50" title="Reject"><X size={14} /></button>
                        </>}
                      </div>
                    </td>
                  </tr>
                ))}
                {leaves.length === 0 && (
                  <tr><td colSpan={8} className="py-12 text-center">
                    <CalendarOff size={32} className="text-gray-200 mx-auto mb-2" />
                    <p className="text-sm text-gray-400">No {status} leave requests</p>
                  </td></tr>
                )}
              </tbody>
            </table>
            </div>
            {leavePagination && leavePagination.last_page > 1 && (
              <div className="px-4 py-3 border-t border-gray-100 bg-gray-50">
                <PagePagination pagination={leavePagination} onPageChange={setLeavePage} />
              </div>
            )}
          </div>
        )
      )}

      {/* View Request modal */}
      <Modal open={Boolean(viewRequest)} onClose={() => setViewRequest(null)} title="Request Details" size="md">
        {viewRequest && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div><p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Employee</p><p className="text-sm font-semibold text-gray-900">{viewRequest.employee?.first_name} {viewRequest.employee?.last_name}</p></div>
              <div><p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Status</p><StatusBadge status={viewRequest.status} /></div>
              <div><p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Type</p><p className="text-sm text-gray-700">{formatType(viewRequest.request_type)}</p></div>
              <div><p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Filed At</p><p className="text-sm text-gray-700">{viewRequest.created_at ? format(new Date(viewRequest.created_at), 'MMM d, yyyy h:mm a') : '—'}</p></div>
            </div>
            <div><p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Subject</p><p className="text-sm text-gray-700">{viewRequest.subject || '—'}</p></div>
            {viewRequest.details && <div><p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Details</p><div className="p-3 bg-gray-50 rounded-lg border border-gray-100 text-sm text-gray-700">{viewRequest.details}</div></div>}
            {viewRequest.meta && formatMeta(viewRequest.meta)?.length > 0 && (
              <div><p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Additional Info</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{formatMeta(viewRequest.meta).map(({ label, value }) => (
                  <div key={label}><p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">{label}</p><p className="text-sm text-gray-700">{value}</p></div>
                ))}</div>
              </div>
            )}
            {viewRequest.status === 'rejected' && <div className="p-3 bg-red-50 rounded-lg border border-red-100"><p className="text-[10px] font-bold text-red-400 uppercase tracking-widest mb-1">HR Response Notes</p><p className="text-sm text-red-900 font-medium">{viewRequest.response_notes || 'No notes provided.'}</p></div>}
            {viewRequest.status === 'approved' && <div className="p-3 bg-emerald-50 rounded-lg border border-emerald-100"><p className="text-[10px] font-bold text-emerald-600 uppercase tracking-widest mb-1">Approval Info</p>{viewRequest.response_notes && <p className="text-sm text-emerald-900 mb-1">{viewRequest.response_notes}</p>}{viewRequest.approver && <p className="text-xs text-emerald-700">Approved by {viewRequest.approver?.name ?? viewRequest.approver?.first_name}</p>}</div>}
            <div className="flex justify-end pt-2"><button onClick={() => setViewRequest(null)} className="btn-primary px-6">Close</button></div>
          </div>
        )}
      </Modal>

      {/* View Leave modal */}
      <Modal open={Boolean(viewLeave)} onClose={() => setViewLeave(null)} title="Leave Request Details" size="sm">
        {viewLeave && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div><p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Employee</p><p className="text-sm font-semibold text-gray-900">{viewLeave.employee?.first_name} {viewLeave.employee?.last_name}</p></div>
              <div><p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Status</p><StatusBadge status={viewLeave.status} /></div>
              <div><p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Dates</p><p className="text-sm text-gray-700">{format(new Date(viewLeave.start_date), 'MMM d')} – {format(new Date(viewLeave.end_date), 'MMM d, yyyy')}</p></div>
              <div><p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Days Requested</p><p className="text-sm text-gray-700">{viewLeave.days_requested} day(s)</p></div>
              <div><p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Filed At</p><p className="text-sm text-gray-700">{viewLeave.created_at ? format(new Date(viewLeave.created_at), 'MMM d, yyyy h:mm a') : '—'}</p></div>
            </div>
            <div><p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Reason</p><div className="p-3 bg-gray-50 rounded-lg border border-gray-100 text-sm text-gray-700 italic">"{viewLeave.reason || 'No reason provided'}"</div></div>
            {viewLeave.status === 'rejected' && <div className="p-3 bg-red-50 rounded-lg border border-red-100"><p className="text-[10px] font-bold text-red-400 uppercase tracking-widest mb-1">HR Rejection Reason</p><p className="text-sm text-red-900 font-medium">{viewLeave.rejection_reason || 'No reason specified.'}</p></div>}
            {viewLeave.status === 'approved' && viewLeave.approver && <div className="p-3 bg-emerald-50 rounded-lg border border-emerald-100"><p className="text-[10px] font-bold text-emerald-600 uppercase tracking-widest mb-1">Approval Info</p><p className="text-xs text-emerald-900">Approved by {viewLeave.approver.name}</p></div>}
            <div className="flex justify-end pt-2"><button onClick={() => setViewLeave(null)} className="btn-primary px-6">Close</button></div>
          </div>
        )}
      </Modal>

      {/* Approve Request modal */}
      <Modal open={Boolean(approveTarget)} onClose={() => { setApproveTarget(null); setApproveNotes('') }} title="Approve Request" size="sm">
        {approveTarget && (
          <div className="space-y-3">
            <p className="text-sm text-gray-700">Approve this {formatType(approveTarget.request_type)} request from {approveTarget.employee?.first_name} {approveTarget.employee?.last_name}?</p>
            {approveTarget.meta?.auto_filed && ['half_day', 'undertime'].includes(approveTarget.request_type) && (
              <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3">
                This shortfall was detected automatically at clock-out. <strong>Approving marks it {formatType(approveTarget.request_type)}</strong> — pay still follows hours worked.
              </p>
            )}
            <FormField label="Response Notes (optional)"><textarea className="input h-20 resize-none" value={approveNotes} onChange={e => setApproveNotes(e.target.value)} placeholder="Add optional notes…" /></FormField>
            {approveMutation.isError && <p className="text-sm text-red-600">{approveMutation.error?.response?.data?.message || 'Failed to approve'}</p>}
            <div className="flex justify-end gap-2">
              <button onClick={() => { setApproveTarget(null); setApproveNotes('') }} className="btn-secondary">Cancel</button>
              <button onClick={() => approveMutation.mutate({ id: approveTarget.id, notes: approveNotes })} disabled={approveMutation.isPending} className="btn-success">{approveMutation.isPending ? <Spinner size="sm" /> : 'Approve'}</button>
            </div>
          </div>
        )}
      </Modal>

      {/* Reject Request modal */}
      <Modal open={Boolean(rejectModal)} onClose={() => setRejectModal(null)} title="Reject Request" size="sm">
        <div className="space-y-3">
          <FormField label="Response notes" required><textarea className="input h-20 resize-none" value={rejectNotes} onChange={e => setRejectNotes(e.target.value)} placeholder="Provide a reason…" /></FormField>
          {rejectMutation.isError && <p className="text-sm text-red-600">{rejectMutation.error?.response?.data?.message || 'Failed to reject'}</p>}
          <div className="flex justify-end gap-2">
            <button onClick={() => setRejectModal(null)} className="btn-secondary">Cancel</button>
            <button onClick={() => rejectMutation.mutate({ id: rejectModal, notes: rejectNotes })} disabled={!rejectNotes.trim() || rejectMutation.isPending} className="btn-danger">{rejectMutation.isPending ? <Spinner size="sm" /> : 'Reject'}</button>
          </div>
        </div>
      </Modal>

      {/* Reject Leave modal */}
      <Modal open={Boolean(rejectLeaveModal)} onClose={() => setRejectLeaveModal(null)} title="Reject Leave Request" size="sm">
        <div className="space-y-3">
          <FormField label="Reason for rejection" required><textarea className="input h-20 resize-none" value={rejectLeaveReason} onChange={e => setRejectLeaveReason(e.target.value)} placeholder="Provide a reason…" /></FormField>
          <div className="flex justify-end gap-2">
            <button onClick={() => setRejectLeaveModal(null)} className="btn-secondary">Cancel</button>
            <button onClick={() => rejectLeaveMutation.mutate({ id: rejectLeaveModal, reason: rejectLeaveReason })} disabled={!rejectLeaveReason || rejectLeaveMutation.isPending} className="btn-danger">{rejectLeaveMutation.isPending ? <Spinner size="sm" /> : 'Reject'}</button>
          </div>
        </div>
      </Modal>

      {/* Create Request modal */}
      <Modal open={createModal} onClose={() => setCreateModal(false)} title="New Request on Behalf of Employee"
        footer={
          <div className="flex justify-end gap-2">
            <button onClick={() => setCreateModal(false)} className="btn-secondary">Cancel</button>
            <button onClick={handleCreateSubmit} disabled={createMutation.isPending} className="btn-primary">{createMutation.isPending ? <Spinner size="sm" /> : 'Submit'}</button>
          </div>
        }
      >
        <div className="space-y-4">
          <FormField label="Employee" required>
            <select value={form.employee_id} onChange={e => f('employee_id', e.target.value)} className="input">
              <option value="">Select employee…</option>
              {activeEmps.map(e => <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>)}
            </select>
          </FormField>
          <FormField label="Category" required>
            <select value={form.type} onChange={e => f('type', e.target.value)} className="input">
              <option value="request">Request</option>
              <option value="leave">Leave</option>
            </select>
          </FormField>

          {form.type === 'leave' ? (
            <>
              <FormField label="Leave Type" required>
                <select value={form.leave_type} onChange={e => f('leave_type', e.target.value)} className="input">
                  <option value="">Select leave type…</option>
                  {activeTypes.map(t => <option key={t.id} value={t.code}>{t.name}</option>)}
                </select>
              </FormField>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <FormField label="Start Date" required><input type="date" value={form.start_date} onChange={e => f('start_date', e.target.value)} className="input" /></FormField>
                <FormField label="End Date" required><input type="date" value={form.end_date} onChange={e => f('end_date', e.target.value)} className="input" /></FormField>
              </div>
              <div className="rounded-lg bg-gray-50 border border-gray-200 p-3 text-sm text-gray-600">
                <p>Requested days: <span className="font-medium text-gray-900">{requestedDays}</span></p>
                <p>Weekend policy: <span className="font-medium text-gray-900">{includeWeekends ? 'Weekends count' : 'Weekends do not count'}</span></p>
                <p>Remaining balance after request: <span className="font-medium text-gray-900">
                  {!selectedBalance ? '—'
                    : !selectedBalance.requires_balance ? 'Unlimited'
                    : `${Math.max(0, selectedBalance.remaining - requestedDays)} / ${selectedBalance.remaining}`}
                </span></p>
              </div>
              <FormField label="Reason"><textarea value={form.reason} onChange={e => f('reason', e.target.value)} className="input h-16 resize-none" /></FormField>
            </>
          ) : (
            <>
              <FormField label="Request Type" required>
                <select value={form.request_type} onChange={e => f('request_type', e.target.value)} className="input">
                  {REQUEST_TYPES.filter(t => t.value !== 'leave').map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </FormField>
              <FormField label="Subject" required><input type="text" value={form.subject} onChange={e => f('subject', e.target.value)} className="input" placeholder="Brief subject…" /></FormField>
              {['overtime', 'half_day', 'undertime', 'schedule_change'].includes(form.request_type) && (
                <FormField label="Date" required>
                  <input type="date" value={form.date} onChange={e => f('date', e.target.value)} className="input" />
                </FormField>
              )}
              {form.request_type === 'overtime' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <FormField label="Start Time" required><input type="time" value={form.start_time} onChange={e => f('start_time', e.target.value)} className="input" /></FormField>
                  <FormField label="End Time" required><input type="time" value={form.end_time} onChange={e => f('end_time', e.target.value)} className="input" /></FormField>
                </div>
              )}
              {form.request_type === 'half_day' && (
                <FormField label="Half" required>
                  <select value={form.half} onChange={e => f('half', e.target.value)} className="input">
                    <option value="am">AM (Morning)</option>
                    <option value="pm">PM (Afternoon)</option>
                  </select>
                </FormField>
              )}
              {form.request_type === 'undertime' && (
                <FormField label="Departure Time" required>
                  <input type="time" value={form.departure_time} onChange={e => f('departure_time', e.target.value)} className="input" />
                </FormField>
              )}
              {form.request_type === 'cash_advance' && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <FormField label="Amount (₱)" required><input type="number" min="1" step="0.01" value={form.principal} onChange={e => f('principal', e.target.value)} className="input" /></FormField>
                  <FormField label="Term (cutoffs)" required><input type="number" min="1" step="1" value={form.term_count} onChange={e => f('term_count', e.target.value)} className="input" /></FormField>
                  <FormField label="Interest Rate"><input type="number" min="0" max="1" step="0.01" value={form.interest_rate} onChange={e => f('interest_rate', e.target.value)} className="input" placeholder="e.g. 0.05" /></FormField>
                </div>
              )}
              <FormField label="Details"><textarea value={form.details} onChange={e => f('details', e.target.value)} className="input h-16 resize-none" /></FormField>
            </>
          )}

          {createError && (
            <div className="flex gap-2 p-3 bg-red-50 border border-red-200 rounded-lg">
              <AlertCircle size={16} className="text-red-600 shrink-0 mt-0.5" />
              <p className="text-sm text-red-900">{createError}</p>
            </div>
          )}
        </div>
      </Modal>
    </div>
  )
}
