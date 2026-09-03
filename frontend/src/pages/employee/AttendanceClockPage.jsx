import { useState, useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { addMonths, format, parseISO } from 'date-fns'
import {
  clockIn, clockOut, getAttendanceToday, getMonthlyAttendance,
  attendanceKeys, getCurrentScheduleForEmployee, employeeScheduleKeys,
  getSystemClock, systemClockKeys,
  getCalendarEvents, calendarEventKeys,
  getCalendarEventTypes, calendarEventTypeKeys,
  getPayrollConfig, payrollConfigKeys,
  getGeofenceConfig, geofenceConfigKeys,
} from '../../api/queries'
import { PageHeader, PageSpinner, ScheduleDisplay, ConfirmModal, AlertModal, Modal } from '../../components/ui/index.jsx'
import GeofenceMapPreview from '../../components/GeofenceMapPreview.jsx'
import { Clock, LogOut, AlertCircle, CalendarDays, Sparkles, MapPin } from 'lucide-react'
import { useAuth } from '../../store/AuthContext'
import { getClockWindow, getCutoffPeriod, getNextCutoff, getPrevCutoff, canEmployeeClockIn } from '../../utils/attendance'
import { toAttendanceDateStr } from '../../utils/timeHelpers'

// Resolve GPS coords for geo-tagging; resolves null if unsupported/denied/timeout
// so clock-in always proceeds. ponytail: no library, browser Geolocation API only.
const getClockInCoords = () =>
  new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null)
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      () => resolve(null),
      { timeout: 10000, enableHighAccuracy: true }
    )
  })

// Great-circle distance in meters — mirrors the backend haversine for UX only
// (the server re-checks and is authoritative).
const distanceMeters = (lat1, lng1, lat2, lng2) => {
  const R = 6371000
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

const formatMeters = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`)

const calculateHours = (clockInTime, clockOutTime) => {
  if (!clockInTime || !clockOutTime) return '—'

  try {
    const [inH, inM, inS] = clockInTime.split(':').map(Number)
    const [outH, outM, outS] = clockOutTime.split(':').map(Number)

    const inMinutes = inH * 60 + inM + inS / 60
    const outMinutes = outH * 60 + outM + outS / 60
    const diffMinutes = outMinutes - inMinutes

    if (diffMinutes < 0) return '—'

    const hours = Math.floor(diffMinutes / 60)
    const minutes = Math.round(diffMinutes % 60)

    return `${hours}h ${minutes}m`
  } catch {
    return '—'
  }
}

export default function AttendanceClockPage() {
  const [notes, setNotes] = useState('')
  const [earlyClockOutConfirmOpen, setEarlyClockOutConfirmOpen] = useState(false)
  const [otConfirm, setOtConfirm] = useState({ open: false, overtimeHours: null, hoursWorked: null, requiredHours: null })
  const [earlyClockInConfirmOpen, setEarlyClockInConfirmOpen] = useState(false)
  const [locationModal, setLocationModal] = useState({ open: false, loading: false, coords: null })
  const [alertConfig, setAlertConfig] = useState({ open: false, title: '', message: '', type: 'error' })
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { user, loading: authLoading } = useAuth()

  const employeeId = user?.employee?.id

  // ── System clock (virtual time from backend) ──────────────────
  const { data: sysClock, isLoading: sysClockLoading } = useQuery({
    queryKey: systemClockKeys.all,
    queryFn: getSystemClock,
    // Refresh every 30s so the display stays reasonably in sync
    refetchInterval: 30_000,
    staleTime: 0,
  })

  const { data: adminSettings = [] } = useQuery({
    queryKey: payrollConfigKeys.all,
    queryFn: getPayrollConfig,
    staleTime: 0,
    refetchOnWindowFocus: true,
  })

  const { data: geofence } = useQuery({
    queryKey: geofenceConfigKeys.all,
    queryFn: getGeofenceConfig,
    staleTime: 60_000,
  })

  const [navigatedCutoff, setNavigatedCutoff] = useState(null)

  // Live display clock — ticks every second but starts from system clock
  const [displayTime, setDisplayTime] = useState(null)
  const startTimeRef = useRef(null)

  useEffect(() => {
    if (!sysClock) return
    // Record the wall-clock ms at the moment we received the server time
    startTimeRef.current = {
      serverMs: new Date(sysClock.datetime).getTime(),
      localMs: Date.now(),
    }
    setDisplayTime(new Date(sysClock.datetime))
  }, [sysClock])

  useEffect(() => {
    const interval = setInterval(() => {
      if (!startTimeRef.current) return
      const elapsed = Date.now() - startTimeRef.current.localMs
      setDisplayTime(new Date(startTimeRef.current.serverMs + elapsed))
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  // ── Attendance data ───────────────────────────────────────────
  const { data: todayAttendance, isLoading, refetch } = useQuery({
    queryKey: attendanceKeys.today(user?.id),
    queryFn: () => getAttendanceToday({ personal: true }),
    refetchOnWindowFocus: true,
    refetchOnMount: 'stale',
  })

  const { data: currentSchedule, isLoading: loadingSchedule } = useQuery({
    queryKey: [...employeeScheduleKeys.currentForEmployee(user?.employee?.id), sysClock?.date],
    queryFn: () => getCurrentScheduleForEmployee(user?.employee?.id),
    enabled: !!user?.employee?.id,
  })

  const currentCutoff = navigatedCutoff || getCutoffPeriod(sysClock?.date || new Date(), adminSettings)
  const activeCutoffLabel = currentCutoff.label

  const { data: monthlyData, isLoading: monthlyLoading } = useQuery({
    queryKey: attendanceKeys.monthly(employeeId, currentCutoff.startDate, currentCutoff.endDate),
    queryFn: () => getMonthlyAttendance(employeeId, currentCutoff.startDate, currentCutoff.endDate),
    enabled: Boolean(employeeId) && Boolean(currentCutoff),
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  })

  // ── Calendar Data ─────────────────────────────────────────────
  const { data: events = [] } = useQuery({
    queryKey: calendarEventKeys.list({ 
      start_date: currentCutoff.startDate, 
      end_date: currentCutoff.endDate 
    }),
    queryFn: () => getCalendarEvents({ 
      start_date: currentCutoff.startDate, 
      end_date: currentCutoff.endDate 
    }),
    enabled: !!currentCutoff,
  })

  const { data: eventTypes = [] } = useQuery({
    queryKey: calendarEventTypeKeys.all,
    queryFn: () => getCalendarEventTypes(),
  })

  const getEventForDate = (dateStr) => {
    if (!events) return null
    const key = toAttendanceDateStr(dateStr)
    return events.find(e => toAttendanceDateStr(e.event_date) === key)
  }

  const getEventTypeForEvent = (event) => {
    if (!event) return null
    return event.type || eventTypes.find(t => t.id === event.calendar_event_type_id)
  }

  const getEventColor = (event) => {
    if (!event) return null
    return event.color || event.type?.color || getEventTypeForEvent(event)?.color
  }

  const getEventCode = (event) => {
    const type = getEventTypeForEvent(event)
    if (!type) return null
    if (type.code) return type.code
    return type.name
      ?.split(' ')
      .map(word => word[0])
      .join('')
      .toUpperCase()
      .substring(0, 2) || 'E'
  }

  // Open the location preview modal, acquiring GPS coords in the background.
  // Skip it entirely (clock in normally, no location) when the employee is
  // exempt or today isn't a selected location-capture day.
  const startClockIn = async () => {
    const days = (geofence?.capture_days ?? [1, 2, 3, 4, 5, 6, 7]).map(Number)
    const jsDay = new Date(`${sysClock?.date ?? new Date().toISOString().slice(0, 10)}T00:00:00`).getDay()
    const todayIso = jsDay === 0 ? 7 : jsDay
    const captureToday = geofence?.capture_enabled !== false
      && user?.employee?.geo_tracking_enabled !== false
      && days.includes(todayIso)
    if (!captureToday) {
      inMutation.mutate(null)
      return
    }
    setLocationModal({ open: true, loading: true, coords: null })
    const coords = await getClockInCoords()
    setLocationModal({ open: true, loading: false, coords })
  }

  const inMutation = useMutation({
    mutationFn: (coords = null) => clockIn(notes, null, coords),
    onSuccess: () => {
      setNotes('')
      setLocationModal({ open: false, loading: false, coords: null })
      qc.invalidateQueries({ queryKey: attendanceKeys.all })
      qc.invalidateQueries({ queryKey: systemClockKeys.all })
    },
    onError: () => {
      setNotes('')
      refetch()
    },
  })
  const outMutation = useMutation({
    mutationFn: ({ confirmEarlyClockOut = false, fileOvertimeRequest = null } = {}) =>
      clockOut(notes, null, confirmEarlyClockOut, null, fileOvertimeRequest),
    onSuccess: () => {
      setNotes('')
      setOtConfirm({ open: false, overtimeHours: null, hoursWorked: null, requiredHours: null })
      qc.invalidateQueries({ queryKey: attendanceKeys.all })
      qc.invalidateQueries({ queryKey: systemClockKeys.all })
    },
    onError: (error, variables) => {
      const data = error?.response?.data
      const shouldConfirmEarlyClockOut =
        error?.response?.status === 422 && data?.confirm_required

      if (shouldConfirmEarlyClockOut && !variables?.confirmEarlyClockOut) {
        setEarlyClockOutConfirmOpen(true)
        return
      }

      if (error?.response?.status === 422 && data?.ot_confirm_required) {
        setOtConfirm({
          open: true,
          overtimeHours: data?.data?.overtime_hours ?? null,
          hoursWorked: data?.data?.hours_worked ?? null,
          requiredHours: data?.data?.required_hours ?? null,
        })
        return
      }

      setAlertConfig({ open: true, title: 'Clock Out Failed', message: data?.message || 'Failed to clock out', type: 'error' })
      setNotes('')
      refetch()
    },
  })

  if (isLoading || authLoading || loadingSchedule || sysClockLoading) return <PageSpinner />

  const isOnLeave = todayAttendance?.on_leave ?? false
  const isClockedIn = todayAttendance?.clock_in_time
  const isClockedOut = todayAttendance?.clock_out_time
  const shiftDate = todayAttendance?.shift_date
  const openShiftDayOfWeek = (() => {
    if (!isClockedIn || isClockedOut || !shiftDate) return null
    const parts = String(shiftDate).slice(0, 10).split('-').map(Number)
    if (parts.length !== 3 || parts.some(n => Number.isNaN(n))) return null
    const [y, m, d] = parts
    return new Date(y, m - 1, d).getDay()
  })()
  const monthlyLogs = monthlyData?.data ?? []
  const statusCounts = monthlyLogs.reduce((acc, log) => {
    const status = log.status || 'unknown'
    acc[status] = (acc[status] || 0) + 1
    return acc
  }, {})

  const visualStatuses = [
    { key: 'completed', label: 'Completed', color: 'bg-emerald-500' },
    { key: 'late', label: 'Late', color: 'bg-amber-500' },
    { key: 'undertime', label: 'Undertime', color: 'bg-orange-500' },
    { key: 'half_day', label: 'Half Day', color: 'bg-orange-300' },
    { key: 'absent', label: 'Absent', color: 'bg-rose-500' },
    { key: 'on_leave', label: 'On Leave', color: 'bg-sky-500' },
    { key: 'rest_day', label: 'Rest Day', color: 'bg-blue-500' },
  ]

  const totalVisualDays = visualStatuses.reduce((sum, item) => sum + (statusCounts[item.key] || 0), 0)

  const moveCutoff = (delta) => {
    if (delta > 0) setNavigatedCutoff(getNextCutoff(currentCutoff, adminSettings))
    else setNavigatedCutoff(getPrevCutoff(currentCutoff, adminSettings))
  }

  // Pass sysClock to window check so it uses the virtual time
  const window = getClockWindow(
    currentSchedule,
    sysClock,
    openShiftDayOfWeek != null ? { openShiftDayOfWeek } : {}
  )
  const canClockIn = canEmployeeClockIn(window, {
    overnightClockInBlocked: Boolean(todayAttendance?.overnight_clock_in_blocked),
  })
  const canClockOut = Boolean(window) && Boolean(isClockedIn) && !isClockedOut
  const isTooEarlyToClockIn = Boolean(window) && !window.isInactiveDay && window.currentMinutes < window.inStart
  const isClockInWindowClosed = Boolean(window) && !window.isInactiveDay && (
    window.currentMinutes > window.outEnd || Boolean(todayAttendance?.overnight_clock_in_blocked)
  )

  // Formatted display values — show system clock, not browser clock
  const displayDateLabel = displayTime
    ? format(displayTime, 'EEEE, MMMM d, yyyy')
    : (sysClock?.date ?? format(new Date(), 'EEEE, MMMM d, yyyy'))

  const displayTimeLabel = displayTime
    ? format(displayTime, 'HH:mm:ss')
    : (sysClock?.time ?? format(new Date(), 'HH:mm:ss'))

  const displayDateShort = displayTime
    ? format(displayTime, 'EEEE, MMMM d')
    : (sysClock?.date ?? format(new Date(), 'EEEE, MMMM d'))

  const timerDisplay = (() => {
    if (!isClockedIn) return '00:00:00'
    
    try {
      const [inH, inM, inS] = todayAttendance.clock_in_time.split(':').map(Number)
      let endH, endM, endS

      if (isClockedOut) {
        const parts = todayAttendance.clock_out_time.split(':').map(Number)
        endH = parts[0]
        endM = parts[1]
        endS = parts[2]
      } else {
        const parts = displayTimeLabel.split(':').map(Number)
        if (parts.length !== 3) return '00:00:00'
        endH = parts[0]
        endM = parts[1]
        endS = parts[2]
      }

      let diffSeconds = (endH * 3600 + endM * 60 + endS) - (inH * 3600 + inM * 60 + inS)
      if (diffSeconds < 0) {
        diffSeconds += 24 * 3600
      }

      const h = Math.floor(diffSeconds / 3600).toString().padStart(2, '0')
      const m = Math.floor((diffSeconds % 3600) / 60).toString().padStart(2, '0')
      const s = Math.floor(diffSeconds % 60).toString().padStart(2, '0')

      return `${h}:${m}:${s}`
    } catch {
      return '00:00:00'
    }
  })()

  // ── Geolocation on clock-in (UX preview; backend is authoritative) ──
  const geoOffices = geofence?.offices ?? []
  const captureDays = (geofence?.capture_days ?? [1, 2, 3, 4, 5, 6, 7]).map(Number)
  // Today's ISO weekday (1=Mon .. 7=Sun) from the virtual system clock.
  const geoJsDay = new Date(`${sysClock?.date ?? new Date().toISOString().slice(0, 10)}T00:00:00`).getDay()
  const geoTodayIso = geoJsDay === 0 ? 7 : geoJsDay
  // Is location captured at all today? (master switch + per-employee exemption + selected days)
  const captureActiveToday = geofence?.capture_enabled !== false
    && user?.employee?.geo_tracking_enabled !== false
    && captureDays.includes(geoTodayIso)
  const geoActive = captureActiveToday
    && Boolean(geofence?.enabled)
    && geoOffices.length > 0
  const geoMode = geofence?.mode ?? 'enforce'

  const evalGeofence = (coords) => {
    if (!geoActive) return null
    if (!coords) return { ok: geoMode !== 'enforce', reason: 'no-location' }
    let best = null
    for (const o of geoOffices) {
      if (o.lat == null || o.lng == null) continue
      const dist = distanceMeters(coords.latitude, coords.longitude, Number(o.lat), Number(o.lng))
      if (!best || dist < best.dist) best = { office: o, dist }
    }
    if (!best) return null
    const inside = best.dist <= Number(best.office.radius_m ?? 200)
    return { ok: inside || geoMode !== 'enforce', inside, office: best.office, dist: best.dist }
  }

  const geoStatus = locationModal.open ? evalGeofence(locationModal.coords) : null
  const geoBlocked = Boolean(geoStatus && !geoStatus.ok)

  return (
    <div>
      <AlertModal
        open={alertConfig.open}
        onClose={() => setAlertConfig(a => ({ ...a, open: false }))}
        title={alertConfig.title}
        message={alertConfig.message}
        type={alertConfig.type}
      />

      <Modal
        open={locationModal.open}
        onClose={() => setLocationModal({ open: false, loading: false, coords: null })}
        title="Confirm Your Location"
        size="lg"
        footer={
          <div className="flex gap-2">
            <button
              onClick={() => inMutation.mutate(locationModal.coords)}
              disabled={locationModal.loading || inMutation.isPending || geoBlocked}
              className={`btn flex-1 h-11 text-sm ${geoBlocked ? 'bg-gray-100 text-gray-400 cursor-not-allowed border-gray-200' : 'btn-primary'}`}
            >
              <Clock size={16} />
              {geoBlocked ? 'Outside allowed area' : (inMutation.isPending ? 'Clocking in...' : 'Confirm Clock In')}
            </button>
            <button
              onClick={() => setLocationModal({ open: false, loading: false, coords: null })}
              className="btn-ghost flex-1 h-11 text-sm"
            >
              Cancel
            </button>
          </div>
        }
      >
        {locationModal.loading ? (
          <div className="flex flex-col items-center justify-center py-16 text-gray-500">
            <MapPin size={28} className="text-brand-500 animate-pulse mb-3" />
            <p className="text-sm">Getting your location…</p>
          </div>
        ) : locationModal.coords ? (
          <div>
            <GeofenceMapPreview
              lat={locationModal.coords.latitude}
              lng={locationModal.coords.longitude}
              zoom={16}
              height={320}
              radiusM={geoStatus?.office ? Number(geoStatus.office.radius_m ?? 200) : 0}
              circleLat={geoStatus?.office?.lat}
              circleLng={geoStatus?.office?.lng}
            />
            <p className="text-xs text-gray-500 mt-3 flex items-center gap-1.5">
              <MapPin size={12} className="text-brand-500" />
              {locationModal.coords.latitude.toFixed(6)}, {locationModal.coords.longitude.toFixed(6)}
            </p>
            {geoStatus && geoStatus.office && (
              <div className={`mt-3 rounded-lg px-3 py-2 text-xs font-medium border ${geoStatus.inside ? 'bg-green-50 border-green-200 text-green-700' : (geoMode === 'enforce' ? 'bg-red-50 border-red-200 text-red-700' : 'bg-amber-50 border-amber-200 text-amber-700')}`}>
                {geoStatus.inside
                  ? `✓ Inside ${geoStatus.office.name || 'the workplace'} (${formatMeters(geoStatus.dist)} away)`
                  : geoMode === 'enforce'
                    ? `✗ ${formatMeters(geoStatus.dist)} from ${geoStatus.office.name || 'the nearest office'} — outside the ${Number(geoStatus.office.radius_m ?? 200)}m radius. Clock-in is blocked here.`
                    : `⚠ ${formatMeters(geoStatus.dist)} from ${geoStatus.office.name || 'the nearest office'} — outside the allowed radius. This will be recorded.`}
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-center text-gray-500">
            <MapPin size={28} className={geoBlocked ? 'text-red-300 mb-3' : 'text-gray-300 mb-3'} />
            <p className="text-sm font-medium text-gray-700">Location unavailable</p>
            <p className="text-xs text-gray-500 mt-1 max-w-xs">
              {geoBlocked
                ? 'Your workplace requires a location to clock in. Enable location access in your browser and try again.'
                : "We couldn't access your location. You can still clock in — it just won't be geo-tagged."}
            </p>
          </div>
        )}
      </Modal>

      <ConfirmModal
        open={earlyClockInConfirmOpen}
        onClose={() => setEarlyClockInConfirmOpen(false)}
        onConfirm={() => {
          setEarlyClockInConfirmOpen(false)
          startClockIn()
        }}
        title="Clock In Early?"
        message="Note: Clocking in early won't count toward overtime and will only be applied normally. Do you wish to proceed?"
        type="warning"
        confirmLabel="Confirm Clock In"
      />

      <ConfirmModal
        open={earlyClockOutConfirmOpen}
        onClose={() => setEarlyClockOutConfirmOpen(false)}
        onConfirm={() => {
          outMutation.mutate({ confirmEarlyClockOut: true })
          setEarlyClockOutConfirmOpen(false)
        }}
        title="Clock Out Early?"
        message="Clock out now even though hours will be counted as incomplete?"
        type="danger"
        confirmLabel="Confirm Clock Out"
      />

      <Modal
        open={otConfirm.open}
        onClose={() => setOtConfirm({ open: false, overtimeHours: null, hoursWorked: null, requiredHours: null })}
        title="File overtime request?"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            {otConfirm.overtimeHours != null
              ? `You worked ${Number(otConfirm.overtimeHours).toFixed(1)}h past your scheduled end. File an overtime request for HR approval?`
              : 'You worked past your scheduled end. File an overtime request for HR approval?'}
          </p>
          <div className="grid grid-cols-1 gap-2">
            <button
              onClick={() => {
                outMutation.mutate({ fileOvertimeRequest: true })
                setOtConfirm({ open: false, overtimeHours: null, hoursWorked: null, requiredHours: null })
              }}
              className="w-full btn bg-purple-600 hover:bg-purple-700 text-white"
            >
              File OT Request
            </button>
            <button
              onClick={() => {
                outMutation.mutate({ fileOvertimeRequest: false })
                setOtConfirm({ open: false, overtimeHours: null, hoursWorked: null, requiredHours: null })
              }}
              className="w-full btn bg-gray-100 hover:bg-gray-200 text-gray-800"
            >
              Clock Out Without OT
            </button>
          </div>
        </div>
      </Modal>

      <PageHeader
        title="Clock In / Out"
        description={displayDateLabel}
        action={
          <button onClick={() => navigate('/employee')} className="btn-secondary">
            ← Back
          </button>
        }
        help={[
          { heading: 'Live Clock', items: [
            'The date and time shown at the top reflects the server\'s virtual clock, which all employees share.',
            'The clock updates every 30 seconds automatically.',
          ]},
          { heading: 'Clocking In & Out', items: [
            'Click the green Clock In button when you arrive. Your schedule window is displayed — clocking in outside that window may result in a "Late" or "Early" status.',
            'Click the red Clock Out button at the end of your shift. Clocking out too early may trigger "Undertime" status.',
            'If you worked past your scheduled end, you will be asked whether to file an overtime request for HR approval.',
            'An optional Notes field appears before confirming — use it to add context for your HR team.',
          ]},
          { heading: 'Location Check-In', items: [
            'If your company has enabled location check-in, clicking Clock In opens a map showing your current location — confirm it to record your clock-in.',
            'The first time, your browser will ask permission to access your location; allow it. If you deny it (or on days location is not required), you can still clock in normally.',
            'If your workplace uses a geofence, you must be within the allowed area to clock in — the map shows whether you are inside the zone, and Confirm is disabled if you are outside it.',
            'Location check-in needs a secure (HTTPS) connection to read your device GPS.',
          ]},
          { heading: "Today's Record", items: [
            'Once clocked in, your clock-in time and elapsed hours are displayed on this page.',
            'After clocking out, your total hours worked for the day are shown.',
          ]},
          { heading: 'Monthly Attendance Log', items: [
            'Below the clock-in panel, your attendance records for the current month are listed by payroll cutoff period.',
            'Use the Previous / Next arrows to navigate to earlier months.',
            'Each row shows the date, clock-in/out times, status, and hours worked.',
          ]},
        ]}
      />

      <div className="grid lg:grid-cols-3 gap-6 items-start">
        <div className="lg:col-span-1">
          <div className="card p-8">
            {/* Timer Display */}
            <div className="text-center mb-8">
              <div className="inline-block bg-gradient-to-br from-brand-100 to-brand-50 p-8 rounded-full mb-4">
                <Clock size={40} className="text-brand-600" />
              </div>
              <div className="text-5xl font-bold text-gray-900 mb-2 font-mono tracking-tight">
                {timerDisplay}
              </div>
              <p className="text-sm font-medium text-brand-600 mb-1">
                {isOnLeave ? 'On Approved Leave' : !isClockedIn ? 'Ready to Clock In' : (isClockedOut ? 'Shift Completed' : 'Time Elapsed')}
              </p>
              <p className="text-xs text-gray-500">{displayDateShort}</p>

              {window?.isRestDay && (
                <div className="inline-flex items-center gap-1.5 mt-2.5 px-3 py-1 rounded-full bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-100 text-blue-700">
                  <Sparkles size={12} />
                  <span className="text-[11px] font-semibold uppercase tracking-wide">Rest Day</span>
                </div>
              )}

              {window?.isFlexi && (() => {
                const required = window.requiredHours ?? 8
                const [th, tm, ts] = timerDisplay.split(':').map(Number)
                const elapsedHours = th + tm / 60 + (ts || 0) / 3600
                const pct = Math.min(100, Math.round((elapsedHours / required) * 100))
                const done = isClockedIn && elapsedHours >= required
                return (
                  <div className="mt-3 text-center">
                    <p className="text-xs text-gray-400 mb-1.5">
                      {isClockedIn
                        ? done
                          ? <span className="text-green-600 font-medium">✓ {required}h requirement met</span>
                          : <span>{Math.floor(elapsedHours)}h {Math.round((elapsedHours % 1) * 60)}m / {required}h required</span>
                        : <span>Required today: <span className="font-semibold text-gray-600">{required}h</span></span>
                      }
                    </p>
                    {isClockedIn && !isClockedOut && (
                      <div className="w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
                        <div
                          className={`h-1.5 rounded-full transition-all ${done ? 'bg-green-500' : 'bg-brand-500'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    )}
                  </div>
                )
              })()}
            </div>

            {/* Status Display */}
            {isClockedIn && (
              <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg">
                <p className="text-xs text-green-600 font-medium mb-1">✓ Clocked In</p>
                <p className="text-lg font-semibold text-green-900">{todayAttendance.clock_in_time}</p>
              </div>
            )}

            {isClockedOut && (
              <div className="mb-6 p-4 bg-gray-50 border border-gray-200 rounded-lg">
                <p className="text-xs text-gray-600 font-medium mb-1">✓ Clocked Out</p>
                <p className="text-lg font-semibold text-gray-900">{todayAttendance.clock_out_time}</p>
                <p className="text-xs text-gray-500 mt-2">Your work day is complete</p>
              </div>
            )}

            {/* Error Messages */}
            {inMutation.error && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex gap-2">
                <AlertCircle size={16} className="text-red-600 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-red-900">{inMutation.error.response?.data?.message}</p>
                </div>
              </div>
            )}

            {outMutation.error && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex gap-2">
                <AlertCircle size={16} className="text-red-600 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-red-900">{outMutation.error.response?.data?.message}</p>
                </div>
              </div>
            )}

            {/* Notes Field */}
            <textarea
              className="input mb-4 resize-none"
              rows="3"
              placeholder="Add notes (optional)"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              disabled={isClockedOut}
            />

            {/* Action Button */}
            {isOnLeave ? (
              <div className="p-4 bg-gray-50 border border-gray-200 rounded-lg text-center">
                <p className="text-sm font-medium text-gray-700">You have an approved leave today</p>
                <p className="text-xs text-gray-500 mt-1">Clock-in is not available on leave days</p>
              </div>
            ) : !isClockedIn ? (
              <>
                <button
                  onClick={() => {
                    if (window && window.currentMinutes < window.normalInStart) {
                      setEarlyClockInConfirmOpen(true)
                    } else {
                      startClockIn()
                    }
                  }}
                  disabled={inMutation.isPending || !canClockIn}
                  className={`btn w-full ${!canClockIn ? 'bg-gray-100 text-gray-400 cursor-not-allowed border-gray-200' : 'btn-primary'}`}
                >
                  <Clock size={16} />
                  {!canClockIn
                    ? (window?.isInactiveDay
                      ? 'Not scheduled today'
                      : (isTooEarlyToClockIn ? 'Not your scheduled time yet' : (isClockInWindowClosed ? 'Clock-in window closed' : 'Clock in unavailable')))
                    : (inMutation.isPending ? 'Clocking in...' : 'Clock In')}
                </button>
              </>
            ) : !isClockedOut ? (
              <>
                <button
                  onClick={() => {
                    if (window && window.currentMinutes < window.outStart) {
                      setEarlyClockOutConfirmOpen(true)
                    } else {
                      outMutation.mutate({ confirmEarlyClockOut: false })
                    }
                  }}
                  disabled={outMutation.isPending || !canClockOut}
                  className={`btn w-full ${!canClockOut ? 'bg-gray-100 text-gray-400 cursor-not-allowed border-gray-200' : 'btn-secondary'}`}
                >
                  <LogOut size={16} />
                  {!canClockOut ? 'Not available' : (outMutation.isPending ? 'Clocking out...' : 'Clock Out')}
                </button>
              </>
            ) : (
              <div className="p-3 bg-gray-50 rounded-lg text-center">
                <p className="text-sm text-gray-600">You've already clocked out today</p>
              </div>
            )}
          </div>
        </div>

        <div className="lg:col-span-2 space-y-6">
          <div className="card p-6">
            <h2 className="text-sm font-semibold text-gray-700 mb-6">Assigned Schedule</h2>
            <ScheduleDisplay schedule={currentSchedule} sysClock={sysClock} />
          </div>

          <div className="card p-5">
            <div className="flex items-center justify-between gap-3 mb-4">
              <div>
                <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                  <CalendarDays size={14} className="text-brand-600" /> Attendance Log
                </h2>
                <p className="text-xs text-gray-500 mt-1">Only your own attendance records are shown here.</p>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" className="btn-secondary text-xs px-2 py-1" onClick={() => moveCutoff(-1)}>
                  Prev
                </button>
                <span className="text-sm font-medium text-gray-700 min-w-[110px] text-center">{activeCutoffLabel}</span>
                <button type="button" className="btn-secondary text-xs px-2 py-1" onClick={() => moveCutoff(1)}>
                  Next
                </button>
              </div>
            </div>

            <div className="mb-5 rounded-lg border border-gray-200 p-4 bg-gray-50">
              <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-3">Attendance Visualization</p>
              {totalVisualDays > 0 ? (
                <div className="space-y-3">
                  {visualStatuses.map((item) => {
                    const count = statusCounts[item.key] || 0
                    const percent = totalVisualDays > 0 ? Math.round((count / totalVisualDays) * 100) : 0
                    return (
                      <div key={item.key}>
                        <div className="flex items-center justify-between text-xs text-gray-600 mb-1">
                          <span>{item.label}</span>
                          <span>{count} ({percent}%)</span>
                        </div>
                        <div className="h-2 rounded-full bg-white overflow-hidden">
                          <div className={`${item.color} h-2 rounded-full`} style={{ width: `${percent}%` }} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <p className="text-sm text-gray-400">No logs yet for {activeCutoffLabel}.</p>
              )}
            </div>

            <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 mb-5">
              <p className="font-semibold mb-1">Important Note:</p>
              <p>Late clock-ins and absences are automatically processed for deductions in the payroll system.</p>
            </div>

            {monthlyLoading ? (
              <PageSpinner />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-gray-100">
                    <tr>
                      {['Date', 'Template', 'Clock In', 'Clock Out', 'Hours', 'Status'].map(h => (
                        <th key={h} className="pb-2 text-left text-xs text-gray-400 font-medium pr-4">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {monthlyLogs.map(log => (
                      <tr key={log.id || log.date} className="hover:bg-gray-50">
                        <td className="py-2.5 pr-4 text-gray-600">{format(parseISO(toAttendanceDateStr(log.date)), 'MMM dd, yyyy')}</td>
                        <td className="py-2.5 pr-4 text-gray-600">{log.template_name || '—'}</td>
                        <td className="py-2.5 pr-4 text-gray-600">{log.clock_in_time ?? '—'}</td>
                        <td className="py-2.5 pr-4 text-gray-600">{log.clock_out_time ?? '—'}</td>
                        <td className="py-2.5 pr-4 text-gray-600">{calculateHours(log.clock_in_time, log.clock_out_time)}</td>
                        <td className="py-2.5">
                          {(() => {
                            const event = getEventForDate(log.date)
                            const color = getEventColor(event)
                            const type = getEventTypeForEvent(event)
                            
                            if (type) {
                              return (
                                <span 
                                  className="px-2 py-1 rounded-md text-[10px] font-bold uppercase border"
                                  style={{ backgroundColor: `${color}15`, color: color, borderColor: `${color}30` }}
                                  title={event.title}
                                >
                                  {type.name || 'Event'}
                                </span>
                              )
                            }

                            if (log.status === 'completed') return <span className="badge-green text-[10px] px-1.5 py-0.5 rounded">Completed</span>
                            if (log.status === 'overtime') return <span className="badge-purple text-[10px] px-1.5 py-0.5 rounded">Overtime</span>
                            if (log.status === 'working') return <span className="badge-green text-[10px] px-1.5 py-0.5 rounded animate-pulse">Working</span>
                            if (log.status === 'on_leave') return <span className="badge-blue text-[10px] px-1.5 py-0.5 rounded">On Leave</span>
                            if (log.status === 'late') return <span className="badge-yellow text-[10px] px-1.5 py-0.5 rounded">Late</span>
                            if (log.status === 'undertime') return <span className="badge-yellow text-[10px] px-1.5 py-0.5 rounded">Undertime</span>
                            if (log.status === 'half_day') return <span className="badge-orange text-[10px] px-1.5 py-0.5 rounded">Half Day</span>
                            if (log.status === 'rest_day') return <span className="badge-blue text-[10px] px-1.5 py-0.5 rounded">Rest Day</span>
                            if (log.status === 'holiday') return <span className="badge-purple text-[10px] px-1.5 py-0.5 rounded">Holiday</span>
                            if (log.status === 'absent') return <span className="badge-red text-[10px] px-1.5 py-0.5 rounded">Absent</span>
                            return <span className="badge-gray text-[10px] px-1.5 py-0.5 rounded">{log.status?.replace('_', ' ') || '—'}</span>
                          })()}
                        </td>
                      </tr>
                    ))}
                    {monthlyLogs.length === 0 && (
                      <tr>
                        <td colSpan={6} className="py-6 text-center text-gray-400 text-sm">No records for this cutoff</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}