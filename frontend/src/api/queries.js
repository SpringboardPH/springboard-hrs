import api from './axios'

// ─── Employees ──────────────────────────────────────────────
export const employeeKeys = {
  all: ['employees'],
  list: (params) => ['employees', 'list', params],
  detail: (id) => ['employees', id],
  groups: ['employees', 'groups'],
}

export const getEmployees = (params) =>
  api.get('/employees', { params }).then(r => ({
    data: r.data.data,
    pagination: r.data.pagination,
    total: r.data.pagination.total,
  }))

export const getEmployeeGroups = () =>
  api.get('/employees/groups').then(r => r.data.data)

export const getEmployee = (id) =>
  api.get(`/employees/${id}`).then(r => r.data.data)

export const createEmployee = (data) =>
  api.post('/employees', data).then(r => r.data)

export const updateEmployee = (id, data) =>
  api.put(`/employees/${id}`, data).then(r => r.data)

export const deactivateEmployee = (id) =>
  api.patch(`/employees/${id}/deactivate`).then(r => r.data)

export const updateProfile = (data) =>
  api.put('/profile', data).then(r => r.data)

export const updatePassword = (data) =>
  api.put('/user/password', data).then(r => r.data)

// ─── Departments ─────────────────────────────────────────────
export const departmentKeys = {
  all: ['departments'],
}

export const getDepartments = () =>
  api.get('/departments').then(r => r.data.data)

// ─── Attendance ──────────────────────────────────────────────
export const attendanceKeys = {
  all: ['attendance'],
  today: (id) => ['attendance', 'today', 'my', id],  // Employee's own attendance
  todayAll: () => ['attendance', 'today', 'all'],  // HR/Admin all employees
  list: (params) => ['attendance', 'list', params],
  monthly: (employeeId, startDate, endDate) => ['attendance', 'monthly', employeeId, startDate, endDate],
  exportPreview: (startDate, endDate) => ['attendance', 'export-preview', startDate, endDate],
}

export const getAttendanceToday = (params = { personal: true }) =>
  api.get('/attendance/today', { params }).then(r => r.data.data)

export const getAttendance = (params) =>
  api.get('/attendance', { params }).then(r => ({
    data: r.data.data,
    pagination: r.data.pagination,
    total: r.data.pagination?.total,
  }))

export const getMonthlyAttendance = (employeeId, startDate, endDate) =>
  api.get(`/attendance/${employeeId}/monthly`, { params: { start_date: startDate, end_date: endDate } }).then(r => r.data.data)

export const clockIn = (notes, employeeId = null, coords = null) =>
  api.post('/attendance/clock-in', {
    notes,
    employee_id: employeeId,
    latitude: coords?.latitude ?? null,
    longitude: coords?.longitude ?? null,
  }).then(r => r.data.data)

export const clockOut = (notes, employeeId = null, confirmEarlyClockOut = false, isOvertime = null, fileOvertimeRequest = null) =>
  api.post('/attendance/clock-out', {
    notes,
    employee_id: employeeId,
    confirm_early_clock_out: confirmEarlyClockOut,
    ...(isOvertime !== null && { is_overtime: isOvertime }),
    ...(fileOvertimeRequest !== null && { file_overtime_request: fileOvertimeRequest }),
  }).then(r => r.data.data)

export const updateAttendanceLog = (id, data) =>
  api.put(`/attendance/${id}`, data).then(r => r.data)

export const deleteAttendanceLog = (id) =>
  api.delete(`/attendance/${id}`).then(r => r.data)

export const createAttendanceLog = (data) =>
  api.post('/attendance', data).then(r => r.data)

export const bulkMarkAbsent = ({ start_date, end_date, employee_id = null }) =>
  api.post('/attendance/bulk-mark-absent', { start_date, end_date, employee_id }).then(r => r.data)

// ─── Leaves ──────────────────────────────────────────────────
export const leaveKeys = {
  all: ['leaves'],
  list: (params) => ['leaves', 'list', params],
  detail: (id) => ['leaves', id],
  balance: (id) => ['leaves', 'balance', id],
}

export const getLeaves = (params = {}) =>
  api.get('/leaves', { params }).then(r => ({
    data: r.data.data,
    pagination: r.data.pagination,
    total: r.data.pagination.total,
  }))

export const getLeaveBalance = (employeeId = null) =>
  api.get('/leaves/balance', { params: employeeId ? { employee_id: employeeId } : {} }).then(r => r.data.data)

export const createLeave = (data) =>
  api.post('/leaves', data).then(r => r.data)

export const approveLeave = (id) =>
  api.patch(`/leaves/${id}/approve`).then(r => r.data)

export const rejectLeave = (id, reason) =>
  api.patch(`/leaves/${id}/reject`, { rejection_reason: reason }).then(r => r.data)

export const leaveTypeKeys = {
  all: ['leave-types'],
  list: (params) => ['leave-types', 'list', params],
  detail: (id) => ['leave-types', id],
}

export const getLeaveTypes = (params = {}) =>
  api.get('/leave-types', { params }).then(r => r.data.data)

export const getAdminLeaveTypes = (params = {}) =>
  api.get('/admin/leave-types', { params }).then(r => r.data.data)

export const createLeaveType = (data) =>
  api.post('/admin/leave-types', data).then(r => r.data)

export const updateLeaveType = (id, data) =>
  api.put(`/admin/leave-types/${id}`, data).then(r => r.data)

export const deleteLeaveType = (id) =>
  api.delete(`/admin/leave-types/${id}`).then(r => r.data)

export const employeeLeaveBalanceKeys = {
  all: ['admin', 'employee-leave-balances'],
  detail: (employeeId) => ['admin', 'employee-leave-balances', employeeId],
}

export const getEmployeeLeaveBalances = (employeeId) =>
  api.get(`/admin/employee-leave-balances/${employeeId}`).then(r => r.data.data)

export const upsertEmployeeLeaveBalance = (employeeId, leaveTypeId, data) =>
  api.put(`/admin/employee-leave-balances/${employeeId}/${leaveTypeId}`, data).then(r => r.data)

export const resetEmployeeLeaveBalance = (employeeId, leaveTypeId) =>
  api.delete(`/admin/employee-leave-balances/${employeeId}/${leaveTypeId}`).then(r => r.data)

// ─── Payroll ─────────────────────────────────────────────────
export const payrollKeys = {
  all: ['payroll'],
  list: (params) => ['payroll', 'list', params],
  detail: (id) => ['payroll', id],
}

export const getPayrolls = (params) =>
  api.get('/payroll', { params }).then(r => r.data.data)

export const getPayroll = (id) =>
  api.get(`/payroll/${id}`).then(r => r.data.data)

export const generatePayroll = (data) =>
  api.post('/payroll/generate', data).then(r => r.data)

export const updatePayroll = (id, data) =>
  api.put(`/payroll/${id}`, data).then(r => r.data)

export const exportPayroll = (id, label) => {
  return api.get(`/payroll/${id}/export`, { responseType: 'blob' }).then(res => {
    const url = URL.createObjectURL(new Blob([res.data]))
    const a = document.createElement('a')
    a.href = url
    a.download = `payroll-${label}.xlsx`
    a.click()
    URL.revokeObjectURL(url)
  })
}

export const sendPaystubs = (formData) => {
  // formData is a FormData object with payroll_ids array and files
  return api.post('/payroll/send-paystubs', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }
  }).then(r => r.data)
}

export const revertPayrollToDraft = (payrollId) =>
  api.post(`/payroll/${payrollId}/revert-to-draft`).then(r => r.data)

export const togglePayrollUndertimeCalculation = (payrollId) =>
  api.post(`/payroll/${payrollId}/toggle-undertime-calc`).then(r => r.data)

// ─── 13th Month ──────────────────────────────────────────────
export const thirteenthMonthKeys = {
  all: ['thirteenth-month'],
  list: (params) => ['thirteenth-month', 'list', params],
}

export const getThirteenthMonth = (params) =>
  api.get('/thirteenth-month', { params }).then(r => r.data)

export const saveThirteenthMonth = (data) =>
  api.post('/thirteenth-month/save', data).then(r => r.data)

export const getThirteenthMonthPeriods = (year) =>
  api.get('/thirteenth-month/payroll-periods', { params: { year } }).then(r => r.data.data)

export const pushThirteenthMonthToPayroll = (data) =>
  api.post('/thirteenth-month/push-to-payroll', data).then(r => r.data)

export const setThirteenthMonthMode = (data) =>
  api.post('/thirteenth-month/set-mode', data).then(r => r.data)

export const setThirteenthMonthExcludedMonths = (data) =>
  api.post('/thirteenth-month/set-excluded-months', data).then(r => r.data)

// ─── Dashboard ───────────────────────────────────────────────
export const dashboardKeys = { all: ['dashboard'] }

export const getDashboard = () =>
  api.get('/dashboard/summary').then(r => r.data.data)

// ─── Admin Settings ──────────────────────────────────────────────
export const adminSettingsKeys = {
  all: ['admin', 'settings'],
  detail: (key) => ['admin', 'settings', key],
  defaults: ['admin', 'settings', 'defaults'],
}

export const systemClockKeys = {
  all: ['system-clock'],
}

export const themeColorKeys = {
  all: ['theme-color'],
}

export const systemConfigKeys = {
  all: ['system-config'],
}

export const getSystemClock = () =>
  api.get('/system-clock').then(r => r.data.data)

export const getAdminSettings = () =>
  api.get('/admin/settings').then(r => r.data.data)

export const payrollConfigKeys = {
  all: ['payroll-config'],
}

export const getPayrollConfig = () =>
  api.get('/payroll-config').then(r => r.data.data)

export const geofenceConfigKeys = {
  all: ['geofence-config'],
}

export const getGeofenceConfig = () =>
  api.get('/geofence-config').then(r => r.data.data)

export const getThemeColor = () =>
  api.get('/theme-color').then(r => r.data.data)

export const getSystemConfig = () =>
  api.get('/system-config').then(r => r.data.data)

export const updateAdminSetting = (key, value, description, type = 'string') =>
  api.put(`/admin/settings/${key}`, { value, description, type }).then(r => r.data)

export const uploadLogo = (file) => {
  const formData = new FormData()
  formData.append('logo', file)
  return api.post('/admin/settings/logo', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then(r => r.data)
}

export const uploadPayrollTemplate = (file) => {
  const formData = new FormData()
  formData.append('template', file)
  return api.post('/admin/settings/payroll-template', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then(r => r.data)
}

export const getLogos = () =>
  api.get('/admin/settings/logos').then(r => r.data.data)

export const deleteLogo = (filename) =>
  api.delete(`/admin/settings/logo/${filename}`).then(r => r.data)

// ─── Audit Logs (Admin) ──────────────────────────────────────────
export const auditLogKeys = {
  all: ['admin', 'audit-logs'],
  list: (params) => ['admin', 'audit-logs', 'list', params],
}

export const getAuditLogs = (params) =>
  api.get('/admin/audit-logs', { params }).then(r => ({
    data: r.data.data,
    pagination: r.data.pagination,
  }))

// ─── Admin Departments ──────────────────────────────────────────────
export const adminDepartmentKeys = {
  all: ['admin', 'departments'],
  detail: (id) => ['admin', 'departments', id],
}

export const getAdminDepartments = () =>
  api.get('/admin/departments').then(r => r.data.data)

export const createAdminDepartment = (data) =>
  api.post('/admin/departments', data).then(r => r.data)

export const updateAdminDepartment = (id, data) =>
  api.put(`/admin/departments/${id}`, data).then(r => r.data)

export const deleteAdminDepartment = (id) =>
  api.delete(`/admin/departments/${id}`).then(r => r.data)

export const hardDeleteAdminDepartment = (id) =>
  api.delete(`/admin/departments/${id}/hard-delete`).then(r => r.data)

export const restoreAdminDepartment = (id) =>
  api.patch(`/admin/departments/${id}/restore`).then(r => r.data)

// ─── Admin Employee Management ──────────────────────────────────────────────
// ─── Schedule Templates (Admin) ──────────────────────────────────────────────
export const scheduleTemplateKeys = {
  all: ['admin', 'schedule-templates'],
  detail: (id) => ['admin', 'schedule-templates', id],
}

export const getScheduleTemplates = () =>
  api.get('/admin/schedule-templates').then(r => r.data.data)

export const createScheduleTemplate = (data) =>
  api.post('/admin/schedule-templates', data).then(r => r.data)

export const updateScheduleTemplate = (id, data) =>
  api.put(`/admin/schedule-templates/${id}`, data).then(r => r.data)

export const deleteScheduleTemplate = (id) =>
  api.delete(`/admin/schedule-templates/${id}`).then(r => r.data)

// ─── Employee Schedules (HR) ────────────────────────────────────────────────
export const employeeScheduleKeys = {
  all: ['schedules'],
  list: (params) => ['schedules', 'list', params],
  detail: (id) => ['schedules', id],
  currentForEmployee: (employeeId) => ['schedules', 'current', employeeId],
}

export const getEmployeeSchedules = (params) =>
  api.get('/admin/employee-schedules', { params }).then(r => ({
    data: r.data.data,
    pagination: r.data.pagination,
    total: r.data.pagination?.total,
  }))

export const getCurrentScheduleForEmployee = (employeeId) =>
  api.get(`/admin/employee-schedules/employee/${employeeId}/current`).then(r => r.data.data)

export const createEmployeeSchedule = (data) =>
  api.post('/admin/employee-schedules', data).then(r => r.data)

export const updateEmployeeSchedule = (id, data) =>
  api.put(`/admin/employee-schedules/${id}`, data).then(r => r.data)

export const deleteEmployeeSchedule = (id) =>
  api.delete(`/admin/employee-schedules/${id}`).then(r => r.data)

export const getMySchedules = (params) =>
  api.get('/my-schedules', { params }).then(r => r.data.data)

export const setMySchedule = (data) =>
  api.post('/my-schedules', data).then(r => r.data)

export const getAvailableTemplates = () =>
  api.get('/schedule-templates').then(r => r.data.data)

// ─── Users (Admin) ────────────────────────────────────────────────
export const userKeys = {
  all: ['admin', 'users'],
  list: (params) => ['admin', 'users', 'list', params],
  detail: (id) => ['admin', 'users', id],
  trashed: (params) => ['admin', 'users', 'trashed', params],
}

export const getUsers = (params) =>
  api.get('/admin/users', { params }).then(r => ({
    data: r.data.data,
    pagination: r.data.pagination,
    total: r.data.pagination?.total,
  }))

export const getUser = (id) =>
  api.get(`/admin/users/${id}`).then(r => r.data.data)

export const createUser = (data) =>
  api.post('/admin/users', data).then(r => r.data)

export const updateUser = (id, data) =>
  api.put(`/admin/users/${id}`, data).then(r => r.data)

export const deleteUser = (id) =>
  api.delete(`/admin/users/${id}`).then(r => r.data)

export const hardDeleteUser = (id) =>
  api.delete(`/admin/users/${id}/hard-delete`).then(r => r.data)

export const getTrashedUsers = (params) =>
  api.get('/admin/users/trashed', { params }).then(r => ({
    data: r.data.data,
    pagination: r.data.pagination,
    total: r.data.pagination?.total,
  }))

export const restoreUser = (id) =>
  api.patch(`/admin/users/${id}/restore`).then(r => r.data)

// ─── Calendar (HR/Admin/Employee) ──────────────────────────────────────────
export const calendarEventKeys = {
  all: ['calendar-events'],
  list: (params) => ['calendar-events', 'list', params],
  detail: (id) => ['calendar-events', id],
}

export const getCalendarEvents = (params = {}) =>
  api.get('/calendar-events', { params }).then(r => r.data.data)

export const createCalendarEvent = (data) =>
  api.post('/admin/calendar-events', data).then(r => r.data)

export const previewHolidayImpact = (data) =>
  api.post('/admin/calendar-events/holiday-impact', data).then(r => r.data.data)

export const updateCalendarEvent = (id, data, updateScope = 'single') =>
  api.put(`/admin/calendar-events/${id}`, { ...data, update_scope: updateScope }).then(r => r.data)

export const deleteCalendarEvent = (id, deleteScope = 'single') =>
  api.delete(`/admin/calendar-events/${id}`, { params: { delete_scope: deleteScope } }).then(r => r.data)

export const importCalendarEvents = (file, { applyHolidayRewrite } = {}) => {
  const formData = new FormData()
  formData.append('file', file)
  if (applyHolidayRewrite) {
    formData.append('apply_holiday_rewrite', '1')
  }
  return api.post('/admin/calendar-events/import', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then(r => r.data)
}

export const exportCalendarEvents = (startDate = null, endDate = null) => {
  const params = {}
  if (startDate) params.start_date = startDate
  if (endDate) params.end_date = endDate
  return api.get('/admin/calendar-events/export', { params, responseType: 'blob' })
}

export const calendarEventTypeKeys = {
  all: ['calendar-event-types'],
  list: (params) => ['calendar-event-types', 'list', params],
  detail: (id) => ['calendar-event-types', id],
}

export const getCalendarEventTypes = (params = {}) =>
  api.get('/calendar-event-types', { params }).then(r => r.data.data)

export const getAdminCalendarEventTypes = (params = {}) =>
  api.get('/admin/calendar-event-types', { params }).then(r => r.data.data)

export const createCalendarEventType = (data) =>
  api.post('/admin/calendar-event-types', data).then(r => r.data)

export const updateCalendarEventType = (id, data) =>
  api.put(`/admin/calendar-event-types/${id}`, data).then(r => r.data)

export const deleteCalendarEventType = (id) =>
  api.delete(`/admin/calendar-event-types/${id}`).then(r => r.data)

// ─── Employee Requests ──────────────────────────────────────────────
export const requestKeys = {
  all: ['requests'],
  list: (params) => ['requests', 'list', params],
  detail: (id) => ['requests', id],
}

export const getRequests = (params = {}) =>
  api.get('/requests', { params }).then(r => ({
    data: r.data.data,
    pagination: r.data.pagination,
  }))

export const getRequest = (id) =>
  api.get(`/requests/${id}`).then(r => r.data.data)

export const createRequest = (data) =>
  api.post('/requests', data).then(r => r.data)

export const approveRequest = (id, responseNotes = null) =>
  api.patch(`/requests/${id}/approve`, { response_notes: responseNotes }).then(r => r.data)

export const rejectRequest = (id, responseNotes) =>
  api.patch(`/requests/${id}/reject`, { response_notes: responseNotes }).then(r => r.data)

// ─── Loans ──────────────────────────────────────────────────────────
export const loanKeys = {
  all: ['loans'],
  list: (params) => ['loans', 'list', params],
  detail: (id) => ['loans', id],
}

export const getLoans = (params = {}) =>
  api.get('/loans', { params }).then(r => ({
    data: r.data.data,
    pagination: r.data.pagination,
  }))

export const getLoan = (id) =>
  api.get(`/loans/${id}`).then(r => r.data.data)

export const createLoan = (data) =>
  api.post('/loans', data).then(r => r.data)

export const updateLoan = (id, data) =>
  api.put(`/loans/${id}`, data).then(r => r.data)

export const deleteLoan = (id) =>
  api.delete(`/loans/${id}`).then(r => r.data)

// ─── DTR Uploads ─────────────────────────────────────────────
export const dtrKeys = {
  all:            ['dtr'],
  config:         ['dtr', 'config'],
  list:           (params) => ['dtr', 'list', params],
  employeeAccess: ['dtr', 'employee-access'],
}

export const getDtrConfig = () =>
  api.get('/dtr/config').then(r => r.data.data)

export const getDtrs = (params = {}) =>
  api.get('/dtr', { params }).then(r => r.data.data)

export const uploadDtr = (formData) =>
  api.post('/dtr', formData, { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data)

export const deleteDtr = (id) =>
  api.delete(`/dtr/${id}`).then(r => r.data)

export const getDtrEmployeeAccess = () =>
  api.get('/dtr/employee-access').then(r => r.data.data)

export const toggleDtrEmployeeAccess = (employeeId, enabled) =>
  api.patch(`/dtr/employee-access/${employeeId}`, { enabled }).then(r => r.data)
