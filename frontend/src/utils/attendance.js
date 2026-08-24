
// ── Cutoff helpers ────────────────────────────────────────────────────────────

const _lastDay = (year, month1) => new Date(year, month1, 0).getDate()
const _fmt = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
const _label = (y, m, d, opts) => new Date(y, m - 1, d).toLocaleDateString('en-US', opts)

// Resolve day=31 to actual last day of month (1-indexed month)
const _resolve = (day, y, m) => (day === 31 ? _lastDay(y, m) : day)

// Build a cutoff object from a starting month and configured start/end days.
// Handles cross-month periods (end < start).
const _buildPeriod = (year, month, startDay, endDay) => {
  const rs = _resolve(startDay, year, month)
  if (endDay < startDay) {
    // Cross-month: end falls in the following month
    const ny = month === 12 ? year + 1 : year
    const nm = month === 12 ? 1 : month + 1
    const re = _resolve(endDay, ny, nm)
    return {
      startDate: _fmt(year, month, rs),
      endDate: _fmt(ny, nm, re),
      label: `${_label(year, month, rs, { month: 'short', day: 'numeric' })} - ${_label(ny, nm, re, { month: 'short', day: 'numeric', year: 'numeric' })}`,
    }
  }
  const re = _resolve(endDay, year, month)
  return {
    startDate: _fmt(year, month, rs),
    endDate: _fmt(year, month, re),
    label: `${_label(year, month, rs, { month: 'short', day: 'numeric' })} - ${_label(year, month, re, { month: 'short', day: 'numeric', year: 'numeric' })}`,
  }
}

const _getSetting = (settings, key, def) => {
  if (!Array.isArray(settings)) return def
  const s = settings.find(s => s.key === key)
  return s ? (parseInt(s.value) || def) : def
}

/**
 * Returns the cutoff period that contains the given date.
 * Pass adminSettings (array from getAdminSettings) to use configured periods.
 * Falls back to the hardcoded 11th–25th / 26th–10th cycle when settings are absent.
 */
export const getCutoffPeriod = (date = new Date(), settings = null) => {
  const d = typeof date === 'string' ? new Date(date + 'T00:00:00') : new Date(date)
  const day = d.getDate()
  const month = d.getMonth() + 1  // 1-indexed
  const year = d.getFullYear()

  // ── Settings-driven path ─────────────────────────────────────────────────
  if (Array.isArray(settings) && settings.length > 0) {
    const freq = settings.find(s => s.key === 'payroll_frequency')?.value ?? 'semi_monthly'

    if (freq === 'monthly') {
      const s = _getSetting(settings, 'payroll_monthly_start_day', 1)
      const e = _getSetting(settings, 'payroll_monthly_end_day', 31)
      return _buildPeriod(year, month, s, e)
    }

    const s1 = _getSetting(settings, 'payroll_period1_start_day', 11)
    const e1 = _getSetting(settings, 'payroll_period1_end_day', 25)
    const s2 = _getSetting(settings, 'payroll_period2_start_day', 26)
    const e2 = _getSetting(settings, 'payroll_period2_end_day', 10)

    // Check period 1
    if (e1 >= s1) {
      if (day >= s1 && day <= e1) return _buildPeriod(year, month, s1, e1)
    } else {
      if (day >= s1) return _buildPeriod(year, month, s1, e1)
      if (day <= e1) {
        const pm = month === 1 ? 12 : month - 1
        const py = month === 1 ? year - 1 : year
        return _buildPeriod(py, pm, s1, e1)
      }
    }

    // Check period 2
    if (e2 >= s2) {
      if (day >= s2 && day <= e2) return _buildPeriod(year, month, s2, e2)
    } else {
      if (day >= s2) return _buildPeriod(year, month, s2, e2)
      if (day <= e2) {
        const pm = month === 1 ? 12 : month - 1
        const py = month === 1 ? year - 1 : year
        return _buildPeriod(py, pm, s2, e2)
      }
    }

    // Gap day: fall into the nearer period (use period 2 start as anchor)
    return _buildPeriod(year, month, s2, e2)
  }

  // ── Legacy hardcoded fallback: 11th–25th / 26th–10th ────────────────────
  const m = d.getMonth()
  if (day >= 11 && day <= 25) {
    return {
      startDate: _fmt(year, m + 1, 11),
      endDate: _fmt(year, m + 1, 25),
      label: `${_label(year, m + 1, 11, { month: 'short', day: 'numeric' })} - ${_label(year, m + 1, 25, { month: 'short', day: 'numeric', year: 'numeric' })}`,
    }
  } else if (day > 25) {
    const end = new Date(year, m + 1, 10)
    return {
      startDate: _fmt(year, m + 1, 26),
      endDate: _fmt(end.getFullYear(), end.getMonth() + 1, 10),
      label: `${_label(year, m + 1, 26, { month: 'short', day: 'numeric' })} - ${_label(end.getFullYear(), end.getMonth() + 1, 10, { month: 'short', day: 'numeric', year: 'numeric' })}`,
    }
  } else {
    const start = new Date(year, m - 1, 26)
    return {
      startDate: _fmt(start.getFullYear(), start.getMonth() + 1, 26),
      endDate: _fmt(year, m + 1, 10),
      label: `${_label(start.getFullYear(), start.getMonth() + 1, 26, { month: 'short', day: 'numeric' })} - ${_label(year, m + 1, 10, { month: 'short', day: 'numeric', year: 'numeric' })}`,
    }
  }
}

export const getNextCutoff = (cutoff, settings = null) => {
  const end = new Date(cutoff.endDate + 'T00:00:00')
  end.setDate(end.getDate() + 1)
  return getCutoffPeriod(end, settings)
}

export const getPrevCutoff = (cutoff, settings = null) => {
  const start = new Date(cutoff.startDate + 'T00:00:00')
  start.setDate(start.getDate() - 1)
  return getCutoffPeriod(start, settings)
}

/**
 * sysClock: optional object from /api/system-clock
 *   { day_of_week: number, minutes_since_midnight: number, time: "HH:MM:SS", date: "YYYY-MM-DD" }
 * Falls back to real browser time if not provided.
 */
export const getClockWindow = (schedule, sysClock = null) => {
  const template = schedule?.template
  if (!template) return null

  // Use system clock if available, otherwise real browser time
  const dayOfWeek = sysClock != null ? sysClock.day_of_week : new Date().getDay()
  const currentMinutes = sysClock != null
    ? sysClock.minutes_since_midnight
    : new Date().getHours() * 60 + new Date().getMinutes()

  const parse = (t) => {
    if (!t) return 0
    const [h, m] = t.split(':').map(Number)
    return h * 60 + (m || 0)
  }

  const formatTime = (m) => {
    const h = Math.floor(m / 60)
    const min = m % 60
    return `${h.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}`
  }

  const dayRule = (template.day_rules || []).find(r => r.day === dayOfWeek)

  // Flexi schedule: employee can always clock in/out. On a disabled (rest) day
  // they may still choose to work — payroll pays that at the rest-day rate.
  if (template.type === 'flexi') {
    return {
      inStart: 0,
      inEnd: 1439,
      outStart: 0,
      outEnd: 1439,
      workStart: 'Flexi',
      workEnd: 'Flexi',
      workStartMinutes: 0,
      workEndMinutes: 1439,
      normalInStart: 0,
      currentMinutes,
      isWithinInWindow: true,
      isWithinOutWindow: true,
      isFlexi: true,
      isRestDay: !(dayRule?.enabled ?? false),
      requiredHours: template.required_hours_per_day ?? 8,
      formatTime,
    }
  }

  // Fixed schedule, day not assigned (disabled day_rule): not a rest day, just not
  // scheduled — clock-in is blocked. Rest-day pay for fixed only happens when HR
  // manually sets that status on a log they create/edit themselves.
  if (dayRule && !dayRule.enabled) {
    return {
      isInactiveDay: true,
      currentMinutes,
      workStart: dayRule.clock_in?.substring(0, 5) || template.work_start_time?.substring(0, 5) || '—',
      workEnd: dayRule.clock_out?.substring(0, 5) || template.work_end_time?.substring(0, 5) || '—',
      formatTime,
    }
  }

  let inStart, inEnd, outStart, outEnd
  let workStart = template.work_start_time?.substring(0, 5)
  let workEnd = template.work_end_time?.substring(0, 5)
  let workStartMinutes = 0
  let workEndMinutes = 0
  let normalInStart = 0

  if (dayRule && dayRule.enabled) {
    const targetIn = parse(dayRule.clock_in)
    const targetOut = parse(dayRule.clock_out)
    const grace = parseInt(dayRule.grace_minutes || 0)
    const type = dayRule.grace_type || '-/+'
    workStart = dayRule.clock_in.substring(0, 5)
    workEnd = dayRule.clock_out.substring(0, 5)
    workStartMinutes = targetIn
    workEndMinutes = targetOut

    inStart = targetIn - 60 // Allow 1 hour before scheduled time
    normalInStart = dayRule.grace_enabled ? (targetIn - ((type === '-' || type === '-/+') ? grace : 0)) : targetIn
    
    if (dayRule.grace_enabled) {
      inEnd = targetIn + ((type === '+' || type === '-/+') ? grace : 0)
      outStart = targetOut - ((type === '-' || type === '-/+') ? grace : 0)
      outEnd = targetOut + ((type === '+' || type === '-/+') ? grace : 0)
    } else {
      inEnd = targetIn
      outStart = outEnd = targetOut
    }
  } else {
    workStartMinutes = parse(template.work_start_time)
    workEndMinutes = parse(template.work_end_time)
    inStart = workStartMinutes - 60 // Allow 1 hour before scheduled time
    normalInStart = parse(template.clock_in_start || template.work_start_time)
    inEnd = parse(template.clock_in_end || template.work_start_time)
    outStart = parse(template.clock_out_start || template.work_end_time)
    outEnd = parse(template.clock_out_end || template.work_end_time)
  }

  return {
    inStart,
    inEnd,
    outStart,
    outEnd,
    workStart,
    workEnd,
    workStartMinutes,
    workEndMinutes,
    normalInStart,
    currentMinutes,
    isWithinInWindow: currentMinutes >= inStart && currentMinutes <= inEnd,
    isWithinOutWindow: currentMinutes >= outStart && currentMinutes <= outEnd,
    formatTime
  }
}
export const calculateAttendanceStatus = (clockIn, clockOut, expectedHours, workStart, schedule = null, logDate = null) => {
  if (!clockIn) return 'absent'
  if (!clockOut) return 'working'

  const parse = (t) => {
    if (!t) return 0
    const [h, m] = t.split(':').map(Number)
    return h * 60 + (m || 0)
  }

  const inMin = parse(clockIn)
  let outMin = parse(clockOut)
  if (outMin < inMin) outMin += 1440

  const isFlexi = (schedule?.template?.type || schedule?.type) === 'flexi'
  if (isFlexi) {
    const hoursWorked = Math.max(0, (outMin - inMin) / 60)
    if (expectedHours > 0 && hoursWorked <= expectedHours / 2) return 'half_day'
    if (hoursWorked < expectedHours) return 'undertime'
    return 'completed'
  }

  const startMin = parse(workStart)
  const dayOfWeek = logDate ? new Date(logDate).getDay() : new Date().getDay()
  const dayRule = schedule?.template?.day_rules?.find(r => r.day === dayOfWeek) ?? null
  const workEnd = dayRule?.clock_out || schedule?.template?.work_end_time || null
  let endMin = workEnd ? parse(workEnd) : startMin + Math.round(expectedHours * 60)
  if (endMin <= startMin) endMin += 1440

  let plusGrace = 0
  let minusGrace = 0
  if (dayRule?.grace_enabled) {
    const graceMinutes = parseInt(dayRule.grace_minutes || 0, 10)
    const graceType = dayRule.grace_type || '-/+'
    if (graceType === '+' || graceType === '-/+') plusGrace = graceMinutes
    if (graceType === '-' || graceType === '-/+') minusGrace = graceMinutes
  }

  const regularCap = endMin + plusGrace
  const regularOut = Math.min(outMin, regularCap)
  const hoursWorked = Math.max(0, (regularOut - inMin) / 60)
  const shortfallMinutes = Math.max(0, expectedHours * 60 - (regularOut - inMin))
  const lateArrival = Math.max(0, inMin - startMin)

  if (expectedHours > 0 && hoursWorked <= expectedHours / 2) return 'half_day'
  if (shortfallMinutes > 0) {
    if (minusGrace > 0 && shortfallMinutes <= minusGrace) return 'late'
    return 'undertime'
  }
  if (lateArrival > plusGrace) return 'late'
  return 'completed'
}

export const TIMELESS_ATTENDANCE_STATUSES = ['absent', 'on_leave', 'rest_day', 'holiday']

export function applyAttendanceStatusToForm(form, status) {
  if (TIMELESS_ATTENDANCE_STATUSES.includes(status)) {
    return { ...form, status, clock_in_time: '', clock_out_time: '' }
  }
  return { ...form, status }
}
