import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { format, parseISO } from 'date-fns'
import {
  getAttendance, attendanceKeys, deleteAttendanceLog, updateAttendanceLog, createAttendanceLog,
  getEmployees, getEmployeeGroups, employeeKeys, getEmployeeSchedules, employeeScheduleKeys,
  getCalendarEvents, calendarEventKeys, getCalendarEventTypes, calendarEventTypeKeys,
  getSystemClock, systemClockKeys
} from '../../api/queries'
import { PageHeader, PageSpinner, StatusBadge, ConfirmModal, Modal, FormField, AlertModal } from '../../components/ui/index.jsx'
import { Pencil, Trash2, AlertCircle, MapPin, FileDown } from 'lucide-react'
import { calculateHoursWorked, toAttendanceDateStr } from '../../utils/timeHelpers'
import AttendanceExportModal from '../../components/attendance/AttendanceExportModal'
import { calculateAttendanceStatus, getCutoffPeriod, getNextCutoff, getPrevCutoff, applyAttendanceStatusToForm } from '../../utils/attendance'

export default function AdminAttendanceLogsPage() {
  const [activeCutoff, setActiveCutoff] = useState(null)
  const [filters, setFilters] = useState({
    employee_search: '',
    status: '',
    date: '',
    group: '',
  })
  const [editLog, setEditLog] = useState(null)
  const [editForm, setEditForm] = useState({
    clock_in_time: '',
    clock_out_time: '',
    status: '',
    clock_in_notes: '',
    clock_out_notes: '',
  })
  const [deleteConfirm, setDeleteConfirm] = useState({
    open: false,
    logId: null,
    employeeName: '',
    date: '',
  })
  const [statusConfirmModal, setStatusConfirmModal] = useState({
    open: false,
    detectedStatus: '',
    onConfirm: () => {},
  })
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [exportModalOpen, setExportModalOpen] = useState(false)
  const [createForm, setCreateForm] = useState({
    employee_id: '',
    date: format(new Date(), 'yyyy-MM-dd'),
    clock_in_time: '',
    clock_out_time: '',
    status: '',
    clock_in_notes: '',
    clock_out_notes: '',
  })

  const [alert, setAlert] = useState(null)
  const qc = useQueryClient()

  // Get system clock for cutoff initialization
  const { data: sysClock } = useQuery({
    queryKey: systemClockKeys.all,
    queryFn: getSystemClock,
    staleTime: 0,
  })

  // Set cutoff once sysClock is available
  useEffect(() => {
    if (sysClock && activeCutoff === null) {
      setActiveCutoff(getCutoffPeriod(sysClock.date))
    }
  }, [sysClock, activeCutoff])

  const currentCutoff = activeCutoff || getCutoffPeriod(sysClock?.date || new Date())

  const moveCutoff = (direction) => {
    const newCutoff = direction === -1 ? getPrevCutoff(currentCutoff) : getNextCutoff(currentCutoff)
    setActiveCutoff(newCutoff)
  }

  // Construct params for the attendance query
  const attendanceParams = {
    start_date: currentCutoff.startDate,
    end_date: currentCutoff.endDate,
    include_absentees: true,
    personal: false,
    ...(filters.employee_search.trim() ? { employee_search: filters.employee_search.trim() } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.date ? { date: filters.date } : {}),
    ...(filters.group ? { group: filters.group } : {}),
  }

  // API Queries
  const { data: employeeGroups = [] } = useQuery({
    queryKey: employeeKeys.groups,
    queryFn: getEmployeeGroups,
  })

  const { data: employees } = useQuery({
    queryKey: employeeKeys.list({}),
    queryFn: () => getEmployees({ status: 'active' }),
  })

  const { data: scheduleResponse } = useQuery({
    queryKey: employeeScheduleKeys.list({ status: 'active' }),
    queryFn: () => getEmployeeSchedules({ status: 'active' }),
  })

  const { data: attendanceData, isLoading } = useQuery({
    queryKey: attendanceKeys.list(attendanceParams),
    queryFn: () => getAttendance(attendanceParams),
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchOnMount: 'always',
  })

  const { data: events = [] } = useQuery({
    queryKey: calendarEventKeys.list({ 
      start_date: currentCutoff.startDate, 
      end_date: currentCutoff.endDate 
    }),
    queryFn: () => getCalendarEvents({ 
      start_date: currentCutoff.startDate, 
      end_date: currentCutoff.endDate 
    }),
  })

  const { data: eventTypes = [] } = useQuery({
    queryKey: calendarEventTypeKeys.all,
    queryFn: getCalendarEventTypes,
  })

  // Mutations
  const updateLogMutation = useMutation({
    mutationFn: ({ id, data, employee_id, date }) => {
      if (id == null) {
        return createAttendanceLog({ employee_id, date, ...data })
      }
      return updateAttendanceLog(id, data)
    },
    onSuccess: () => {
      qc.refetchQueries({ queryKey: attendanceKeys.all, type: 'active' })
      setEditLog(null)
      setStatusConfirmModal({ ...statusConfirmModal, open: false })
    },
    onError: (error) => {
      setAlert({ type: 'error', message: error?.response?.data?.message || 'Failed to update log' })
    }
  })

  const deleteLogMutation = useMutation({
    mutationFn: (id) => deleteAttendanceLog(id),
    onSuccess: () => {
      qc.refetchQueries({ queryKey: attendanceKeys.all, type: 'active' })
      setDeleteConfirm({ open: false, logId: null, employeeName: '', date: '' })
    },
    onError: (error) => {
      setAlert({ type: 'error', message: error?.response?.data?.message || 'Failed to delete log' })
    }
  })

  const createLogMutation = useMutation({
    mutationFn: (data) => createAttendanceLog(data),
    onSuccess: () => {
      qc.refetchQueries({ queryKey: attendanceKeys.all, type: 'active' })
      setCreateModalOpen(false)
      setCreateForm({
        employee_id: '',
        date: format(new Date(), 'yyyy-MM-dd'),
        clock_in_time: '',
        clock_out_time: '',
        status: '',
        clock_in_notes: '',
        clock_out_notes: '',
      })
      setAlert({ type: 'success', message: 'Attendance log created successfully' })
    },
    onError: (error) => {
      setAlert({ type: 'error', message: error?.response?.data?.message || 'Failed to create log' })
    }
  })

  // Helper functions
  const logs = attendanceData?.data ?? []
  const activeEmployees = employees?.data ?? []
  const activeSchedules = scheduleResponse?.data ?? []

  const getScheduleForEmployee = (empId) => {
    return activeSchedules.find(s => s.employee_id === empId)
  }

  const getEventForDate = (dateStr) => {
    if (!events) return null
    const key = toAttendanceDateStr(dateStr)
    return events.find(e => toAttendanceDateStr(e.event_date) === key)
  }

  const getEventTypeForEvent = (event) => {
    if (!event) return null
    return event.type || eventTypes.find(t => t.id === event.calendar_event_type_id)
  }

  // Handlers
  const openEditModal = (log) => {
    setEditLog(log)
    setEditForm({
      clock_in_time: log.clock_in_time || '',
      clock_out_time: log.clock_out_time || '',
      status: log.status || '',
      clock_in_notes: log.clock_in_notes || '',
      clock_out_notes: log.clock_out_notes || '',
    })
  }

  const openDeleteConfirm = (log) => {
    setDeleteConfirm({
      open: true,
      logId: log.id,
      employeeName: `${log.employee?.first_name} ${log.employee?.last_name}`,
      date: format(parseISO(toAttendanceDateStr(log.date)), 'MMM dd, yyyy'),
    })
  }

  const handleEditSubmit = (e) => {
    e.preventDefault()

    // Format time values to H:i:s format
    const formatTime = (timeStr) => {
      if (!timeStr) return ''
      // Convert HH:mm to HH:mm:ss
      return timeStr.length === 5 ? `${timeStr}:00` : timeStr
    }

    const logSchedule = editLog?.employee_id ? getScheduleForEmployee(editLog.employee_id) : null
    const template = logSchedule?.template
    const expectedHours = template?.required_hours_per_day || 9
    const workStart = template?.work_start_time || '09:00:00'

    const detected = calculateAttendanceStatus(
      formatTime(editForm.clock_in_time),
      formatTime(editForm.clock_out_time),
      expectedHours,
      workStart,
      logSchedule
    )

    const specialStatuses = ['undertime', 'half_day', 'overtime']

    if (specialStatuses.includes(detected) && detected !== editForm.status) {
      setStatusConfirmModal({
        open: true,
        detectedStatus: detected,
        onConfirm: (useDetected) => {
          const finalData = {
            ...editForm,
            clock_in_time: formatTime(editForm.clock_in_time),
            clock_out_time: formatTime(editForm.clock_out_time),
            status: useDetected ? detected : editForm.status
          }
          updateLogMutation.mutate({
            id: editLog?.id,
            employee_id: editLog?.employee_id,
            date: editLog?.date,
            data: finalData,
          })
        }
      })
    } else {
      const finalData = {
        ...editForm,
        clock_in_time: formatTime(editForm.clock_in_time),
        clock_out_time: formatTime(editForm.clock_out_time)
      }
      updateLogMutation.mutate({
        id: editLog?.id,
        employee_id: editLog?.employee_id,
        date: editLog?.date,
        data: finalData,
      })
    }
  }

  const clearFilters = () => {
    setFilters({ employee_search: '', status: '', date: '', group: '' })
  }

  const handleCreateSubmit = (e) => {
    e.preventDefault()

    if (!createForm.employee_id) {
      setAlert({ type: 'warning', message: 'Please select an employee' })
      return
    }

    const selectedEmployee = activeEmployees.find(e => e.id === parseInt(createForm.employee_id))
    if (!selectedEmployee) {
      setAlert({ type: 'error', message: 'Invalid employee selected' })
      return
    }

    // Format time values to H:i:s format
    const formatTime = (timeStr) => {
      if (!timeStr) return ''
      // Convert HH:mm to HH:mm:ss
      return timeStr.length === 5 ? `${timeStr}:00` : timeStr
    }

    const logSchedule = getScheduleForEmployee(parseInt(createForm.employee_id))
    const template = logSchedule?.template
    const expectedHours = template?.required_hours_per_day || 9
    const workStart = template?.work_start_time || '09:00:00'

    const detected = calculateAttendanceStatus(
      formatTime(createForm.clock_in_time),
      formatTime(createForm.clock_out_time),
      expectedHours,
      workStart,
      logSchedule
    )

    const specialStatuses = ['undertime', 'half_day', 'overtime']

    if (specialStatuses.includes(detected) && detected !== createForm.status && !createForm.status) {
      setStatusConfirmModal({
        open: true,
        detectedStatus: detected,
        onConfirm: (useDetected) => {
          const finalData = {
            ...createForm,
            employee_id: parseInt(createForm.employee_id),
            clock_in_time: formatTime(createForm.clock_in_time),
            clock_out_time: formatTime(createForm.clock_out_time),
            status: useDetected ? detected : createForm.status
          }
          createLogMutation.mutate(finalData)
        }
      })
    } else {
      const finalData = {
        ...createForm,
        employee_id: parseInt(createForm.employee_id),
        clock_in_time: formatTime(createForm.clock_in_time),
        clock_out_time: formatTime(createForm.clock_out_time)
      }
      createLogMutation.mutate(finalData)
    }
  }

  const hasActiveFilters = Object.values(filters).some(v => v)

  return (
    <div className="space-y-5">
      <PageHeader
        title="Attendance Log Management"
        description="View, edit, and delete attendance logs with full control"
        help={[
          { heading: 'Cutoff Navigation', items: [
            'Use the Previous / Next arrows to navigate between payroll cutoff periods.',
          ]},
          { heading: 'Filters', items: [
            'Filter logs by employee name/email, attendance status, specific date, and employee group.',
            'All filters can be combined to narrow results.',
          ]},
          { heading: 'Export', items: [
            'Export opens a configuration dialog for date range, departments, groups, employee status, attendance statuses, and sheet layout. It does not use the table filters on this page.',
          ]},
          { heading: 'Adding a Log', items: [
            'Click the Add Log button (top-right of the filters card) to manually create an attendance record.',
            'Specify the employee, date, clock-in/out times, status, and notes.',
          ]},
          { heading: 'Editing a Log', items: [
            'Click the pencil icon on any row to edit that record\'s clock-in/out times, status, and notes.',
            'A system-detected status hint is shown if the computed status differs from the selected one.',
          ]},
          { heading: 'Location', items: [
            'When location check-in is enabled (System Settings → Geolocation on Clock-In), the Location column shows a "View" link to the map of where the employee clocked in.',
            'A dash means no location was recorded — the feature was off that day, the employee is exempt, or they denied location access.',
          ]},
          { heading: 'Deleting a Log', items: [
            'Click the trash icon to permanently delete an attendance record. A confirmation dialog will appear.',
          ]},
        ]}
      />

      {/* Cutoff Navigation and Filters */}
      <div className="card p-5">
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-gray-700 whitespace-nowrap">
              Cutoff: {currentCutoff?.startDate && currentCutoff?.endDate ? (() => {
                try {
                  return `${format(parseISO(currentCutoff.startDate), 'MMM dd')} – ${format(parseISO(currentCutoff.endDate), 'MMM dd, yyyy')}`
                } catch {
                  return 'Loading...'
                }
              })() : 'Loading...'}
            </h3>
            <div className="flex items-center gap-2">
              <button type="button" className="btn-secondary text-xs px-3 py-1.5" onClick={() => moveCutoff(-1)} disabled={!currentCutoff?.startDate}>← Prev</button>
              <button type="button" className="btn-secondary text-xs px-3 py-1.5" onClick={() => moveCutoff(1)} disabled={!currentCutoff?.startDate}>Next →</button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              className="input text-sm flex-1 min-w-0"
              value={filters.employee_search}
              onChange={e => setFilters({ ...filters, employee_search: e.target.value })}
              placeholder="Search employee…"
            />
            <select className="input text-sm w-36 shrink-0" value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value })}>
              <option value="">All Statuses</option>
              <option value="completed">Completed</option>
              <option value="working">Working</option>
              <option value="late">Late</option>
              <option value="undertime">Undertime</option>
              <option value="half_day">Half Day</option>
              <option value="overtime">Overtime</option>
              <option value="on_leave">On Leave</option>
              <option value="absent">Absent</option>
              <option value="rest_day">Rest Day</option>
              <option value="holiday">Holiday</option>
            </select>
            <input type="date" className="input text-sm w-36 shrink-0" value={filters.date} onChange={e => setFilters({ ...filters, date: e.target.value })} />
            {employeeGroups.length > 0 && (
              <select className="input text-sm w-32 shrink-0" value={filters.group} onChange={e => setFilters({ ...filters, group: e.target.value })}>
                <option value="">All Groups</option>
                {employeeGroups.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            )}
            <button type="button" className="btn-secondary text-sm shrink-0 px-3" onClick={clearFilters}>Clear</button>
          </div>
        </div>
      </div>

      {/* Attendance Logs Table */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-gray-700">Attendance Logs</h3>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn-secondary text-sm"
              title="Export to Excel"
              onClick={() => setExportModalOpen(true)}
            >
              <FileDown size={16} />
              Export
            </button>
            <button
              onClick={() => setCreateModalOpen(true)}
              className="btn-primary text-sm"
            >
              Add Log
            </button>
          </div>
        </div>
        {isLoading ? (
          <PageSpinner />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-100">
                <tr>
                  <th className="pb-2 text-left text-xs text-gray-400 font-medium pr-4">Date</th>
                  <th className="pb-2 text-left text-xs text-gray-400 font-medium pr-4">Employee</th>
                  <th className="pb-2 text-left text-xs text-gray-400 font-medium pr-4">Schedule</th>
                  <th className="pb-2 text-left text-xs text-gray-400 font-medium pr-4">Clock In</th>
                  <th className="pb-2 text-left text-xs text-gray-400 font-medium pr-4">Clock Out</th>
                  <th className="pb-2 text-left text-xs text-gray-400 font-medium pr-4">Hours</th>
                  <th className="pb-2 text-left text-xs text-gray-400 font-medium pr-4">Location</th>
                  <th className="pb-2 text-left text-xs text-gray-400 font-medium pr-4">Status</th>
                  <th className="pb-2 text-left text-xs text-gray-400 font-medium pr-4">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {logs.map(log => (
                  <tr key={log.id} className="hover:bg-gray-50">
                    <td className="py-2.5 pr-4 text-gray-600 text-sm">
                      {format(parseISO(toAttendanceDateStr(log.date)), 'MMM dd, yyyy')}
                    </td>
                    <td className="py-2.5 pr-4 font-medium text-gray-900 text-sm">
                      {log.employee?.first_name} {log.employee?.last_name}
                    </td>
                    <td className="py-2.5 pr-4 text-gray-600 text-sm">
                      {log.template_name || '—'}
                    </td>
                    <td className="py-2.5 pr-4 text-gray-600 text-sm font-mono">
                      {log.clock_in_time ?? '—'}
                    </td>
                    <td className="py-2.5 pr-4 text-gray-600 text-sm font-mono">
                      {log.clock_out_time ?? '—'}
                    </td>
                    <td className="py-2.5 pr-4 text-gray-600 text-sm">
                      {calculateHoursWorked(log.clock_in_time, log.clock_out_time)}
                    </td>
                    <td className="py-2.5 pr-4 text-sm">
                      {log.clock_in_lat != null && log.clock_in_lng != null ? (
                        <a
                          href={`https://www.google.com/maps?q=${log.clock_in_lat},${log.clock_in_lng}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-brand-600 hover:underline"
                          title={`${log.clock_in_lat}, ${log.clock_in_lng}`}
                        >
                          <MapPin size={14} /> View
                        </a>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>
                    <td className="py-2.5">
                      <StatusBadge status={log.status} />
                    </td>
                    <td className="py-2.5">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => openEditModal(log)}
                          className="text-gray-400 hover:text-brand-600 transition-colors"
                          title="Edit log"
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          onClick={() => openDeleteConfirm(log)}
                          className="text-gray-400 hover:text-red-600 transition-colors"
                          title="Delete log"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {logs.length === 0 && (
                  <tr>
                    <td colSpan={9} className="py-8 text-center text-gray-400 text-sm">
                      {hasActiveFilters ? 'No records match your filters' : 'No attendance logs found'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Edit Modal */}
      <Modal open={!!editLog} onClose={() => setEditLog(null)} title="Edit Attendance Log" size="md">
        <form onSubmit={handleEditSubmit}>
          <div className="space-y-4">
            <div className="bg-gray-50 p-3 rounded-lg text-sm text-gray-600 border border-gray-100">
              <p><strong>Employee:</strong> {editLog?.employee?.first_name} {editLog?.employee?.last_name}</p>
              <p><strong>Date:</strong> {editLog?.date ? format(parseISO(editLog.date), 'MMMM dd, yyyy') : '—'}</p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormField label="Clock In">
                <input
                  type="time"
                  step="1"
                  className="input"
                  value={editForm.clock_in_time}
                  onChange={e => setEditForm({ ...editForm, clock_in_time: e.target.value })}
                />
              </FormField>
              <FormField label="Clock Out">
                <input
                  type="time"
                  step="1"
                  className="input"
                  value={editForm.clock_out_time}
                  onChange={e => setEditForm({ ...editForm, clock_out_time: e.target.value })}
                />
              </FormField>
            </div>

            <FormField label="Schedule Template">
              <div className="input bg-gray-50 text-gray-500 cursor-not-allowed flex items-center">
                {editLog?.template_name || '— Not assigned —'}
              </div>
            </FormField>

            <FormField label="Status">
              <div className="space-y-2">
                <select
                  className="input"
                  value={editForm.status}
                  onChange={e => setEditForm(applyAttendanceStatusToForm(editForm, e.target.value))}
                >
                  <option value="">— Select status —</option>
                  <option value="completed">Completed</option>
                  <option value="working">Working</option>
                  <option value="late">Late</option>
                  <option value="undertime">Undertime</option>
                  <option value="half_day">Half Day</option>
                  <option value="overtime">Overtime</option>
                  <option value="absent">Absent</option>
                  <option value="on_leave">On Leave</option>
                  <option value="rest_day">Rest Day</option>
                  <option value="holiday">Holiday</option>
                </select>

                {(() => {
                  const logSchedule = editLog?.employee_id ? getScheduleForEmployee(editLog.employee_id) : null
                  const template = logSchedule?.template
                  const expectedHours = template?.required_hours_per_day || 9
                  const workStart = template?.work_start_time || '09:00:00'
                  const detected = calculateAttendanceStatus(editForm.clock_in_time, editForm.clock_out_time, expectedHours, workStart, logSchedule)

                  if (detected && detected !== editForm.status) {
                    return (
                      <div className="flex items-center gap-2 p-2 bg-brand-50 rounded-lg border border-brand-100">
                        <AlertCircle size={14} className="text-brand-600" />
                        <span className="text-[10px] text-brand-700 font-medium">
                          System detected: <span className="uppercase font-bold">{detected.replace('_', ' ')}</span>
                        </span>
                        <button
                          type="button"
                          onClick={() => setEditForm(applyAttendanceStatusToForm(editForm, detected))}
                          className="ml-auto text-[10px] text-brand-600 hover:underline font-bold"
                        >
                          Apply
                        </button>
                      </div>
                    )
                  }
                  return null
                })()}
              </div>
            </FormField>

            <FormField label="Clock In Notes">
              <textarea
                className="input text-sm"
                rows={2}
                value={editForm.clock_in_notes}
                onChange={e => setEditForm({ ...editForm, clock_in_notes: e.target.value })}
                placeholder="Notes from clock-in time..."
              />
            </FormField>

            <FormField label="Clock Out Notes">
              <textarea
                className="input text-sm"
                rows={2}
                value={editForm.clock_out_notes}
                onChange={e => setEditForm({ ...editForm, clock_out_notes: e.target.value })}
                placeholder="Notes from clock-out time..."
              />
            </FormField>

            <div className="pt-2 flex gap-2">
              <button
                type="submit"
                disabled={updateLogMutation.isPending}
                className="btn-primary flex-1 h-11 text-sm shadow-sm"
              >
                {updateLogMutation.isPending ? 'Saving...' : 'Save Changes'}
              </button>
              <button
                type="button"
                onClick={() => setEditLog(null)}
                className="btn-ghost flex-1 h-11 text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        </form>
      </Modal>

      {/* Delete Confirmation Modal */}
      <ConfirmModal
        open={deleteConfirm.open}
        onClose={() => setDeleteConfirm({ open: false, logId: null, employeeName: '', date: '' })}
        onConfirm={() => {
          if (deleteConfirm.logId) {
            deleteLogMutation.mutate(deleteConfirm.logId)
          }
        }}
        title="Delete Attendance Log?"
        message={`Are you sure you want to delete the attendance log for ${deleteConfirm.employeeName} on ${deleteConfirm.date}? This action cannot be undone.`}
        type="danger"
        confirmLabel="Delete Log"
        isLoading={deleteLogMutation.isPending}
      />

      {/* Status Confirmation Modal */}
      <Modal
        open={statusConfirmModal.open}
        onClose={() => setStatusConfirmModal({ ...statusConfirmModal, open: false })}
        title="Confirm Attendance Status"
        size="sm"
      >
        <div className="space-y-4">
          <div className="flex flex-col items-center text-center py-2">
            <div className="w-12 h-12 rounded-full bg-orange-50 flex items-center justify-center text-orange-600 mb-3">
              <AlertCircle size={24} />
            </div>
            <h3 className="text-sm font-semibold text-gray-900">Status Verification Required</h3>
            <p className="text-xs text-gray-500 mt-2 px-2">
              The system detected this shift as <span className="font-bold text-gray-900 uppercase">{statusConfirmModal.detectedStatus.replace('_', ' ')}</span>.
              Is this the correct status for this log?
            </p>
          </div>

          <div className="grid grid-cols-1 gap-2 pt-2">
            <button
              onClick={() => statusConfirmModal.onConfirm(true)}
              className="btn-primary w-full"
            >
              Yes, set as {statusConfirmModal.detectedStatus.replace('_', ' ')}
            </button>
            <button
              onClick={() => statusConfirmModal.onConfirm(false)}
              className="btn-secondary w-full"
            >
              No, keep my selection
            </button>
            <button
              onClick={() => setStatusConfirmModal({ ...statusConfirmModal, open: false })}
              className="btn-ghost w-full text-xs text-gray-400"
            >
              Cancel
            </button>
          </div>
        </div>
      </Modal>

      {/* Create Attendance Log Modal */}
      <Modal open={createModalOpen} onClose={() => setCreateModalOpen(false)} title="Create Attendance Log" size="md">
        <form onSubmit={handleCreateSubmit}>
          <div className="space-y-4">
            <FormField label="Employee *">
              <select
                className="input"
                value={createForm.employee_id}
                onChange={e => setCreateForm({ ...createForm, employee_id: e.target.value })}
                required
              >
                <option value="">Select employee</option>
                {activeEmployees.map(emp => (
                  <option key={emp.id} value={emp.id}>
                    {emp.first_name} {emp.last_name}
                  </option>
                ))}
              </select>
            </FormField>

            <FormField label="Date *">
              <input
                type="date"
                className="input"
                value={createForm.date}
                onChange={e => setCreateForm({ ...createForm, date: e.target.value })}
                required
              />
            </FormField>

            {createForm.employee_id && (
              <FormField label="Schedule Template">
                <div className="input bg-gray-50 text-gray-500 cursor-not-allowed flex items-center">
                  {getScheduleForEmployee(parseInt(createForm.employee_id))?.template?.name || '— Not assigned —'}
                </div>
              </FormField>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormField label="Clock In Time">
                <input
                  type="time"
                  step="1"
                  className="input"
                  value={createForm.clock_in_time}
                  onChange={e => setCreateForm({ ...createForm, clock_in_time: e.target.value })}
                />
              </FormField>
              <FormField label="Clock Out Time">
                <input
                  type="time"
                  step="1"
                  className="input"
                  value={createForm.clock_out_time}
                  onChange={e => setCreateForm({ ...createForm, clock_out_time: e.target.value })}
                />
              </FormField>
            </div>

            <FormField label="Status">
              <div className="space-y-2">
                <select
                  className="input"
                  value={createForm.status}
                  onChange={e => setCreateForm(applyAttendanceStatusToForm(createForm, e.target.value))}
                >
                  <option value="">Auto-detect</option>
                  <option value="completed">Completed</option>
                  <option value="working">Working</option>
                  <option value="late">Late</option>
                  <option value="undertime">Undertime</option>
                  <option value="half_day">Half Day</option>
                  <option value="overtime">Overtime</option>
                  <option value="on_leave">On Leave</option>
                  <option value="absent">Absent</option>
                  <option value="rest_day">Rest Day</option>
                  <option value="holiday">Holiday</option>
                </select>

                {(() => {
                  if (!createForm.employee_id) return null
                  
                  const formatTime = (timeStr) => {
                    if (!timeStr) return ''
                    return timeStr.length === 5 ? `${timeStr}:00` : timeStr
                  }

                  const logSchedule = getScheduleForEmployee(parseInt(createForm.employee_id))
                  const template = logSchedule?.template
                  const expectedHours = template?.required_hours_per_day || 9
                  const workStart = template?.work_start_time || '09:00:00'
                  const detected = calculateAttendanceStatus(
                    formatTime(createForm.clock_in_time),
                    formatTime(createForm.clock_out_time),
                    expectedHours,
                    workStart,
                    logSchedule
                  )

                  if (detected && detected !== createForm.status) {
                    return (
                      <div className="flex items-center gap-2 p-2 bg-brand-50 rounded-lg border border-brand-100">
                        <AlertCircle size={14} className="text-brand-600" />
                        <span className="text-[10px] text-brand-700 font-medium">
                          System detected: <span className="uppercase font-bold">{detected.replace('_', ' ')}</span>
                        </span>
                        <button
                          type="button"
                          onClick={() => setCreateForm(applyAttendanceStatusToForm(createForm, detected))}
                          className="ml-auto text-[10px] text-brand-600 hover:underline font-bold"
                        >
                          Apply
                        </button>
                      </div>
                    )
                  }
                  return null
                })()}
              </div>
            </FormField>

            <FormField label="Clock In Notes">
              <textarea
                className="input text-sm"
                rows={2}
                value={createForm.clock_in_notes}
                onChange={e => setCreateForm({ ...createForm, clock_in_notes: e.target.value })}
                placeholder="Notes from clock-in time..."
              />
            </FormField>

            <FormField label="Clock Out Notes">
              <textarea
                className="input text-sm"
                rows={2}
                value={createForm.clock_out_notes}
                onChange={e => setCreateForm({ ...createForm, clock_out_notes: e.target.value })}
                placeholder="Notes from clock-out time..."
              />
            </FormField>

            <div className="pt-2 flex gap-2">
              <button
                type="submit"
                disabled={createLogMutation.isPending}
                className="btn-primary flex-1 h-11 text-sm shadow-sm"
              >
                {createLogMutation.isPending ? 'Creating...' : 'Create Log'}
              </button>
              <button
                type="button"
                onClick={() => setCreateModalOpen(false)}
                className="btn-secondary flex-1 h-11 text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        </form>
      </Modal>

      <AlertModal
        open={!!alert}
        onClose={() => setAlert(null)}
        title={
          alert?.type === 'success' ? 'Success' :
          alert?.type === 'error' ? 'Error' :
          alert?.type === 'warning' ? 'Warning' : 'Information'
        }
        message={alert?.message}
        type={alert?.type}
      />

      <AttendanceExportModal
        open={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        defaultCutoff={currentCutoff}
      />

    </div>
  )
}
