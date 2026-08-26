import ExcelJS from 'exceljs'
import { format, parseISO } from 'date-fns'
import { calculateHoursWorked } from './timeHelpers'

const DASH = '—'
export const UNASSIGNED = 'Unassigned'
const LAST_COL = 'K'
const STATUS_COL = 11
const HAIRLINE = { style: 'thin', color: { argb: 'FFE5E7EB' } }
const FONT = {
  title: { name: 'Calibri', size: 16, bold: true, color: { argb: 'FF111827' } },
  dept: { name: 'Calibri', size: 12, bold: true, color: { argb: 'FF374151' } },
  cutoff: { name: 'Calibri', size: 10, color: { argb: 'FF6B7280' } },
  header: { name: 'Calibri', size: 9, bold: true, color: { argb: 'FFFFFFFF' } },
  data: { name: 'Calibri', size: 10, color: { argb: 'FF111827' } },
  footer: { name: 'Calibri', size: 9, color: { argb: 'FF6B7280' } },
}

const STATUS_STYLES = {
  completed: { fill: 'FFDCFCE7', font: 'FF166534', label: 'Completed' },
  working: { fill: 'FFDCFCE7', font: 'FF166534', label: 'Working' },
  late: { fill: 'FFFEF9C3', font: 'FFA16207', label: 'Late' },
  absent: { fill: 'FFFEE2E2', font: 'FF991B1B', label: 'Absent' },
  undertime: { fill: 'FFFFEDD5', font: 'FFC2410C', label: 'Undertime' },
  half_day: { fill: 'FFFFEDD5', font: 'FFC2410C', label: 'Half Day' },
  overtime: { fill: 'FFF3E8FF', font: 'FF7E22CE', label: 'Overtime' },
  holiday: { fill: 'FFF3E8FF', font: 'FF7E22CE', label: 'Holiday' },
  on_leave: { fill: 'FFF3F4F6', font: 'FF4B5563', label: 'On Leave' },
  rest_day: { fill: 'FFDBEAFE', font: 'FF1E40AF', label: 'Rest Day' },
  not_scheduled: { fill: 'FFF3F4F6', font: 'FF4B5563', label: 'Not Scheduled' },
  not_yet: { fill: 'FFF3F4F6', font: 'FF4B5563', label: 'Not Yet' },
}

export const KNOWN_EXPORT_STATUSES = Object.keys(STATUS_STYLES)
export const KNOWN_EMPLOYEE_STATUSES = ['active', 'inactive']
export const DEFAULT_EMPLOYEE_STATUSES = ['active']

const STYLE_BY_LABEL = Object.fromEntries(
  Object.values(STATUS_STYLES).map((style) => [style.label, style]),
)

const HEADERS = ['DATE', 'EMPLOYEE ID', 'EMPLOYEE', 'EMPLOYEE STATUS', 'DEPARTMENT', 'GROUP', 'SCHEDULE', 'CLOCK IN', 'CLOCK OUT', 'HOURS', 'STATUS']
const WIDTHS = [14, 14, 26, 14, 18, 16, 22, 12, 12, 12, 14]
const CENTER_COLS = new Set([8, 9, 10])

function clockHm(value) {
  return value ? String(value).slice(0, 5) : DASH
}

function titleCaseFallback(status) {
  if (!status) return DASH
  return status.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
}

function bucketName(raw) {
  if (typeof raw !== 'string') return UNASSIGNED
  const trimmed = raw.trim()
  return trimmed || UNASSIGNED
}

function departmentName(employee) {
  return bucketName(employee?.department)
}

function groupName(employee) {
  return bucketName(employee?.group)
}

function employmentStatusKey(employee) {
  const raw = employee?.status
  if (typeof raw !== 'string') return ''
  return raw.trim()
}

export function exportStatusLabel(statusKey) {
  return STATUS_STYLES[statusKey]?.label ?? titleCaseFallback(statusKey)
}

export function exportEmployeeStatusLabel(statusKey) {
  if (!statusKey) return DASH
  return titleCaseFallback(statusKey)
}

export function toExportRow(log) {
  const employee = log.employee
  const statusKey = log.status
  return {
    date: format(parseISO(log.date), 'yyyy-MM-dd'),
    employeeId: employee?.employee_id ?? '',
    employeeName: `${employee?.first_name ?? ''} ${employee?.last_name ?? ''}`.trim(),
    employeeStatus: exportEmployeeStatusLabel(employmentStatusKey(employee)),
    department: departmentName(employee),
    group: groupName(employee),
    schedule: log.template_name || DASH,
    clockIn: clockHm(log.clock_in_time),
    clockOut: clockHm(log.clock_out_time),
    hours: calculateHoursWorked(log.clock_in_time, log.clock_out_time),
    status: STATUS_STYLES[statusKey]?.label ?? titleCaseFallback(statusKey),
  }
}

function orderedBuckets(map) {
  const names = [...map.keys()].filter((name) => name !== UNASSIGNED).sort((a, b) => a.localeCompare(b))
  if (map.has(UNASSIGNED)) names.push(UNASSIGNED)
  return names
}

export function discoverExportOptions(logs) {
  const departments = new Set()
  const groups = new Set()
  const statuses = new Set()
  const employeeStatuses = new Set()
  for (const log of logs ?? []) {
    departments.add(departmentName(log.employee))
    groups.add(groupName(log.employee))
    if (log.status) statuses.add(log.status)
    const empStatus = employmentStatusKey(log.employee)
    if (empStatus) employeeStatuses.add(empStatus)
  }
  return {
    departments: orderedBuckets(new Map([...departments].map((d) => [d, true]))),
    groups: orderedBuckets(new Map([...groups].map((g) => [g, true]))),
    statuses: [...statuses].sort((a, b) => exportStatusLabel(a).localeCompare(exportStatusLabel(b))),
    employeeStatuses: [...employeeStatuses].sort((a, b) =>
      exportEmployeeStatusLabel(a).localeCompare(exportEmployeeStatusLabel(b)),
    ),
  }
}

export function unionBucketOptions(discovered, masterNames = []) {
  const set = new Set([UNASSIGNED, ...masterNames, ...discovered])
  return orderedBuckets(new Map([...set].map((name) => [name, true])))
}

export function unionStatusOptions(discovered) {
  const set = new Set([...KNOWN_EXPORT_STATUSES, ...discovered])
  return [...set].sort((a, b) => exportStatusLabel(a).localeCompare(exportStatusLabel(b)))
}

export function unionEmployeeStatusOptions(discovered = []) {
  const set = new Set([...KNOWN_EMPLOYEE_STATUSES, ...discovered])
  return [...set].sort((a, b) =>
    exportEmployeeStatusLabel(a).localeCompare(exportEmployeeStatusLabel(b)),
  )
}

export function applyExportFilters(logs, config) {
  return (logs ?? []).filter((log) => {
    const dept = departmentName(log.employee)
    const group = groupName(log.employee)
    const status = log.status
    const employeeStatus = employmentStatusKey(log.employee)
    if (config.departments.length && !config.departments.includes(dept)) return false
    if (config.groups.length && !config.groups.includes(group)) return false
    if (config.statuses.length && !config.statuses.includes(status)) return false
    if (config.employeeStatuses.length && !config.employeeStatuses.includes(employeeStatus)) return false
    return true
  })
}

export function groupByDepartment(logs) {
  const map = new Map()
  for (const log of logs) {
    const row = toExportRow(log)
    const rows = map.get(row.department)
    if (rows) rows.push(row)
    else map.set(row.department, [row])
  }
  return map
}

export function groupByGroup(logs) {
  const map = new Map()
  for (const log of logs) {
    const row = toExportRow(log)
    const rows = map.get(row.group)
    if (rows) rows.push(row)
    else map.set(row.group, [row])
  }
  return map
}

function sortRows(rows) {
  return [...rows].sort((a, b) => {
    const byName = a.employeeName.localeCompare(b.employeeName)
    if (byName !== 0) return byName
    return a.date.localeCompare(b.date)
  })
}

function uniqueSheetName(name, used) {
  const cleaned = String(name).replace(/[:\\/?*[\]]/g, '').trim()
  const base = cleaned || 'Sheet'
  let sheetName = base.substring(0, 31)
  if (used.has(sheetName)) {
    let counter = 2
    do {
      const suffix = ` (${counter})`
      sheetName = base.substring(0, 31 - suffix.length) + suffix
      counter++
    } while (used.has(sheetName))
  }
  used.add(sheetName)
  return sheetName
}

function cutoffCaption(meta) {
  if (meta?.label) return meta.label
  const start = meta?.startDate ? format(parseISO(meta.startDate), 'MMM dd, yyyy') : ''
  const end = meta?.endDate ? format(parseISO(meta.endDate), 'MMM dd, yyyy') : ''
  if (start && end) return `${start}  –  ${end}`
  return start || end
}

function solidFill(argb) {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } }
}

function paintCell(cell, { value, align, font, fill, top }) {
  cell.value = value
  cell.font = font
  cell.alignment = { vertical: 'middle', horizontal: align }
  if (fill) cell.fill = solidFill(fill)
  cell.border = {
    top: { style: 'thin', color: { argb: top } },
    left: HAIRLINE,
    bottom: HAIRLINE,
    right: HAIRLINE,
  }
}

function writeSheet(workbook, sheetName, subtitle, rows, meta) {
  const ws = workbook.addWorksheet(sheetName)
  WIDTHS.forEach((width, i) => {
    ws.getColumn(i + 1).width = width
  })

  ws.mergeCells(`A1:${LAST_COL}1`)
  ws.getCell('A1').value = 'Attendance Logs'
  ws.getCell('A1').font = FONT.title

  ws.mergeCells(`A2:${LAST_COL}2`)
  ws.getCell('A2').value = subtitle
  ws.getCell('A2').font = FONT.dept

  ws.mergeCells(`A3:${LAST_COL}3`)
  ws.getCell('A3').value = cutoffCaption(meta)
  ws.getCell('A3').font = FONT.cutoff

  ws.getRow(4).height = 8

  const headerRow = ws.getRow(5)
  headerRow.height = 18
  HEADERS.forEach((label, i) => {
    const cell = headerRow.getCell(i + 1)
    paintCell(cell, {
      value: label,
      align: CENTER_COLS.has(i + 1) ? 'center' : 'left',
      font: FONT.header,
      fill: 'FF1F2937',
      top: 'FFE5E7EB',
    })
  })

  rows.forEach((row, idx) => {
    const excelRow = ws.getRow(6 + idx)
    const zebra = idx % 2 === 1
    const isBreak = idx > 0 && row.employeeName !== rows[idx - 1].employeeName
    const top = isBreak ? 'FF9CA3AF' : 'FFE5E7EB'
    const style = STYLE_BY_LABEL[row.status]
    const values = [
      row.date,
      row.employeeId,
      row.employeeName,
      row.employeeStatus,
      row.department,
      row.group,
      row.schedule,
      row.clockIn,
      row.clockOut,
      row.hours,
      row.status,
    ]
    values.forEach((value, i) => {
      const col = i + 1
      const isStatus = col === STATUS_COL
      let fill
      let font = FONT.data
      if (isStatus && style) {
        fill = style.fill
        font = { name: 'Calibri', size: 10, color: { argb: style.font } }
      } else if (!isStatus && zebra) {
        fill = 'FFF9FAFB'
      }
      paintCell(excelRow.getCell(col), {
        value,
        align: CENTER_COLS.has(col) ? 'center' : 'left',
        font,
        fill,
        top,
      })
    })
  })

  const lastDataRow = 5 + rows.length
  ws.autoFilter = { from: 'A5', to: `${LAST_COL}${lastDataRow}` }
  ws.views = [{ state: 'frozen', ySplit: 5 }]
  ws.pageSetup = {
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5, header: 0.5, footer: 0.5 },
    printTitlesRow: '1:5',
  }

  const footerRow = lastDataRow + 2
  ws.mergeCells(`A${footerRow}:${LAST_COL}${footerRow}`)
  const nEmployees = new Set(rows.map((r) => r.employeeId || r.employeeName)).size
  const footer = ws.getCell(`A${footerRow}`)
  footer.value = `${nEmployees} employees  ·  ${rows.length} rows`
  footer.font = FONT.footer
}

export async function buildAttendanceWorkbook(logs, config, meta) {
  const filtered = applyExportFilters(logs, config)
  const workbook = new ExcelJS.Workbook()
  const used = new Set()

  if (config.sheetLayout === 'combined') {
    writeSheet(
      workbook,
      uniqueSheetName('Attendance Logs', used),
      'Combined',
      sortRows(filtered.map(toExportRow)),
      meta,
    )
    return workbook
  }

  const grouped = config.splitBy === 'group' ? groupByGroup(filtered) : groupByDepartment(filtered)
  for (const bucket of orderedBuckets(grouped)) {
    writeSheet(
      workbook,
      uniqueSheetName(bucket, used),
      bucket,
      sortRows(grouped.get(bucket)),
      meta,
    )
  }
  return workbook
}

export async function downloadAttendanceWorkbook(logs, config, meta) {
  const filtered = applyExportFilters(logs, config)
  if (!filtered.length) return
  const workbook = await buildAttendanceWorkbook(logs, config, meta)
  const buffer = await workbook.xlsx.writeBuffer()
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `attendance-logs-${meta.startDate}-to-${meta.endDate}.xlsx`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  window.URL.revokeObjectURL(url)
}
