import { useState, useEffect, useRef, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { PageHeader, FormField, ConfirmModal, AlertModal, Spinner } from '../../components/ui/index.jsx'
import GeofenceMapPreview from '../../components/GeofenceMapPreview.jsx'
import { adminSettingsKeys, getAdminSettings, updateAdminSetting, uploadLogo, deleteLogo, uploadPayrollTemplate, getLogos, getSystemClock, systemClockKeys, attendanceKeys, leaveKeys, employeeLeaveBalanceKeys, themeColorKeys, systemConfigKeys, geofenceConfigKeys } from '../../api/queries'
import { Clock, Calendar, Save, RotateCcw, Zap, Palette, Monitor, Upload, Image as ImageIcon, Check, FileSpreadsheet, Trash2, FileText, MapPin, Plus, LocateFixed } from 'lucide-react'

const formatDateForInput = (date) => date.toLocaleDateString('en-CA')

const formatTimeForInput = (date) => date.toTimeString().split(' ')[0]

const normalizeTimeValue = (timeValue) => {
  if (!timeValue) return ''
  return timeValue.length === 5 ? `${timeValue}:00` : timeValue
}

// office_locations may arrive as an array (json-cast) or a raw JSON string.
const parseOffices = (value) => {
  if (Array.isArray(value)) return value
  if (typeof value === 'string' && value.trim()) {
    try { const p = JSON.parse(value); return Array.isArray(p) ? p : [] } catch { return [] }
  }
  return []
}

// geo_capture_days: array of ISO weekday numbers (1=Mon .. 7=Sun).
const parseDays = (value, fallback = [1, 2, 3, 4, 5, 6, 7]) => {
  if (Array.isArray(value)) return value.map(Number)
  if (typeof value === 'string' && value.trim()) {
    try { const p = JSON.parse(value); return Array.isArray(p) ? p.map(Number) : fallback } catch { return fallback }
  }
  return fallback
}

const WEEKDAYS = [
  { iso: 1, label: 'Mon' }, { iso: 2, label: 'Tue' }, { iso: 3, label: 'Wed' },
  { iso: 4, label: 'Thu' }, { iso: 5, label: 'Fri' }, { iso: 6, label: 'Sat' }, { iso: 7, label: 'Sun' },
]

// Normalize the server settings array into the flat set of editable values the
// form holds. Used both to populate the form and to compute the clean baseline.
const settingsToValues = (settings) => {
  const now = new Date()
  const find = (k) => settings.find(s => s.key === k)?.value
  const asBool = (k, def = false) => {
    const v = find(k)
    return v === undefined ? def : (v === 'true' || v === true || v === '1')
  }
  const asJsonText = (k) => {
    const v = find(k)
    if (v === undefined) return ''
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2)
  }
  return {
    date: find('system_date') || formatDateForInput(now),
    time: normalizeTimeValue(find('system_time') || formatTimeForInput(now)),
    absentMarkingTime: (find('absent_marking_time') || '23:59').substring(0, 5),
    systemName: find('system_name') || 'LAUNCHR',
    systemLogo: find('system_logo') || 'launchr_black.svg',
    payrollTemplate: find('payroll_template') || 'payrolltemplate.xlsx',
    autoClockOut: asBool('auto_clock_out_enabled'),
    requireLoginOtp: asBool('login_otp_required'),
    dtrPageEnabled: asBool('dtr_page_enabled'),
    dtrUploadFrequency: find('dtr_upload_frequency') ?? 'semi_monthly',
    dtrPerEmployeeRestriction: asBool('dtr_per_employee_restriction'),
    dtrCutoff1Day: parseInt(find('dtr_cutoff1_day') ?? '10'),
    dtrCutoff2Day: parseInt(find('dtr_cutoff2_day') ?? '25'),
    sssTable: asJsonText('sss_contribution_table'),
    withholdingTable: asJsonText('withholding_tax_table'),
    themeColor: find('theme_color') || 'sienna',
    payrollFrequency: find('payroll_frequency') ?? 'semi_monthly',
    p1Start: parseInt(find('payroll_period1_start_day') ?? '1'),
    p1End: parseInt(find('payroll_period1_end_day') ?? '15'),
    p2Start: parseInt(find('payroll_period2_start_day') ?? '16'),
    p2End: parseInt(find('payroll_period2_end_day') ?? '31'),
    pMonthlyStart: parseInt(find('payroll_monthly_start_day') ?? '1'),
    pMonthlyEnd: parseInt(find('payroll_monthly_end_day') ?? '31'),
    geoCaptureEnabled: asBool('geo_capture_enabled', true),
    geofenceEnabled: asBool('geofence_enabled'),
    geofenceMode: find('geofence_mode') ?? 'enforce',
    captureDays: parseDays(find('geo_capture_days')),
    offices: parseOffices(find('office_locations')),
  }
}

// Stable serialization of the form values for dirty comparison (fixed key order).
const snapshotOf = (v) => JSON.stringify([
  v.date, v.time, v.absentMarkingTime, v.systemName, v.systemLogo, v.payrollTemplate,
  v.autoClockOut, v.requireLoginOtp, v.dtrPageEnabled, v.dtrUploadFrequency, v.dtrPerEmployeeRestriction,
  v.dtrCutoff1Day, v.dtrCutoff2Day, v.sssTable, v.withholdingTable, v.themeColor, v.payrollFrequency,
  v.p1Start, v.p1End, v.p2Start, v.p2End, v.pMonthlyStart, v.pMonthlyEnd,
  v.geoCaptureEnabled, v.geofenceEnabled, v.geofenceMode, v.captureDays, v.offices,
  v.hasNewLogo ?? false, v.hasNewTemplate ?? false,
])

const themePresets = [
  { id: 'green', name: 'Emerald Green', colorClass: 'bg-emerald-600' },
  { id: 'blue', name: 'Ocean Blue', colorClass: 'bg-blue-600' },
  { id: 'purple', name: 'Royal Purple', colorClass: 'bg-purple-600' },
  { id: 'sienna', name: 'Sienna', colorClass: 'bg-[#D85A30]' },
  { id: 'rose', name: 'Rose Petal', colorClass: 'bg-rose-600' },
]

export default function SystemSettingsPage() {
  const qc = useQueryClient()
  const fileInputRef = useRef(null)
  const templateFileInputRef = useRef(null)
  const [dateTime, setDateTime] = useState({ date: '', time: '' })
  const [absentMarkingTime, setAbsentMarkingTime] = useState('23:59')
  const [systemName, setSystemName] = useState('LAUNCHR')
  const [systemLogo, setSystemLogo] = useState('launchr_black.svg')
  const [payrollTemplate, setPayrollTemplate] = useState('payrolltemplate.xlsx')
  const [logoPreview, setLogoPreview] = useState(null)
  const [selectedFile, setSelectedFile] = useState(null)
  const [selectedTemplateFile, setSelectedTemplateFile] = useState(null)
  const [autoClockOut, setAutoClockOut] = useState(false)
  const [requireLoginOtp, setRequireLoginOtp] = useState(false)
  const [dtrPageEnabled, setDtrPageEnabled] = useState(false)
  const [dtrUploadFrequency, setDtrUploadFrequency] = useState('semi_monthly')
  const [dtrPerEmployeeRestriction, setDtrPerEmployeeRestriction] = useState(false)
  const [dtrCutoff1Day, setDtrCutoff1Day] = useState(10)
  const [dtrCutoff2Day, setDtrCutoff2Day] = useState(25)
  const [sssTable, setSssTable] = useState('')
  const [withholdingTable, setWithholdingTable] = useState('')
  const [themeColor, setThemeColor] = useState('sienna')
  const [payrollFrequency, setPayrollFrequency] = useState('semi_monthly')
  const [p1Start, setP1Start] = useState(1)
  const [p1End, setP1End] = useState(15)
  const [p2Start, setP2Start] = useState(16)
  const [p2End, setP2End] = useState(31)
  const [pMonthlyStart, setPMonthlyStart] = useState(1)
  const [pMonthlyEnd, setPMonthlyEnd] = useState(31)
  const [geoCaptureEnabled, setGeoCaptureEnabled] = useState(true)
  const [geofenceEnabled, setGeofenceEnabled] = useState(false)
  const [geofenceMode, setGeofenceMode] = useState('enforce')
  const [captureDays, setCaptureDays] = useState([1, 2, 3, 4, 5, 6, 7])
  const [offices, setOffices] = useState([])
  const [confirmConfig, setConfirmConfig] = useState({ open: false, onConfirm: () => {}, message: '', title: '', type: 'info' })
  const [alertConfig, setAlertConfig] = useState({ open: false, title: '', message: '', type: 'error' })
  const baselineRef = useRef(null)
  const clockSeededRef = useRef(false)

  const { data: settings = [], isLoading } = useQuery({
    queryKey: adminSettingsKeys.all,
    queryFn: getAdminSettings,
  })

  const { data: systemClock } = useQuery({
    queryKey: systemClockKeys.all,
    queryFn: getSystemClock,
  })

  const { data: availableLogos = [] } = useQuery({
    queryKey: ['admin', 'logos'],
    queryFn: getLogos,
  })

  // Push a normalized values object into the form's state.
  const applyValues = (v) => {
    setDateTime({ date: v.date, time: v.time })
    setAbsentMarkingTime(v.absentMarkingTime)
    setSystemName(v.systemName)
    setSystemLogo(v.systemLogo); setLogoPreview(null); setSelectedFile(null)
    setPayrollTemplate(v.payrollTemplate); setSelectedTemplateFile(null)
    setAutoClockOut(v.autoClockOut)
    setRequireLoginOtp(v.requireLoginOtp)
    setDtrPageEnabled(v.dtrPageEnabled)
    setDtrUploadFrequency(v.dtrUploadFrequency)
    setDtrPerEmployeeRestriction(v.dtrPerEmployeeRestriction)
    setDtrCutoff1Day(v.dtrCutoff1Day)
    setDtrCutoff2Day(v.dtrCutoff2Day)
    setSssTable(v.sssTable)
    setWithholdingTable(v.withholdingTable)
    setThemeColor(v.themeColor)
    setPayrollFrequency(v.payrollFrequency)
    setP1Start(v.p1Start); setP1End(v.p1End); setP2Start(v.p2Start); setP2End(v.p2End)
    setPMonthlyStart(v.pMonthlyStart); setPMonthlyEnd(v.pMonthlyEnd)
    setGeoCaptureEnabled(v.geoCaptureEnabled)
    setGeofenceEnabled(v.geofenceEnabled)
    setGeofenceMode(v.geofenceMode)
    setCaptureDays(v.captureDays)
    setOffices(v.offices)
  }

  useEffect(() => {
    if (settings.length === 0) return
    const v = settingsToValues(settings)
    applyValues(v)
    baselineRef.current = snapshotOf({ ...v, hasNewLogo: false, hasNewTemplate: false })
  }, [settings]) // eslint-disable-line react-hooks/exhaustive-deps

  // Live SystemClock advances past the stored system_time baseline; seed once.
  useEffect(() => {
    if (clockSeededRef.current) return
    if (settings.length === 0) return
    if (!systemClock?.date || !systemClock?.time) return
    clockSeededRef.current = true
    const next = {
      date: systemClock.date,
      time: normalizeTimeValue(systemClock.time),
    }
    setDateTime(next)
    const v = { ...settingsToValues(settings), ...next }
    baselineRef.current = snapshotOf({ ...v, hasNewLogo: false, hasNewTemplate: false })
  }, [settings, systemClock])

  const uploadLogoMutation = useMutation({
    mutationFn: uploadLogo,
    onSuccess: (data) => {
      setSystemLogo(data.data)
      setLogoPreview(null)
      setSelectedFile(null)
      qc.invalidateQueries({ queryKey: systemConfigKeys.all })
      qc.invalidateQueries({ queryKey: ['admin', 'logos'] })
      qc.invalidateQueries({ queryKey: adminSettingsKeys.all })
    }
  })

  const deleteLogoMutation = useMutation({
    mutationFn: deleteLogo,
    onSuccess: (_, filename) => {
      if (systemLogo === filename) setSystemLogo('launchr_black.svg')
      qc.invalidateQueries({ queryKey: ['admin', 'logos'] })
      qc.invalidateQueries({ queryKey: systemConfigKeys.all })
    },
    onError: (error) => {
      setAlertConfig({ open: true, title: 'Error', message: error?.response?.data?.message || 'Failed to delete logo', type: 'error' })
    },
  })

  const uploadTemplateMutation = useMutation({
    mutationFn: uploadPayrollTemplate,
    onSuccess: (data) => {
      setPayrollTemplate(data.data)
      setSelectedTemplateFile(null)
      qc.invalidateQueries({ queryKey: adminSettingsKeys.all })
    }
  })

  const updateSettingMutation = useMutation({
    mutationFn: async ({ date, time, autoClockOut, requireLoginOtp, absentMarkingTime, sssTable, withholdingTable, themeColor, systemName, systemLogo, payrollTemplate, dtrPageEnabled, dtrUploadFrequency, dtrPerEmployeeRestriction }) => {
      const normalizedTime = normalizeTimeValue(time)
      await updateAdminSetting('system_date', date, 'Virtual system date for simulation', 'string')
      await updateAdminSetting('system_time', normalizedTime, 'Virtual system time for simulation', 'string')
      await updateAdminSetting('auto_clock_out_enabled', autoClockOut, 'Whether automatic clock-out is enabled', 'boolean')
      await updateAdminSetting('login_otp_required', requireLoginOtp, 'Whether an email OTP is required to log in', 'boolean')
      await updateAdminSetting('absent_marking_time', absentMarkingTime, 'Time when the system automatically marks employees as absent', 'string')
      await updateAdminSetting('theme_color', themeColor, 'System theme color preset', 'string')
      await updateAdminSetting('system_name', systemName, 'The name of the system displayed in the sidebar', 'string')
      
      if (selectedFile) {
        await uploadLogoMutation.mutateAsync(selectedFile)
      } else {
        await updateAdminSetting('system_logo', systemLogo, 'The logo used by the system', 'string')
      }

      if (selectedTemplateFile) {
        await uploadTemplateMutation.mutateAsync(selectedTemplateFile)
      } else {
        await updateAdminSetting('payroll_template', payrollTemplate, 'The Excel template used for payroll generation', 'string')
      }

      if (sssTable) {
        try {
          const parsed = JSON.parse(sssTable)
          await updateAdminSetting('sss_contribution_table', parsed, 'SSS Employee Contribution Table', 'json')
        } catch (e) {
          console.error("Invalid SSS JSON", e)
        }
      }

      if (withholdingTable) {
        try {
          const parsed = JSON.parse(withholdingTable)
          await updateAdminSetting('withholding_tax_table', parsed, 'BIR Withholding Tax Brackets — TRAIN Law RA 10963 RR 8-2018', 'json')
        } catch (e) {
          console.error("Invalid Withholding Tax JSON", e)
        }
      }

      await updateAdminSetting('payroll_frequency',         payrollFrequency, 'Payroll cycle: semi_monthly or monthly',                     'string')
      await updateAdminSetting('payroll_period1_start_day', p1Start,          'Semi-monthly: start day of first period',                    'integer')
      await updateAdminSetting('payroll_period1_end_day',   p1End,            'Semi-monthly: end day of first period',                      'integer')
      await updateAdminSetting('payroll_period2_start_day', p2Start,          'Semi-monthly: start day of second period',                   'integer')
      await updateAdminSetting('payroll_period2_end_day',   p2End,            'Semi-monthly: end day of second period (31 = end of month)', 'integer')
      await updateAdminSetting('payroll_monthly_start_day',       pMonthlyStart,              'Monthly: start day of the payroll period',                         'integer')
      await updateAdminSetting('payroll_monthly_end_day',         pMonthlyEnd,                'Monthly: end day of the payroll period (31 = end of month)',         'integer')
      await updateAdminSetting('dtr_page_enabled',                dtrPageEnabled,             'Whether the DTR upload page is enabled for employees',               'boolean')
      await updateAdminSetting('dtr_upload_frequency',            dtrUploadFrequency,         'DTR upload frequency: semi_monthly or monthly',                       'string')
      await updateAdminSetting('dtr_per_employee_restriction',    dtrPerEmployeeRestriction,  'When true, DTR upload availability is controlled per employee',       'boolean')
      await updateAdminSetting('dtr_cutoff1_day',                 dtrCutoff1Day,              'DTR first cutoff day of month (used when frequency is semi_monthly)', 'integer')
      await updateAdminSetting('dtr_cutoff2_day',                 dtrCutoff2Day,              'DTR second cutoff day of month (used when frequency is semi_monthly)','integer')

      await updateAdminSetting('geo_capture_enabled', geoCaptureEnabled, 'Master switch: whether clock-in captures employee location at all', 'boolean')
      await updateAdminSetting('geofence_enabled', geofenceEnabled, 'Whether clock-in is restricted to configured office locations', 'boolean')
      await updateAdminSetting('geofence_mode',    geofenceMode,    'Geofence behavior: enforce (block) or warn (allow but record)',   'string')
      await updateAdminSetting('geo_capture_days', [...captureDays].sort((a, b) => a - b), 'Days clock-in prompts employees for their location (1=Mon .. 7=Sun)', 'json')
      await updateAdminSetting(
        'office_locations',
        offices
          .filter(o => o.name?.trim() && o.lat !== '' && o.lng !== '')
          .map(o => ({ name: o.name.trim(), lat: Number(o.lat), lng: Number(o.lng), radius_m: Number(o.radius_m) || 200 })),
        'Allowed clock-in zones: [{name, lat, lng, radius_m}]',
        'json'
      )
    },
    onSuccess: async () => {
      // Invalidate settings, system clock, AND all attendance queries so
      // the attendance clock page immediately reflects the new virtual time.
      await Promise.all([
        qc.invalidateQueries({ queryKey: adminSettingsKeys.all }),
        qc.invalidateQueries({ queryKey: systemClockKeys.all }),
        qc.invalidateQueries({ queryKey: attendanceKeys.all }),
        qc.invalidateQueries({ queryKey: leaveKeys.all }),
        qc.invalidateQueries({ queryKey: employeeLeaveBalanceKeys.all }),
        qc.invalidateQueries({ queryKey: themeColorKeys.all }),
        qc.invalidateQueries({ queryKey: systemConfigKeys.all }),
        qc.invalidateQueries({ queryKey: geofenceConfigKeys.all }),
      ])
      await Promise.all([
        qc.refetchQueries({ queryKey: systemClockKeys.all, type: 'active' }),
        qc.refetchQueries({ queryKey: attendanceKeys.all, type: 'active' }),
        qc.refetchQueries({ queryKey: leaveKeys.all, type: 'active' }),
        qc.refetchQueries({ queryKey: employeeLeaveBalanceKeys.all, type: 'active' }),
        qc.refetchQueries({ queryKey: themeColorKeys.all, type: 'active' }),
        qc.refetchQueries({ queryKey: systemConfigKeys.all, type: 'active' }),
      ])
    }
  })

  const handleFileChange = (e) => {
    const file = e.target.files[0]
    if (file) {
      setSelectedFile(file)
      const reader = new FileReader()
      reader.onloadend = () => {
        setLogoPreview(reader.result)
      }
      reader.readAsDataURL(file)
    }
  }

  const handleTemplateFileChange = (e) => {
    const file = e.target.files[0]
    if (file) {
      setSelectedTemplateFile(file)
    }
  }

  const handleSave = () => {
    setConfirmConfig({
      open: true,
      title: 'Save System Settings',
      message: 'Are you sure you want to update the settings? This may affect attendance records and payroll calculations.',
      type: 'brand',
      onConfirm: () => updateSettingMutation.mutate({ ...dateTime, autoClockOut, requireLoginOtp, absentMarkingTime, sssTable, withholdingTable, themeColor, systemName, systemLogo, payrollTemplate, dtrPageEnabled, dtrUploadFrequency, dtrPerEmployeeRestriction })
    })
  }

  const handleCancel = () => {
    setConfirmConfig({
      open: true,
      title: 'Discard Changes',
      message: 'Are you sure you want to discard your changes and reset to the last saved settings?',
      type: 'warning',
      onConfirm: () => applyValues(settingsToValues(settings)),
    })
  }

  const toggleCaptureDay = (iso) => setCaptureDays(prev =>
    prev.includes(iso) ? prev.filter(d => d !== iso) : [...prev, iso].sort((a, b) => a - b)
  )

  const updateOffice = (i, field, val) => setOffices(prev => prev.map((o, idx) => idx === i ? { ...o, [field]: val } : o))
  const addOffice = () => setOffices(prev => [...prev, { name: '', lat: '', lng: '', radius_m: 200 }])
  const removeOffice = (i) => setOffices(prev => prev.filter((_, idx) => idx !== i))

  // Accept a pasted "lat, lng" string in the latitude field and split it across both.
  const handleCoordInput = (i, raw) => {
    const m = raw.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/)
    if (m) {
      setOffices(prev => prev.map((o, idx) => idx === i ? { ...o, lat: m[1], lng: m[2] } : o))
    } else {
      updateOffice(i, 'lat', raw)
    }
  }

  const useCurrentLocation = (i) => {
    if (!navigator.geolocation) {
      setAlertConfig({ open: true, title: 'Not Supported', message: 'This browser cannot access location.', type: 'error' })
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => setOffices(prev => prev.map((o, idx) => idx === i
        ? { ...o, lat: pos.coords.latitude.toFixed(6), lng: pos.coords.longitude.toFixed(6) }
        : o)),
      () => setAlertConfig({ open: true, title: 'Location Blocked', message: 'Could not get your location. Check browser permissions — and note device GPS only works on HTTPS or localhost.', type: 'error' }),
      { enableHighAccuracy: true, timeout: 10000 }
    )
  }

  const handleSetCurrent = () => {
    setConfirmConfig({
      open: true,
      title: 'Set to Current Time',
      message: 'Are you sure you want to set the system date and time to your current local time? This will save immediately.',
      type: 'info',
      onConfirm: () => {
        // Capture the time at the exact moment the user confirms
        const now = new Date()
        const date = formatDateForInput(now)
        const time = formatTimeForInput(now)
        // Update form state so inputs reflect it
        setDateTime({ date, time })
        // Immediately persist — no need to click Save separately
        updateSettingMutation.mutate({ date, time, autoClockOut, requireLoginOtp, absentMarkingTime, sssTable, withholdingTable, themeColor, systemName, systemLogo, payrollTemplate, dtrPageEnabled, dtrUploadFrequency, dtrPerEmployeeRestriction })
      }
    })
  }

  const previewPeriods = useMemo(() => {
    const lastDay = (y, m) => new Date(y, m, 0).getDate()
    const resolve = (day, y, m) => (day === 31 ? lastDay(y, m) : day)
    const fmt = (y, m, d) => new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    const buildPeriod = (sDay, eDay, y, m) => {
      const rs = resolve(sDay, y, m)
      if (eDay < sDay) {
        const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1
        return { start: fmt(y, m, rs), end: fmt(ny, nm, resolve(eDay, ny, nm)) }
      }
      return { start: fmt(y, m, rs), end: fmt(y, m, resolve(eDay, y, m)) }
    }
    const now = new Date()
    const months = [0, 1, 2].map(i => {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1)
      return { y: d.getFullYear(), m: d.getMonth() + 1, label: d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) }
    })
    return months.flatMap(({ y, m, label }) =>
      payrollFrequency === 'monthly'
        ? [{ period: label, ...buildPeriod(pMonthlyStart, pMonthlyEnd, y, m) }]
        : [
            { period: `${label} — Period 1`, ...buildPeriod(p1Start, p1End, y, m) },
            { period: `${label} — Period 2`, ...buildPeriod(p2Start, p2End, y, m) },
          ]
    )
  }, [payrollFrequency, p1Start, p1End, p2Start, p2End, pMonthlyStart, pMonthlyEnd])

  // Derived unsaved-changes flag: current form values vs the baseline captured on load.
  const currentSnapshot = snapshotOf({
    date: dateTime.date, time: dateTime.time, absentMarkingTime,
    systemName, systemLogo, payrollTemplate, autoClockOut, requireLoginOtp,
    dtrPageEnabled, dtrUploadFrequency, dtrPerEmployeeRestriction, dtrCutoff1Day, dtrCutoff2Day,
    sssTable, withholdingTable, themeColor, payrollFrequency,
    p1Start, p1End, p2Start, p2End, pMonthlyStart, pMonthlyEnd,
    geoCaptureEnabled, geofenceEnabled, geofenceMode, captureDays, offices,
    hasNewLogo: !!selectedFile, hasNewTemplate: !!selectedTemplateFile,
  })
  const dirty = baselineRef.current !== null && currentSnapshot !== baselineRef.current

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size="lg" />
      </div>
    )
  }

  const logoBaseUrl = '/api/logo'

  return (
    <div className="max-w-4xl mx-auto">
      <PageHeader
        title="System Settings"
        description="Manage global system configurations and environment overrides."
        help={[
          { heading: 'General Configuration', items: [
            'Set the System Display Name — this appears in the sidebar for all users.',
            'Choose the active logo from the library, or upload a new one (PNG/JPG/SVG, max 2MB).',
            'Upload a custom Excel payroll template (XLSX) used for all payroll exports. Click "Download Current Template" to retrieve the active file.',
          ]},
          { heading: 'Authentication', items: [
            'Toggle "Require OTP at Login" to add an email one-time-password step on top of the password login.',
          ]},
          { heading: 'DTR Upload', items: [
            'Enable or disable the DTR Upload page for employees.',
            'Set the upload frequency (semi-monthly or monthly) and the cutoff days employees see when choosing a period.',
            'Enable Per-Employee Restriction to control DTR upload access individually per employee via DTR Management.',
          ]},
          { heading: 'Attendance Automation', items: [
            'Enable Auto Clock-Out to automatically close open shifts after the shift\'s end time has passed.',
            'Set the Absent Marking Time — the daily time at which employees with no clock-in record are marked absent.',
          ]},
          { heading: 'Geolocation on Clock-In', items: [
            'Enable Location Clock-In is the master switch — when off, no clock-in anywhere asks for a location.',
            'Location Capture Days chooses which weekdays employees are prompted for their location; on other days they clock in normally with no prompt.',
            'Enforce Geofencing restricts clock-in to configured office zones. Add each location by name with a latitude/longitude and radius — use "Use current" or paste a "lat, lng" from Google Maps. The map preview shows the radius circle.',
            'Enforce mode blocks out-of-range clock-ins; Warn mode allows them but still records the location.',
            'Individual employees can be exempted from location capture on their profile ("Capture location on clock-in").',
            'Device GPS requires an HTTPS connection in production.',
          ]},
          { heading: 'Visual Theme', items: [
            'Choose one of the five preset color themes. The selection is applied instantly across the entire application.',
          ]},
          { heading: 'Statutory Contribution Tables', items: [
            'Edit the SSS contribution brackets (JSON) to reflect new SSS-issued rates.',
            'Edit the Withholding Tax table (JSON) to update TRAIN Law brackets when BIR releases revised tables.',
          ]},
          { heading: 'Payroll Configuration', items: [
            'Set payroll frequency (semi-monthly or monthly) and the start/end day for each period.',
            'A preview table shows the upcoming 3 months of payroll periods based on your current settings.',
            'Changing frequency only affects future payroll runs — existing drafts must be deleted and regenerated.',
          ]},
          { heading: 'Date & Time (Virtual Clock)', items: [
            'Override the system clock used by all attendance and payroll calculations — useful for testing date-sensitive features.',
            'Click "Set Current Date/Time" to instantly sync back to real time. This saves immediately.',
            'Always click Save Settings after making any other changes on this page.',
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
      <AlertModal
        open={alertConfig.open}
        onClose={() => setAlertConfig(a => ({ ...a, open: false }))}
        title={alertConfig.title}
        message={alertConfig.message}
        type={alertConfig.type}
      />

      <div className="space-y-6">
        <div className="card overflow-hidden">
          <div className="border-b border-gray-100 bg-gray-50/50 px-6 py-5">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-brand-50 flex items-center justify-center text-brand-600">
                <Monitor size={20} />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-gray-900">General Configuration</h2>
                <p className="text-xs text-gray-500 mt-0.5">Customize the basic identity and appearance of your system.</p>
              </div>
            </div>
          </div>

          <div className="p-6 space-y-8">
            <FormField label="System Display Name" required description="This name appears in the sidebar and top navigation bar for all users.">
              <input
                type="text"
                value={systemName}
                onChange={(e) => setSystemName(e.target.value)}
                className="input h-11"
                placeholder="Enter system name (e.g., LAUNCHR)"
              />
            </FormField>

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-gray-700">System Logo</label>
                <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Selected: {selectedFile ? 'New Upload' : systemLogo}</div>
              </div>
              
              <div className="flex flex-col md:flex-row items-start gap-8">
                {/* Active Preview */}
                <div className="flex flex-col items-center gap-3">
                  <div className="w-40 h-40 rounded-2xl border-2 border-brand-100 bg-brand-50/20 flex items-center justify-center overflow-hidden shadow-inner relative group">
                    {logoPreview ? (
                      <img src={logoPreview} alt="Preview" className="w-full h-full object-contain p-4 transition-transform group-hover:scale-110" />
                    ) : systemLogo ? (
                      <img src={systemLogo.startsWith('data:') ? systemLogo : `${logoBaseUrl}/${systemLogo}`} alt="Current Logo" className="w-full h-full object-contain p-4 transition-transform group-hover:scale-110" />
                    ) : (
                      <ImageIcon size={48} className="text-gray-300" />
                    )}
                    <div className="absolute inset-0 bg-brand-600/0 group-hover:bg-brand-600/5 transition-colors pointer-events-none" />
                  </div>
                  <span className="text-[10px] font-bold text-brand-600 uppercase tracking-widest">Active Preview</span>
                </div>
                
                <div className="flex-1 w-full space-y-6">
                  {/* Upload Controls */}
                  <div className="p-4 rounded-xl border border-gray-100 bg-gray-50/50">
                    <div className="flex items-start gap-4">
                      <div className="w-10 h-10 rounded-lg bg-white shadow-sm border border-gray-100 flex items-center justify-center shrink-0 text-brand-600">
                        <Upload size={18} />
                      </div>
                      <div className="flex-1">
                        <p className="text-xs font-semibold text-gray-900 mb-1">Upload New Logo</p>
                        <p className="text-[11px] text-gray-500 mb-3 leading-relaxed">PNG, JPG, SVG supported. Max 2MB. This will be used in emails and login screens.</p>
                        
                        <input
                          type="file"
                          ref={fileInputRef}
                          onChange={handleFileChange}
                          accept="image/*"
                          className="hidden"
                        />
                        
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="btn-primary-soft text-[11px] px-3 py-1.5 flex items-center gap-2"
                        >
                          {selectedFile ? 'Change File' : 'Choose File'}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Existing Library */}
                  <div className="space-y-3">
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Existing Logo Library</p>
                    <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-8 gap-3">
                      {availableLogos.map((logo) => {
                        const isSelected = systemLogo === logo && !selectedFile
                        const isDefault = ['launchr_black.svg', 'launchr_logo.svg'].includes(logo)
                        return (
                          <div key={logo} className="relative group">
                            <button
                              type="button"
                              onClick={() => {
                                setSystemLogo(logo)
                                setLogoPreview(null)
                                setSelectedFile(null)
                              }}
                              className={`aspect-square w-full rounded-lg border-2 transition-all p-1.5 bg-white relative ${
                                isSelected
                                  ? 'border-brand-500 ring-2 ring-brand-500/20'
                                  : 'border-gray-100 hover:border-gray-300 shadow-sm'
                              }`}
                            >
                              <img
                                src={`${logoBaseUrl}/${logo}`}
                                alt={logo}
                                className="w-full h-full object-contain"
                              />
                              {isSelected && (
                                <div className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-brand-500 text-white flex items-center justify-center shadow-sm">
                                  <Check size={10} strokeWidth={4} />
                                </div>
                              )}
                            </button>
                            {!isDefault && (
                              <button
                                type="button"
                                onClick={() => setConfirmConfig({
                                  open: true,
                                  title: 'Delete Logo',
                                  message: `Delete "${logo}"? This cannot be undone.`,
                                  type: 'danger',
                                  onConfirm: () => deleteLogoMutation.mutate(logo),
                                })}
                                className="absolute -top-1.5 -left-1.5 w-5 h-5 rounded-full bg-red-500 text-white items-center justify-center shadow-sm hidden group-hover:flex z-10"
                              >
                                <Trash2 size={10} strokeWidth={3} />
                              </button>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-gray-700">Payroll Excel Template</label>
                <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Active: {selectedTemplateFile ? 'New Upload' : payrollTemplate}</div>
              </div>
              
              <div className="p-4 rounded-xl border border-gray-100 bg-gray-50/50">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-lg bg-white shadow-sm border border-gray-100 flex items-center justify-center shrink-0 text-brand-600">
                    <FileSpreadsheet size={18} />
                  </div>
                  <div className="flex-1">
                    <p className="text-xs font-semibold text-gray-900 mb-1">Upload Payroll Template</p>
                    <p className="text-[11px] text-gray-500 mb-3 leading-relaxed">XLSX, XLS supported. Max 5MB. This template will be used for all payroll exports.</p>
                    
                    <input
                      type="file"
                      ref={templateFileInputRef}
                      onChange={handleTemplateFileChange}
                      accept=".xlsx,.xls"
                      className="hidden"
                    />
                    
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => templateFileInputRef.current?.click()}
                        className="btn-primary-soft text-[11px] px-3 py-1.5 flex items-center gap-2"
                      >
                        {selectedTemplateFile ? 'Change File' : 'Choose File'}
                      </button>
                      {selectedTemplateFile && (
                        <span className="text-[10px] text-brand-600 font-medium truncate max-w-[200px] italic">
                          Selected: {selectedTemplateFile.name}
                        </span>
                      )}
                      {!selectedTemplateFile && (
                        <button 
                          type="button"
                          onClick={async () => {
                            try {
                              const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}/payroll-template`, {
                                headers: { 'Authorization': `Bearer ${localStorage.getItem('hr_token')}` }
                              });
                              if (!response.ok) throw new Error('Download failed');
                              const blob = await response.blob();
                              const url = window.URL.createObjectURL(blob);
                              const a = document.createElement('a');
                              a.href = url;
                              a.download = payrollTemplate; // Use the actual filename
                              document.body.appendChild(a);
                              a.click();
                              a.remove();
                              window.URL.revokeObjectURL(url);
                            } catch (err) {
                              setAlertConfig({ open: true, title: 'Download Failed', message: 'Failed to download template. Please check if you are still logged in.', type: 'error' })
                            }
                          }}
                          className="text-[10px] text-gray-400 hover:text-brand-600 font-medium underline flex items-center gap-1 ml-auto"
                        >
                          Download Current Template
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="card p-6">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Authentication</h2>
          <div className="flex items-center justify-between p-4 border rounded-lg">
            <div>
              <p className="text-sm font-medium text-gray-900">Require OTP at login</p>
              <p className="text-xs text-gray-500">When disabled, users can sign in with email and password only.</p>
            </div>
            <button
              type="button"
              onClick={() => setRequireLoginOtp(!requireLoginOtp)}
              className={`w-12 h-6 rounded-full flex items-center p-1 transition-colors ${requireLoginOtp ? 'bg-brand-600' : 'bg-gray-300'}`}
            >
              <div className={`w-4 h-4 rounded-full bg-white transition-transform ${requireLoginOtp ? 'translate-x-6' : ''}`} />
            </button>
          </div>
        </div>

        <div className="card p-6">
          <div className="flex items-center gap-3 mb-4">
            <FileText size={18} className="text-brand-600" />
            <h2 className="text-sm font-semibold text-gray-700">DTR Upload</h2>
          </div>
          <div className="space-y-4">
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <p className="text-sm font-medium text-gray-900">Enable DTR Upload Page</p>
                <p className="text-xs text-gray-500">Allows employees to upload their Daily Time Records.</p>
              </div>
              <button
                type="button"
                onClick={() => setDtrPageEnabled(!dtrPageEnabled)}
                className={`w-12 h-6 rounded-full flex items-center p-1 transition-colors ${dtrPageEnabled ? 'bg-brand-600' : 'bg-gray-300'}`}
              >
                <div className={`w-4 h-4 rounded-full bg-white transition-transform ${dtrPageEnabled ? 'translate-x-6' : ''}`} />
              </button>
            </div>

            <div className="p-4 border rounded-lg space-y-3">
              <div>
                <p className="text-sm font-medium text-gray-900">Upload Frequency</p>
                <p className="text-xs text-gray-500">Determines which cutoff periods employees see when uploading.</p>
              </div>
              <select
                value={dtrUploadFrequency}
                onChange={e => setDtrUploadFrequency(e.target.value)}
                className="input h-10"
              >
                <option value="semi_monthly">Semi-Monthly (two cutoffs per month)</option>
                <option value="monthly">Monthly</option>
              </select>

              {dtrUploadFrequency === 'semi_monthly' && (
                <div className="flex gap-4 pt-1">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">1st Cutoff Day</label>
                    <input
                      type="number"
                      min={1}
                      max={28}
                      value={dtrCutoff1Day}
                      onChange={e => setDtrCutoff1Day(parseInt(e.target.value) || 1)}
                      className="input h-10 w-24"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">2nd Cutoff Day</label>
                    <input
                      type="number"
                      min={1}
                      max={31}
                      value={dtrCutoff2Day}
                      onChange={e => setDtrCutoff2Day(parseInt(e.target.value) || 1)}
                      className="input h-10 w-24"
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <p className="text-sm font-medium text-gray-900">Per-Employee Restriction</p>
                <p className="text-xs text-gray-500">When enabled, DTR upload access can be toggled individually per employee (via DTR Management → Employee Access).</p>
              </div>
              <button
                type="button"
                onClick={() => setDtrPerEmployeeRestriction(!dtrPerEmployeeRestriction)}
                className={`w-12 h-6 rounded-full flex items-center p-1 transition-colors ${dtrPerEmployeeRestriction ? 'bg-brand-600' : 'bg-gray-300'}`}
              >
                <div className={`w-4 h-4 rounded-full bg-white transition-transform ${dtrPerEmployeeRestriction ? 'translate-x-6' : ''}`} />
              </button>
            </div>
          </div>
        </div>

        <div className="card p-6">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Attendance Automation</h2>
          <div className="space-y-4">
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <p className="text-sm font-medium text-gray-900">Enable Auto Clock-Out</p>
                <p className="text-xs text-gray-500">Automatically clock out employees who miss their shift end.</p>
              </div>
              <button
                type="button"
                onClick={() => setAutoClockOut(!autoClockOut)}
                className={`w-12 h-6 rounded-full flex items-center p-1 transition-colors ${autoClockOut ? 'bg-brand-600' : 'bg-gray-300'}`}
              >
                <div className={`w-4 h-4 rounded-full bg-white transition-transform ${autoClockOut ? 'translate-x-6' : ''}`} />
              </button>
            </div>

            <div className="p-4 border rounded-lg">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-gray-900">Absent Marking Time</p>
                  <p className="text-xs text-gray-500">Time when the system automatically marks unscheduled employees as absent.</p>
                </div>
                <div className="w-full sm:w-40">
                  <input
                    type="time"
                    value={absentMarkingTime}
                    onChange={(e) => setAbsentMarkingTime(e.target.value)}
                    className="input h-10"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="card overflow-hidden">
          <div className="border-b border-gray-100 bg-gray-50/50 px-6 py-5">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-brand-50 flex items-center justify-center text-brand-600">
                <MapPin size={20} />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-gray-900">Geolocation on Clock-In</h2>
                <p className="text-xs text-gray-500 mt-0.5">Capture where employees clock in from on selected days. Optionally enforce a workplace radius.</p>
              </div>
            </div>
          </div>
          <div className="p-6 space-y-4">
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <p className="text-sm font-medium text-gray-900">Enable Location Clock-In</p>
                <p className="text-xs text-gray-500">Master switch. When off, no clock-in ever asks for location and geofencing does nothing.</p>
              </div>
              <button
                type="button"
                onClick={() => setGeoCaptureEnabled(!geoCaptureEnabled)}
                className={`w-12 h-6 rounded-full flex items-center p-1 transition-colors ${geoCaptureEnabled ? 'bg-brand-600' : 'bg-gray-300'}`}
              >
                <div className={`w-4 h-4 rounded-full bg-white transition-transform ${geoCaptureEnabled ? 'translate-x-6' : ''}`} />
              </button>
            </div>

            {geoCaptureEnabled && (<>
            <div className="p-4 border rounded-lg space-y-3">
              <div>
                <p className="text-sm font-medium text-gray-900">Location Capture Days</p>
                <p className="text-xs text-gray-500">Clock-in asks for the employee's location on these days. On other days, employees clock in normally with no location prompt.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {WEEKDAYS.map(d => (
                  <button
                    key={d.iso}
                    type="button"
                    onClick={() => toggleCaptureDay(d.iso)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${captureDays.includes(d.iso) ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-gray-600 border-gray-200 hover:border-brand-400 hover:text-brand-600'}`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
              {captureDays.length === 0 && (
                <p className="text-[11px] text-amber-600">No days selected — location is never captured; all clock-ins proceed normally.</p>
              )}
            </div>

            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <p className="text-sm font-medium text-gray-900">Enforce Geofencing</p>
                <p className="text-xs text-gray-500">On capture days, restrict clock-in to a workplace radius. When off, location is still recorded but never blocks.</p>
              </div>
              <button
                type="button"
                onClick={() => setGeofenceEnabled(!geofenceEnabled)}
                className={`w-12 h-6 rounded-full flex items-center p-1 transition-colors ${geofenceEnabled ? 'bg-brand-600' : 'bg-gray-300'}`}
              >
                <div className={`w-4 h-4 rounded-full bg-white transition-transform ${geofenceEnabled ? 'translate-x-6' : ''}`} />
              </button>
            </div>

            {geofenceEnabled && (
              <>
                <div className="p-4 border rounded-lg space-y-3">
                  <div>
                    <p className="text-sm font-medium text-gray-900">Enforcement Mode</p>
                    <p className="text-xs text-gray-500">Enforce blocks out-of-range clock-ins. Warn allows them but records the location.</p>
                  </div>
                  <select value={geofenceMode} onChange={e => setGeofenceMode(e.target.value)} className="input h-10">
                    <option value="enforce">Enforce — block clock-in outside the radius</option>
                    <option value="warn">Warn — allow but record the location</option>
                  </select>
                </div>

                <div className="p-4 border rounded-lg space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-gray-900">Office Locations</p>
                      <p className="text-xs text-gray-500">Each zone has its own radius. A clock-in inside any zone is allowed.</p>
                    </div>
                    <button type="button" onClick={addOffice} className="btn-primary-soft text-[11px] px-3 py-1.5 flex items-center gap-1">
                      <Plus size={12} /> Add
                    </button>
                  </div>

                  {offices.length === 0 ? (
                    <p className="text-xs text-gray-400 italic py-2">No locations yet. Add one — enforce mode does nothing until at least one zone exists.</p>
                  ) : (
                    <div className="space-y-3">
                      {offices.map((o, i) => {
                        const latNum = Number(o.lat)
                        const lngNum = Number(o.lng)
                        const hasCoords = o.lat !== '' && o.lng !== '' && Number.isFinite(latNum) && Number.isFinite(lngNum)
                        return (
                          <div key={i} className="rounded-xl border border-gray-200 bg-gray-50/40 p-4 space-y-3">
                            <div className="flex items-center gap-2">
                              <input
                                className="input h-10 flex-1 font-medium"
                                placeholder="Location name (e.g. HQ)"
                                value={o.name ?? ''}
                                onChange={e => updateOffice(i, 'name', e.target.value)}
                              />
                              <button
                                type="button"
                                onClick={() => removeOffice(i)}
                                className="w-10 h-10 shrink-0 rounded-lg border border-gray-200 bg-white flex items-center justify-center text-gray-400 hover:text-red-600 hover:border-red-200 transition-colors"
                                title="Remove location"
                              >
                                <Trash2 size={15} />
                              </button>
                            </div>

                            <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
                              <div className="flex-1">
                                <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Latitude</label>
                                <input
                                  className="input h-10"
                                  type="text"
                                  inputMode="decimal"
                                  placeholder='14.5995  (or paste "lat, lng")'
                                  value={o.lat ?? ''}
                                  onChange={e => handleCoordInput(i, e.target.value)}
                                />
                              </div>
                              <div className="flex-1">
                                <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Longitude</label>
                                <input
                                  className="input h-10"
                                  type="text"
                                  inputMode="decimal"
                                  placeholder="120.9842"
                                  value={o.lng ?? ''}
                                  onChange={e => updateOffice(i, 'lng', e.target.value)}
                                />
                              </div>
                              <button
                                type="button"
                                onClick={() => useCurrentLocation(i)}
                                className="btn-secondary h-10 text-xs flex items-center justify-center gap-1.5 whitespace-nowrap"
                              >
                                <LocateFixed size={14} /> Use current
                              </button>
                            </div>

                            <div>
                              <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Radius</label>
                              <div className="flex flex-wrap items-center gap-2">
                                <div className="relative w-28">
                                  <input
                                    className="input h-10 pr-7"
                                    type="number"
                                    min="1"
                                    placeholder="200"
                                    value={o.radius_m ?? ''}
                                    onChange={e => updateOffice(i, 'radius_m', e.target.value)}
                                  />
                                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">m</span>
                                </div>
                                <div className="flex gap-1">
                                  {[100, 200, 500, 1000].map(r => (
                                    <button
                                      key={r}
                                      type="button"
                                      onClick={() => updateOffice(i, 'radius_m', r)}
                                      className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${Number(o.radius_m) === r ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-gray-600 border-gray-200 hover:border-brand-400 hover:text-brand-600'}`}
                                    >
                                      {r}m
                                    </button>
                                  ))}
                                </div>
                              </div>
                            </div>

                            {hasCoords && (
                              <div className="space-y-1.5">
                                <GeofenceMapPreview
                                  lat={latNum}
                                  lng={lngNum}
                                  zoom={15}
                                  radiusM={Number(o.radius_m) || 0}
                                  height={180}
                                />
                                <p className="text-[10px] text-gray-400 flex items-center gap-1.5">
                                  <span className="inline-block w-3 h-3 rounded-full" style={{ background: 'rgba(37,99,235,0.15)', border: '1.5px solid rgba(37,99,235,0.75)' }} />
                                  Blue circle shows the {Number(o.radius_m) || 0}m clock-in radius.
                                </p>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                  <p className="text-[10px] text-gray-400 italic">Tip: right-click a spot in Google Maps → click the “lat, lng” at the top to copy it → paste into the Latitude field. Requires HTTPS in production for device GPS.</p>
                </div>
              </>
            )}
            </>)}
          </div>
        </div>

        <div className="card">
          <div className="border-b border-gray-100 bg-gray-50/50 px-6 py-5">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-brand-50 flex items-center justify-center text-brand-600">
                <Palette size={20} />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-gray-900">Visual Theme Configuration</h2>
                <p className="text-xs text-gray-500 mt-0.5">Customize the main system color theme across the application.</p>
              </div>
            </div>
          </div>
          <div className="p-6">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
              {themePresets.map((preset) => {
                const isSelected = themeColor === preset.id
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => setThemeColor(preset.id)}
                    className={`flex flex-col items-center gap-3 p-4 rounded-xl border transition-all ${
                      isSelected
                        ? 'border-brand-500 bg-brand-50/20 ring-2 ring-brand-500/20'
                        : 'border-gray-200 hover:border-gray-300 bg-white'
                    }`}
                  >
                    <div className={`w-8 h-8 rounded-full ${preset.colorClass} shadow-inner flex items-center justify-center`}>
                      {isSelected && (
                        <div className="w-2.5 h-2.5 rounded-full bg-white" />
                      )}
                    </div>
                    <span className="text-xs font-medium text-gray-700">{preset.name}</span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="border-b border-gray-100 bg-gray-50/50 px-6 py-5">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center text-blue-600">
                <Calendar size={20} />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-gray-900">Statutory Contribution Tables</h2>
                <p className="text-xs text-gray-500 mt-0.5">Update the SSS and withholding tax tables to comply with new BIR regulations.</p>
              </div>
            </div>
          </div>
          <div className="p-6">
            <div className="space-y-6">
              <div className="flex flex-col gap-2">
                <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">SSS Employee Contribution Table (JSON)</label>
                <textarea
                  value={sssTable}
                  onChange={(e) => setSssTable(e.target.value)}
                  className="input font-mono text-xs h-64 p-4 leading-relaxed"
                  placeholder='[{"min": 0, "max": 5000, "ee": 250}, ...]'
                />
                <p className="text-[10px] text-gray-400 italic">
                  Required fields: "min", "max", "msc", "ee"
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">Withholding Tax Brackets — TRAIN Law (JSON)</label>
                <textarea
                  value={withholdingTable}
                  onChange={(e) => setWithholdingTable(e.target.value)}
                  className="input font-mono text-xs h-64 p-4 leading-relaxed"
                  placeholder='{"semi_monthly": [...], "monthly": [...]}'
                />
                <p className="text-[10px] text-gray-400 italic">
                  Object with "semi_monthly" and "monthly" arrays. Each bracket: &#123;"from", "to" (null for top), "fixed", "rate", "floor"&#125;. Update when BIR revises the TRAIN Law tables.
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="border-b border-gray-100 bg-gray-50/50 px-6 py-5">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-brand-50 flex items-center justify-center text-brand-600">
                <FileSpreadsheet size={20} />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-gray-900">Payroll Configuration</h2>
                <p className="text-xs text-gray-500 mt-0.5">Set payroll frequency and pay period cutoff days.</p>
              </div>
            </div>
          </div>
          <div className="p-6 space-y-6">
            {payrollFrequency !== (settings.find(s => s.key === 'payroll_frequency')?.value ?? 'semi_monthly') && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
                <strong>Note:</strong> Changing payroll frequency will only affect future payroll runs. Existing draft payrolls must be deleted and regenerated.
              </div>
            )}
            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-700">Payroll Frequency</label>
              <select value={payrollFrequency} onChange={(e) => setPayrollFrequency(e.target.value)} className="input h-11">
                <option value="semi_monthly">Semi-Monthly (twice a month)</option>
                <option value="monthly">Monthly (once a month)</option>
              </select>
            </div>
            {payrollFrequency === 'semi_monthly' ? (
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">Period 1 Start Day</label>
                    <input type="number" min="1" max="31" value={p1Start} onChange={(e) => setP1Start(parseInt(e.target.value))} className="input h-10" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">Period 1 End Day</label>
                    <input type="number" min="1" max="31" value={p1End} onChange={(e) => setP1End(parseInt(e.target.value))} className="input h-10" />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">Period 2 Start Day</label>
                    <input type="number" min="1" max="31" value={p2Start} onChange={(e) => setP2Start(parseInt(e.target.value))} className="input h-10" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">Period 2 End Day</label>
                    <input type="number" min="1" max="31" value={p2End} onChange={(e) => setP2End(parseInt(e.target.value))} className="input h-10" />
                  </div>
                </div>
                <p className="text-[10px] text-gray-400 italic">Use 31 to always mean the last day of the month.</p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">Period Start Day</label>
                    <input type="number" min="1" max="31" value={pMonthlyStart} onChange={(e) => setPMonthlyStart(parseInt(e.target.value))} className="input h-10" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">Period End Day</label>
                    <input type="number" min="1" max="31" value={pMonthlyEnd} onChange={(e) => setPMonthlyEnd(parseInt(e.target.value))} className="input h-10" />
                  </div>
                </div>
                <p className="text-[10px] text-gray-400 italic">Use 31 to always mean the last day of the month.</p>
              </div>
            )}
            <div className="rounded-lg border border-gray-100 overflow-hidden">
              <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-100">
                <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Preview — Next 3 Months</span>
              </div>
              <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50/50">
                    <th className="text-left px-4 py-2 font-medium text-gray-500">Period</th>
                    <th className="text-left px-4 py-2 font-medium text-gray-500">Start</th>
                    <th className="text-left px-4 py-2 font-medium text-gray-500">End</th>
                  </tr>
                </thead>
                <tbody>
                  {previewPeriods.map((row, i) => (
                    <tr key={i} className={`border-b border-gray-50 ${i % 2 === 0 ? '' : 'bg-gray-50/40'}`}>
                      <td className="px-4 py-2 text-gray-600">{row.period}</td>
                      <td className="px-4 py-2 text-gray-800 font-medium">{row.start}</td>
                      <td className="px-4 py-2 text-gray-800 font-medium">{row.end}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
          </div>
        </div>

        <div className="card overflow-hidden">
          <div className="border-b border-gray-100 bg-gray-50/50 px-6 py-5">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-brand-50 flex items-center justify-center text-brand-600">
                <Clock size={20} />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-gray-900">Date and Time Configuration</h2>
                <p className="text-xs text-gray-500 mt-0.5">Adjust the virtual system clock used for testing and simulations.</p>
              </div>
            </div>
          </div>

          <div className="p-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <FormField label="System Date" required>
                <div className="relative group">
                  <Calendar size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-brand-500 transition-colors" />
                  <input
                    type="date"
                    value={dateTime.date}
                    onChange={(e) => setDateTime(prev => ({ ...prev, date: e.target.value }))}
                    className="input pl-11 h-11"
                  />
                </div>
              </FormField>

              <FormField label="System Time" required>
                <div className="relative group">
                  <Clock size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-brand-500 transition-colors" />
                  <input
                    type="time"
                    step="1"
                    value={dateTime.time}
                    onChange={(e) => setDateTime(prev => ({ ...prev, time: e.target.value }))}
                    className="input pl-11 h-11"
                  />
                </div>
              </FormField>
            </div>
          </div>
        </div>

        <div className="card p-4 sticky bottom-4 z-20 shadow-lg border border-gray-200">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <button
              type="button"
              onClick={handleSetCurrent}
              className="btn-ghost text-brand-600 hover:bg-brand-50 flex items-center gap-2 px-4 py-2.5"
            >
              <Zap size={18} />
              <span className="font-semibold">Set Current Date/Time</span>
            </button>

            <div className="flex items-center gap-3 w-full sm:w-auto">
              {dirty && !updateSettingMutation.isPending && (
                <span className="text-xs italic text-amber-600 whitespace-nowrap">Unsaved changes</span>
              )}
              <button
                type="button"
                onClick={handleCancel}
                className="btn-secondary flex-1 sm:flex-none justify-center items-center gap-2 px-5 py-2.5"
              >
                <RotateCcw size={18} />
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={updateSettingMutation.isPending}
                className="btn-primary flex-1 sm:flex-none justify-center items-center gap-2 px-6 py-2.5"
              >
                {updateSettingMutation.isPending ? <Spinner size="sm" /> : <Save size={18} />}
                <span>{updateSettingMutation.isPending ? 'Saving...' : 'Save Settings'}</span>
              </button>
            </div>
          </div>
        </div>

        <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 flex gap-4">
          <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center shrink-0 text-amber-600">
            <Zap size={20} />
          </div>
          <div className="text-sm">
            <p className="font-semibold text-amber-900">Developer Note</p>
            <p className="text-amber-800 mt-1 leading-relaxed">
              These settings override the global system time for all attendance and payroll calculations. 
              Changing these values may result in data inconsistency if not handled carefully.
              ALWAYS use the "Set Current Date/Time" button to sync with real time AFTER making changes, to ensure all dependent data is recalculated correctly.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
