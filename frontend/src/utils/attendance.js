
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
export const getClockWindow = (schedule, sysClock = null, options = {}) => {
  const template = schedule?.template
  if (!template) return null

  const openShiftDayOfWeek = options.openShiftDayOfWeek
  const hasOpenShift = openShiftDayOfWeek != null && openShiftDayOfWeek !== ''

  const calendarDayOfWeek = sysClock != null ? sysClock.day_of_week : new Date().getDay()
  const wallMinutes = sysClock != null
    ? sysClock.minutes_since_midnight
    : new Date().getHours() * 60 + new Date().getMinutes()

  const parse = (t) => {
    if (!t) return 0
    const [h, m] = t.split(':').map(Number)
    return h * 60 + (m || 0)
  }

  const formatTime = (m) => {
    const normalized = ((m % 1440) + 1440) % 1440
    const h = Math.floor(normalized / 60)
    const min = normalized % 60
    return `${h.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}`
  }

  const rules = template.day_rules || []
  const ruleFor = (dow) => rules.find(r => r.day === dow)

  // Flexi schedule: employee can always clock in/out. On a disabled (rest) day
  // they may still choose to work — payroll pays that at the rest-day rate.
  if (template.type === 'flexi') {
    const dayRule = ruleFor(calendarDayOfWeek)
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
      currentMinutes: wallMinutes,
      isWithinInWindow: true,
      isWithinOutWindow: true,
      isFlexi: true,
      isRestDay: !(dayRule?.enabled ?? false),
      requiredHours: template.required_hours_per_day ?? 8,
      formatTime,
    }
  }

  let resolvedDayOfWeek = calendarDayOfWeek
  let adoptedYesterdayShift = false
  if (hasOpenShift) {
    resolvedDayOfWeek = Number(openShiftDayOfWeek)
  } else if (template.type === 'night') {
    const yesterdayDow = (calendarDayOfWeek + 6) % 7
    const yRule = ruleFor(yesterdayDow)
    const yEnabled = yRule == null || (yRule.enabled ?? true)
    if (yEnabled) {
      const yIn = parse(yRule?.clock_in ?? template.work_start_time)
      const yOut = parse(yRule?.clock_out ?? template.work_end_time)
      if (yIn > 0 && yOut > 0 && yOut < yIn && wallMinutes < yOut) {
        resolvedDayOfWeek = yesterdayDow
        adoptedYesterdayShift = true
      }
    }
  }

  const dayRule = ruleFor(resolvedDayOfWeek)

  // Fixed schedule, day not assigned (disabled day_rule): not a rest day, just not
  // scheduled — clock-in is blocked. Rest-day pay for fixed only happens when HR
  // manually sets that status on a log they create/edit themselves.
  if (dayRule && !dayRule.enabled) {
    return {
      isInactiveDay: true,
      currentMinutes: wallMinutes,
      adoptedYesterdayShift,
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

  const shiftInMinutes = workStartMinutes || inStart + 60
  const shiftOutMinutes = workEndMinutes || outEnd
  const wrapsMidnight =
    template.type === 'night' &&
    shiftInMinutes > 0 &&
    shiftOutMinutes > 0 &&
    shiftOutMinutes < shiftInMinutes

  let compareMinutes = wallMinutes
  if (wrapsMidnight) {
    if (outEnd < inStart) outEnd += 1440
    if (outStart < inStart) outStart += 1440
    const liftTail = hasOpenShift || adoptedYesterdayShift
    if (liftTail && compareMinutes < inStart) compareMinutes += 1440
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
    currentMinutes: compareMinutes,
    wrapsMidnight,
    adoptedYesterdayShift,
    isWithinInWindow: compareMinutes >= inStart && compareMinutes <= inEnd,
    isWithinOutWindow: compareMinutes >= outStart && compareMinutes <= outEnd,
    formatTime
  }
}

export const canEmployeeClockIn = (win, { overnightClockInBlocked = false } = {}) =>
  Boolean(win)
  && !win.isInactiveDay
  && !overnightClockInBlocked
  && win.currentMinutes >= win.inStart
  && win.currentMinutes <= win.outEnd

export const calculateAttendanceStatus = (clockIn, clockOut, expectedHours, workStart, schedule = null, logDate = null) => {
  if (!clockIn) return 'absent'
  
  const parse = (t) => {
    if (!t) return 0
    const [h, m] = t.split(':').map(Number)
    return h * 60 + (m || 0)
  }
  
  const inMin = parse(clockIn)
  const outMin = clockOut ? parse(clockOut) : inMin
  const startMin = parse(workStart)
  
  let effectiveOut = outMin
  if (effectiveOut < inMin) effectiveOut += 1440
  
  const hoursWorked = Math.max(0, (effectiveOut - inMin) / 60)
  const halfExpected = expectedHours / 2
  const lateMinutes = Math.max(0, inMin - startMin)
  const expectedMinutes = expectedHours * 60
  const undertimeMinutes = Math.max(0, expectedMinutes - (effectiveOut - inMin))
  
  // Check if grace period applies
  let graceCovered = false
  if (schedule?.template?.day_rules) {
    const dayOfWeek = logDate ? new Date(logDate).getDay() : new Date().getDay()
    const dayRule = schedule.template.day_rules.find(r => r.day === dayOfWeek)
    
    if (dayRule && dayRule.grace_enabled) {
      const graceMinutes = parseInt(dayRule.grace_minutes || 0)
      const graceType = dayRule.grace_type || '-/+'
      
      // Check if this deviation is covered by grace
      if (lateMinutes <= graceMinutes && (graceType === '+' || graceType === '-/+')) {
        graceCovered = true
      } else if (undertimeMinutes <= graceMinutes && (graceType === '-' || graceType === '-/+')) {
        graceCovered = true
      }
    }
  }

  // If grace covers the deviation, return completed
  if (graceCovered) return 'completed'

  if (hoursWorked > expectedHours) return 'overtime'
  if (hoursWorked >= halfExpected && hoursWorked < expectedHours) return 'half_day'
  if (hoursWorked < halfExpected) return 'undertime'
  
  return lateMinutes > 0 ? 'late' : 'completed'
}

export const TIMELESS_ATTENDANCE_STATUSES = ['absent', 'on_leave', 'rest_day', 'holiday']

export function applyAttendanceStatusToForm(form, status) {
  if (TIMELESS_ATTENDANCE_STATUSES.includes(status)) {
    return { ...form, status, clock_in_time: '', clock_out_time: '' }
  }
  return { ...form, status }
}
