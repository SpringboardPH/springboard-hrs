import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { format, parseISO } from 'date-fns'
import clsx from 'clsx'
import {
  attendanceKeys,
  departmentKeys,
  employeeKeys,
  getAttendance,
  getDepartments,
  getEmployeeGroups,
} from '../../api/queries'
import { Modal, FormField, Spinner, MultiSelectCombobox } from '../ui/index.jsx'
import {
  applyExportFilters,
  discoverExportOptions,
  downloadAttendanceWorkbook,
  exportEmployeeStatusLabel,
  exportStatusLabel,
  unionBucketOptions,
  unionEmployeeStatusOptions,
  unionStatusOptions,
  DEFAULT_EMPLOYEE_STATUSES,
} from '../../utils/attendanceExport'

function emptyConfig(startDate, endDate) {
  return {
    startDate,
    endDate,
    departments: [],
    groups: [],
    employeeStatuses: [],
    statuses: [],
    splitBy: 'department',
    sheetLayout: 'split',
  }
}

function cutoffLabel(startDate, endDate, label) {
  if (label) return label
  if (!startDate || !endDate) return ''
  try {
    return `${format(parseISO(startDate), 'MMM dd, yyyy')}  –  ${format(parseISO(endDate), 'MMM dd, yyyy')}`
  } catch {
    return `${startDate} – ${endDate}`
  }
}

function rangesEqual(a, b) {
  return !!a && !!b && a.startDate === b.startDate && a.endDate === b.endDate
}

export default function AttendanceExportModal({ open, onClose, defaultCutoff }) {
  const [config, setConfig] = useState(() => emptyConfig(defaultCutoff?.startDate ?? '', defaultCutoff?.endDate ?? ''))
  const [loadedRange, setLoadedRange] = useState(null)
  const [logs, setLogs] = useState([])
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState('')

  useEffect(() => {
    if (!open) return
    setConfig(emptyConfig(defaultCutoff?.startDate ?? '', defaultCutoff?.endDate ?? ''))
    setLoadedRange(null)
    setLogs([])
    setDownloadError('')
  }, [open, defaultCutoff?.startDate, defaultCutoff?.endDate])

  const { data: departments = [] } = useQuery({
    queryKey: departmentKeys.all,
    queryFn: getDepartments,
    enabled: open,
  })

  const { data: employeeGroups = [] } = useQuery({
    queryKey: employeeKeys.groups,
    queryFn: getEmployeeGroups,
    enabled: open,
  })

  const datesValid = !!config.startDate && !!config.endDate && config.startDate <= config.endDate
  const dateInvalid = !!config.startDate && !!config.endDate && config.startDate > config.endDate
  const draftRange = datesValid ? { startDate: config.startDate, endDate: config.endDate } : null
  const isStale = !rangesEqual(loadedRange, draftRange)

  const { refetch, isFetching } = useQuery({
    queryKey: attendanceKeys.exportPreview(config.startDate, config.endDate),
    queryFn: () => getAttendance({
      start_date: config.startDate,
      end_date: config.endDate,
      include_absentees: true,
      personal: false,
    }),
    enabled: false,
  })

  const discovered = useMemo(() => discoverExportOptions(logs), [logs])

  const activeDeptNames = useMemo(
    () => departments.filter((d) => !d.deleted_at).map((d) => d.name),
    [departments],
  )

  const deptOptions = useMemo(
    () => unionBucketOptions(discovered.departments, activeDeptNames),
    [discovered.departments, activeDeptNames],
  )

  const groupOptions = useMemo(
    () => unionBucketOptions(discovered.groups, employeeGroups),
    [discovered.groups, employeeGroups],
  )

  const statusOptions = useMemo(
    () => unionStatusOptions(discovered.statuses),
    [discovered.statuses],
  )

  const employeeStatusOptions = useMemo(
    () => unionEmployeeStatusOptions(discovered.employeeStatuses),
    [discovered.employeeStatuses],
  )

  useEffect(() => {
    if (!open || loadedRange) return
    setConfig((prev) => ({
      ...prev,
      departments: deptOptions,
      groups: groupOptions,
      employeeStatuses: DEFAULT_EMPLOYEE_STATUSES,
      statuses: statusOptions,
    }))
  }, [open, loadedRange, deptOptions, groupOptions, statusOptions])

  const matchCount = useMemo(
    () => (isStale ? null : applyExportFilters(logs, config).length),
    [isStale, logs, config],
  )

  const busy = isFetching || downloading
  const canDownload = datesValid && !dateInvalid && !busy

  async function fetchLogsForDraft() {
    const result = await refetch()
    if (result.error) return null
    return result.data?.data ?? []
  }

  async function handleLoad() {
    if (!datesValid || isFetching) return
    setDownloadError('')
    const nextLogs = await fetchLogsForDraft()
    if (nextLogs == null) return
    const nextDiscovered = discoverExportOptions(nextLogs)
    setLogs(nextLogs)
    setLoadedRange({ startDate: config.startDate, endDate: config.endDate })
    setConfig((prev) => ({
      ...prev,
      departments: unionBucketOptions(nextDiscovered.departments, activeDeptNames),
      groups: unionBucketOptions(nextDiscovered.groups, employeeGroups),
      employeeStatuses: DEFAULT_EMPLOYEE_STATUSES,
      statuses: unionStatusOptions(nextDiscovered.statuses),
    }))
  }

  async function handleDownload() {
    if (!canDownload) return
    setDownloading(true)
    setDownloadError('')
    try {
      let exportLogs = logs
      let exportConfig = config

      if (isStale) {
        const nextLogs = await fetchLogsForDraft()
        if (nextLogs == null) {
          setDownloadError('Could not load attendance logs.')
          return
        }
        exportLogs = nextLogs
        const nextDiscovered = discoverExportOptions(nextLogs)
        exportConfig = {
          ...config,
          departments: config.departments.length
            ? config.departments
            : unionBucketOptions(nextDiscovered.departments, activeDeptNames),
          groups: config.groups.length
            ? config.groups
            : unionBucketOptions(nextDiscovered.groups, employeeGroups),
          employeeStatuses: config.employeeStatuses.length
            ? config.employeeStatuses
            : DEFAULT_EMPLOYEE_STATUSES,
          statuses: config.statuses.length
            ? config.statuses
            : unionStatusOptions(nextDiscovered.statuses),
        }
        setLogs(nextLogs)
        setLoadedRange({ startDate: config.startDate, endDate: config.endDate })
        setConfig(exportConfig)
      }

      const matched = applyExportFilters(exportLogs, exportConfig)
      if (!matched.length) {
        setDownloadError('No rows match the current filters.')
        return
      }

      await downloadAttendanceWorkbook(exportLogs, exportConfig, {
        startDate: config.startDate,
        endDate: config.endDate,
        label: cutoffLabel(config.startDate, config.endDate, defaultCutoff?.label),
      })
      onClose()
    } finally {
      setDownloading(false)
    }
  }

  const splitLabel = config.splitBy === 'group' ? 'group' : 'department'

  let statusText
  if (dateInvalid) statusText = 'Fix the date range to continue.'
  else if (downloadError) statusText = downloadError
  else if (busy) statusText = downloading ? 'Preparing download…' : 'Loading logs…'
  else if (matchCount == null) statusText = 'Load to preview, or Download now.'
  else statusText = `${matchCount} row${matchCount === 1 ? '' : 's'} match`

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Export Attendance Logs"
      size="lg"
      footer={(
        <div className="flex items-center justify-between gap-3">
          <p className={clsx(
            'text-xs min-h-[1rem] truncate flex-1',
            downloadError || dateInvalid ? 'text-amber-600' : 'text-gray-500',
          )}
          >
            {statusText}
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <button type="button" className="btn-secondary text-sm" onClick={onClose} disabled={downloading}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary text-sm inline-flex items-center gap-2 min-w-[6.5rem] justify-center"
              disabled={!canDownload}
              onClick={handleDownload}
            >
              {downloading && <Spinner size="sm" />}
              Download
            </button>
          </div>
        </div>
      )}
    >
      <div className="space-y-4 min-h-[28rem]">
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3 items-end">
          <FormField label="Start date" required>
            <input
              type="date"
              className="input text-sm"
              value={config.startDate}
              onChange={(e) => {
                setDownloadError('')
                setConfig((prev) => ({ ...prev, startDate: e.target.value }))
              }}
            />
          </FormField>
          <FormField label="End date" required>
            <input
              type="date"
              className="input text-sm"
              value={config.endDate}
              onChange={(e) => {
                setDownloadError('')
                setConfig((prev) => ({ ...prev, endDate: e.target.value }))
              }}
            />
          </FormField>
          <button
            type="button"
            className="inline-flex items-center justify-center gap-2 h-10 min-w-[5.75rem] px-4 rounded-lg text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
            disabled={!datesValid || isFetching || downloading}
            onClick={handleLoad}
          >
            {isFetching ? (
              <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : null}
            Load
          </button>
        </div>
        <p className={clsx('text-xs min-h-[1rem]', dateInvalid ? 'text-red-500' : 'invisible')}>
          End date must be on or after the start date.
        </p>

        <FormField label="Departments">
          <MultiSelectCombobox
            options={deptOptions}
            value={config.departments}
            onChange={(departments) => setConfig((prev) => ({ ...prev, departments }))}
            placeholder="Select departments…"
            disabled={busy}
          />
        </FormField>
        <FormField label="Groups">
          <MultiSelectCombobox
            options={groupOptions}
            value={config.groups}
            onChange={(groups) => setConfig((prev) => ({ ...prev, groups }))}
            placeholder="Select groups…"
            disabled={busy}
          />
        </FormField>
        <FormField label="Employee status">
          <MultiSelectCombobox
            options={employeeStatusOptions}
            value={config.employeeStatuses}
            onChange={(employeeStatuses) => setConfig((prev) => ({ ...prev, employeeStatuses }))}
            getLabel={exportEmployeeStatusLabel}
            placeholder="Select employee status…"
            disabled={busy}
          />
        </FormField>
        <FormField label="Statuses">
          <MultiSelectCombobox
            options={statusOptions}
            value={config.statuses}
            onChange={(statuses) => setConfig((prev) => ({ ...prev, statuses }))}
            getLabel={exportStatusLabel}
            placeholder="Select statuses…"
            disabled={busy}
          />
        </FormField>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
          <FormField label="Sheets by">
            <div className="space-y-2">
              {[
                { value: 'department', label: 'Department' },
                { value: 'group', label: 'Group' },
              ].map(({ value, label }) => (
                <label key={value} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                  <input
                    type="radio"
                    name="splitBy"
                    className="border-gray-300 text-brand-600 focus:ring-brand-600"
                    checked={config.splitBy === value}
                    onChange={() => setConfig((prev) => ({ ...prev, splitBy: value }))}
                  />
                  {label}
                </label>
              ))}
            </div>
          </FormField>

          <FormField label="Sheet layout">
            <div className="space-y-2">
              {[
                { value: 'split', label: `One sheet per ${splitLabel}` },
                { value: 'combined', label: 'One combined sheet' },
              ].map(({ value, label }) => (
                <label key={value} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                  <input
                    type="radio"
                    name="sheetLayout"
                    className="border-gray-300 text-brand-600 focus:ring-brand-600"
                    checked={config.sheetLayout === value}
                    onChange={() => setConfig((prev) => ({ ...prev, sheetLayout: value }))}
                  />
                  {label}
                </label>
              ))}
            </div>
          </FormField>
        </div>

        <p className="text-xs text-gray-500">
          Load is optional and previews matching rows. Download fetches the selected range if needed.
        </p>
      </div>
    </Modal>
  )
}
