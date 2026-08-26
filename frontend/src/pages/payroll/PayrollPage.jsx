import { useState, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { format, parseISO } from 'date-fns'
import {
  getPayrolls, generatePayroll, updatePayroll, payrollKeys,
  getSystemClock, systemClockKeys, sendPaystubs, revertPayrollToDraft, togglePayrollUndertimeCalculation, getAdminSettings, adminSettingsKeys,
  getEmployeeGroups, employeeKeys, loanKeys
} from '../../api/queries'
import { PageHeader, PageSpinner, StatusBadge, Modal, Spinner, AlertModal } from '../../components/ui/index.jsx'
import { Plus, Banknote, Calendar, ChevronLeft, ChevronRight, FileDown, CheckCircle, Download, Mail } from 'lucide-react'
import { getCutoffPeriod, getNextCutoff, getPrevCutoff } from '../../utils/attendance'
import ExcelJS from 'exceljs'

// Earnings with their own dedicated payslip rows (G27–G34)
const DEDICATED_EARNINGS = ['Overtime Pay', 'Rest Day Pay', 'Rest Day OT Pay', 'Night Differential', 'Special Holiday', 'Legal Holiday', '13th Month Pay']
// Predefined allowances that roll into the "Allowances" line (G35)
const ALLOWANCE_LABELS = ['Bonus', 'Travel Allowance', 'Allowance']

// Splits allowances into the G35 "Allowances" total and the individual custom
// "Other" earning items. Anything that isn't a dedicated earning or a predefined
// allowance is a custom "Other" field (rendered as its own payslip line).
function splitAllowanceLines(allowances) {
  const list = Array.isArray(allowances)
    ? allowances
    : Object.entries(allowances || {}).map(([label, amount]) => ({ label, amount }))
  let allowancesAmt = 0
  const others = []
  for (const a of list) {
    const label = (a?.label || '').trim()
    const amt = Number(a?.amount || 0)
    if (!label || DEDICATED_EARNINGS.includes(label) || label === 'Incentives/Others') continue
    if (ALLOWANCE_LABELS.includes(label)) { allowancesAmt += amt; continue }
    others.push({ label, amt }) // custom-typed "Other" field
  }
  return { allowancesAmt, others }
}

// Deductions with their own dedicated payslip rows (O27–O35). Everything else
// (cash-advance repayments + any custom-typed deduction) is an "Other" deduction
// that currently lumps into the single O36 total — we itemize these.
const DEDICATED_DEDUCTIONS = ['Late', 'Undertime', 'Absent', 'Half Day', 'SSS EE Contribution', 'PhilHealth EE Contribution', 'Pag-IBIG EE Contribution', 'SSS Loan', 'Pag-IBIG Loan', 'Withholding Tax']

// Custom-typed "Other" fields have editable labels; standard fields (Absent, SSS,
// Cash Advance, etc.) show a fixed label — only their amount is editable. A blank
// label means a freshly added custom field, so it stays editable.
const isCustomEarning = (label) => !DEDICATED_EARNINGS.includes(label) && !ALLOWANCE_LABELS.includes(label) && label !== 'Incentives/Others'
const isCustomDeduction = (label) => !DEDICATED_DEDUCTIONS.includes(label) && label !== 'Cash Advance/Others'

// Individual "Other" deduction items for the J36/O36 "Cash Advance / Others" line.
function splitDeductionLines(deductions) {
  const list = Array.isArray(deductions)
    ? deductions
    : Object.entries(deductions || {}).map(([label, amount]) => ({ label, amount }))
  const others = []
  for (const d of list) {
    const label = (d?.label || '').trim()
    const amt = Number(d?.amount || 0)
    if (!label || DEDICATED_DEDUCTIONS.includes(label)) continue
    others.push({ label: label === 'Cash Advance/Others' ? 'Cash Advance' : label, amt })
  }
  return { others }
}

// Row 36 is the static "Others" header line (C36 earnings side, J36 deductions
// side, both set in the template). When either side has custom items, list each
// one on its own row inserted directly below — earnings in C/G, deductions in
// J/O, aligned row-by-row. Item rows are cloned from row 35 (the "Allowances" /
// loan line), a normal split label+amount row — NOT the header row 36, which the
// template merges full-width. ExcelJS's spliceRows mishandles merged cells on
// shift, so we clear all merges first, let it move values/styles cleanly, then
// rebuild every merge at its shifted position and add the item-row merges.
const OTHERS_ROW = 36
const ITEM_STYLE_ROW = OTHERS_ROW - 1 // row 35: a normal split label+amount line
const CURRENCY_FMT = '"₱"#,##0.00;-"₱"#,##0.00'
// Merge groups on an item row: label spans right up to the amount (C:F earnings,
// J:N deductions) so there's no gap between particulars and amount — matching the
// total rows. Amount cells: G:H earnings, O:P deductions.
const OTHERS_MERGE_GROUPS = [[3, 6], [7, 8], [10, 14], [15, 16]]
function insertOthersBreakdown(worksheet, earningsOthers, deductionOthers) {
  const eN = earningsOthers?.length || 0
  const dN = deductionOthers?.length || 0
  const n = Math.max(eN, dN)
  if (n === 0) return

  const merges = Object.values(worksheet._merges || {}).map(m => ({ top: m.top, left: m.left, bottom: m.bottom, right: m.right }))
  merges.forEach(m => worksheet.unMergeCells(m.top, m.left, m.bottom, m.right))
  worksheet.spliceRows(OTHERS_ROW + 1, 0, ...Array(n).fill([]))
  // Merges below the insertion point shift down by n; those above stay put.
  merges.forEach(m => {
    const shift = m.top > OTHERS_ROW ? n : 0
    try { worksheet.mergeCells(m.top + shift, m.left, m.bottom + shift, m.right) } catch (_) { /* noop */ }
  })

  const srcRow = worksheet.getRow(ITEM_STYLE_ROW)
  const setItem = (destRow, labelCol, amtCol, item) => {
    destRow.getCell(labelCol).value = `   ${item.label}`
    const amt = destRow.getCell(amtCol)
    amt.value = Number(item.amt) || 0
    amt.numFmt = CURRENCY_FMT
  }
  for (let k = 0; k < n; k++) {
    const r = OTHERS_ROW + 1 + k
    const destRow = worksheet.getRow(r)
    if (srcRow.height) destRow.height = srcRow.height
    srcRow.eachCell({ includeEmpty: true }, (cell, col) => {
      if (cell.style) destRow.getCell(col).style = JSON.parse(JSON.stringify(cell.style))
    })
    OTHERS_MERGE_GROUPS.forEach(([c1, c2]) => {
      try { worksheet.mergeCells(r, c1, r, c2) } catch (_) { /* already merged */ }
    })
    if (k < eN) setItem(destRow, 3, 7, earningsOthers[k])   // C label, G amount
    if (k < dN) setItem(destRow, 10, 15, deductionOthers[k]) // J label, O amount
  }
}

export default function PayrollPage() {
  const [navigatedCutoff, setNavigatedCutoff] = useState(() => {
    try { return JSON.parse(localStorage.getItem('payroll_last_cutoff')) } catch { return null }
  })
  const [selectedPayroll, setSelectedPayroll] = useState(null)
  const [isEditing, setIsEditing] = useState(false)
  const [showBreakdown, setShowBreakdown] = useState(false)
  const [editForm, setEditForm] = useState(null)
  const [showEmailModal, setShowEmailModal] = useState(false)
  const [selectedPaystubs, setSelectedPaystubs] = useState(new Set())
  const [ccEmails, setCcEmails] = useState([])
  const [bccEmails, setBccEmails] = useState([])
  const [ccInput, setCcInput] = useState('')
  const [bccInput, setBccInput] = useState('')
  const [ccHistory, setCcHistory] = useState(JSON.parse(localStorage.getItem('payroll_cc_history') || '[]'))
  const [bccHistory, setBccHistory] = useState(JSON.parse(localStorage.getItem('payroll_bcc_history') || '[]'))
  const [showToggleConfirm, setShowToggleConfirm] = useState(false)
  const [toggleSuccess, setToggleSuccess] = useState(null)
  const [alert, setAlert] = useState(null)
  const [groupFilter, setGroupFilter] = useState('')
  const qc = useQueryClient()

  const { data: sysClock } = useQuery({
    queryKey: systemClockKeys.all,
    queryFn: getSystemClock,
  })

  const { data: adminSettings = null } = useQuery({
    queryKey: adminSettingsKeys.all,
    queryFn: getAdminSettings,
  })

  const { data: payrollGroups = [] } = useQuery({
    queryKey: employeeKeys.groups,
    queryFn: getEmployeeGroups,
  })

  const currentCutoff = navigatedCutoff || getCutoffPeriod(sysClock?.date || new Date(), adminSettings)

  const payPeriods = useMemo(() => {
    if (!Array.isArray(adminSettings)) return 2
    return adminSettings.find(s => s.key === 'payroll_frequency')?.value === 'monthly' ? 1 : 2
  }, [adminSettings])

  const { data: payrolls = [], isLoading } = useQuery({
    queryKey: payrollKeys.list({
      cutoff_start: currentCutoff.startDate,
      cutoff_end: currentCutoff.endDate,
      group: groupFilter || undefined,
    }),
    queryFn: () => getPayrolls({
      cutoff_start: currentCutoff.startDate,
      cutoff_end: currentCutoff.endDate,
      ...(groupFilter && { group: groupFilter }),
    }),
    enabled: !!currentCutoff,
  })

  const generateMutation = useMutation({
    mutationFn: generatePayroll,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: payrollKeys.all })
      qc.invalidateQueries({ queryKey: loanKeys.all })
      // Refresh selectedPayroll if it was part of this generation
      if (selectedPayroll && Array.isArray(data?.data)) {
        const updated = data.data.find(p => p.id === selectedPayroll.id)
        if (updated) setSelectedPayroll(updated)
      }
    },
  })

  const updateStatusMutation = useMutation({
    mutationFn: ({ id, ...data }) => updatePayroll(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: payrollKeys.all })
      setSelectedPayroll(null)
      setIsEditing(false)
    },
    onError: (error) => {
      const message = error?.response?.data?.message || 'Failed to update payroll. Please try again.'
      setAlert({ type: 'error', message })
    }
  })

  const revertToDraftMutation = useMutation({
    mutationFn: (payrollId) => revertPayrollToDraft(payrollId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: payrollKeys.all })
      setSelectedPayroll(null)
      setIsEditing(false)
    },
    onError: (error) => {
      const message = error?.response?.data?.message || 'Failed to revert payroll. Please try again.'
      setAlert({ type: 'error', message })
    }
  })

  const toggleUndertimeMutation = useMutation({
    mutationFn: (payrollId) => togglePayrollUndertimeCalculation(payrollId),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: payrollKeys.all })
      setSelectedPayroll(data.data)
      setShowToggleConfirm(false)
      setToggleSuccess(data)
    },
    onError: (error) => {
      const message = error?.response?.data?.message || 'Failed to toggle undertime calculation. Please try again.'
      setAlert({ type: 'error', message })
    }
  })

  const sendPaystubsMutation = useMutation({
    mutationFn: (payrollIds) => sendPaystubs(payrollIds),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: payrollKeys.all })
      setShowEmailModal(false)
      setSelectedPaystubs(new Set())
      setCcEmails([])
      setBccEmails([])
      setCcInput('')
      setBccInput('')
      
      const message = data.message || 'Paystubs sent successfully!'
      setAlert({ type: 'success', message })
      
      if (data.data?.failed?.length > 0) {
        console.error('Failed to send paystubs:', data.data.failed)
      }
    },
    onError: (error) => {
      const message = error?.response?.data?.message || 'Failed to send paystubs. Please try again.'
      setAlert({ type: 'error', message })
    }
  })

  const handleEditInit = () => {
    const dRate = Number(selectedPayroll.daily_rate || 0)
    const dList = Array.isArray(selectedPayroll.deductions)
      ? selectedPayroll.deductions
      : Object.entries(selectedPayroll.deductions || {}).map(([k, v]) => ({ label: k, amount: v }))
    
    const absentItem = dList.find(d => d.label === 'Absent')
    const initialAbsentDays = absentItem && dRate > 0 ? Number(absentItem.amount) / dRate : 0
    
    setEditForm({
      ...selectedPayroll,
      allowances: Array.isArray(selectedPayroll.allowances) 
        ? selectedPayroll.allowances 
        : Object.entries(selectedPayroll.allowances || {}).map(([k, v]) => ({ label: k, amount: v })),
      deductions: dList,
      absent_days: initialAbsentDays
    })
    setIsEditing(true)
  }

  const handleAddField = (type, label = '') => {
    setEditForm(prev => ({
      ...prev,
      [type]: [...prev[type], { label, amount: 0 }]
    }))
  }

  const handleRemoveField = (type, index) => {
    setEditForm(prev => {
      const next = {
        ...prev,
        allowances: (prev.allowances || []).map(a => ({ ...a })),
        deductions: (prev.deductions || []).map(d => ({ ...d })),
      }
      next[type] = next[type].filter((_, i) => i !== index)
      const isDaily = next.employee?.rate_type === 'daily'
      const baseGross = isDaily
        ? (Number(next.base_salary) * Number(next.days_worked || 0))
        : (Number(next.base_salary) / payPeriods)
      const totalAllowances = next.allowances.reduce((s, a) => s + Number(a.amount || 0), 0)
      const totalDeductions = next.deductions.reduce((s, d) => s + Number(d.amount || 0), 0)
      next.gross_pay = baseGross + totalAllowances
      next.net_pay = next.gross_pay - totalDeductions
      return next
    })
  }

  const handleFieldChange = (type, index, field, value) => {
    setEditForm(prev => {
      // 1. Deep clone top-level and arrays to avoid mutation
      const next = { 
        ...prev,
        allowances: Array.isArray(prev.allowances) ? prev.allowances.map(a => ({ ...a })) : [],
        deductions: Array.isArray(prev.deductions) ? prev.deductions.map(d => ({ ...d })) : []
      }

      // 2. Update the specific field
      if (type && index !== undefined) {
        next[type][index][field] = value
      } else if (field) {
        next[field] = value
      }
      
      const dRate = Number(next.daily_rate || 0)
      const hRate = dRate / 8

      // 3. Update daily_rate if base_salary changed
      if (field === 'base_salary') {
        const isDaily = next.employee?.rate_type === 'daily'
        if (isDaily) {
          next.daily_rate = Number(value)
        } else {
          const oldBase = Number(prev.base_salary)
          const oldDaily = Number(prev.daily_rate)
          if (oldBase > 0) {
            next.daily_rate = (Number(value) / oldBase) * oldDaily
          }
        }
      }

      // 4. Handle Syncing
      if (type === 'allowances' && field === 'amount') {
        // Line Item -> Metric
        const item = next.allowances[index]
        if (item.label === 'Overtime Pay' && hRate > 0) {
          next.overtime_hours = Math.round((Number(value) / (hRate * 1.25)) * 100) / 100
        }
      } else if (type === 'deductions' && field === 'amount') {
        // Line Item -> Metric
        const item = next.deductions[index]
        if (item.label === 'Late' && hRate > 0) {
          next.late_minutes = Math.round((Number(value) / hRate) * 60)
        } else if (item.label === 'Undertime' && hRate > 0) {
          next.undertime_minutes = Math.round((Number(value) / hRate) * 60)
        } else if (item.label === 'Absent' && dRate > 0) {
          next.absent_days = Math.round((Number(value) / dRate) * 100) / 100
          // For Absent, we can also sync back to days_worked/hours if we want,
          // but per previous request we kept them independent to avoid cascades.
        }
      } else if (field === 'total_hours') {
        // Metric -> Metric
        next.days_worked = Math.round((Number(value) / 8) * 100) / 100
      } else if (field === 'days_worked') {
        // Metric -> Metric
        next.total_hours = Math.round(Number(value) * 8 * 100) / 100
      } else if (field === 'absent_days') {
        // Metric -> Metric (currently independent)
      }
      // absent_days is now independent to prevent "cascading" to 30 days

      // 5. Auto-sync ALL derived items whenever rate OR metrics change
      // Re-read daily_rate from next in case base_salary was just updated (step 3)
      const currentDRate = Number(next.daily_rate || 0)
      const syncDerivedItems = () => {
        const hRate = currentDRate / 8

        // Overtime Pay
        let otItem = next.allowances.find(a => a.label === 'Overtime Pay')
        const otAmount = Math.round(Number(next.overtime_hours || 0) * hRate * 1.25 * 100) / 100
        
        // Only update the amount from metric if we aren't currently editing the amount itself
        // to prevent rounding jitter.
        if (otItem && (field !== 'amount' || type !== 'allowances' || next.allowances[index].label !== 'Overtime Pay')) {
          otItem.amount = otAmount
        } else if (!otItem && otAmount > 0) {
          next.allowances.push({ label: 'Overtime Pay', amount: otAmount })
        }
        
        // Late
        let lateItem = next.deductions.find(d => d.label === 'Late')
        const lateAmount = Math.round((Number(next.late_minutes || 0) / 60) * hRate * 100) / 100
        if (lateItem && (field !== 'amount' || type !== 'deductions' || next.deductions[index].label !== 'Late')) {
          lateItem.amount = lateAmount
        } else if (!lateItem && lateAmount > 0) {
          next.deductions.push({ label: 'Late', amount: lateAmount })
        }
        
        // Undertime
        let utItem = next.deductions.find(d => d.label === 'Undertime')
        const utAmount = Math.round((Number(next.undertime_minutes || 0) / 60) * hRate * 100) / 100
        if (utItem && (field !== 'amount' || type !== 'deductions' || next.deductions[index].label !== 'Undertime')) {
          utItem.amount = utAmount
        } else if (!utItem && utAmount > 0) {
          next.deductions.push({ label: 'Undertime', amount: utAmount })
        }

        // Absent
        let absentItem = next.deductions.find(d => d.label === 'Absent')
        const absentAmount = Math.round(Number(next.absent_days || 0) * currentDRate * 100) / 100
        if (absentItem && (field !== 'amount' || type !== 'deductions' || next.deductions[index].label !== 'Absent')) {
          absentItem.amount = absentAmount
        } else if (!absentItem && absentAmount > 0) {
          next.deductions.push({ label: 'Absent', amount: absentAmount })
        }

        // Half Day
        const halfDayItem = next.deductions.find(d => d.label === 'Half Day')
        if (halfDayItem) {
          const oldDRate = Number(prev.daily_rate)
          if (oldDRate > 0 && field === 'base_salary') {
            halfDayItem.amount = Math.round((Number(halfDayItem.amount) / (oldDRate / 2)) * (currentDRate / 2) * 100) / 100
          }
        }

        // Withholding Tax — TRAIN Law RA 10963, RR 8-2018 (effective Jan 1 2023)
        const calculateWTax = (income) => {
          if (payPeriods === 1) {
            // Monthly brackets
            if (income <= 20833) return 0
            if (income <= 33332) return (income - 20833) * 0.15
            if (income <= 66666) return 1875.00 + (income - 33333) * 0.20
            if (income <= 166666) return 8541.80 + (income - 66667) * 0.25
            if (income <= 666666) return 33541.80 + (income - 166667) * 0.30
            return 183541.80 + (income - 666667) * 0.35
          }
          // Semi-monthly brackets (default)
          if (income <= 10417) return 0
          if (income <= 16666) return (income - 10417) * 0.15
          if (income <= 33332) return 937.50 + (income - 16667) * 0.20
          if (income <= 83332) return 4270.70 + (income - 33333) * 0.25
          if (income <= 333332) return 16770.70 + (income - 83333) * 0.30
          return 91770.70 + (income - 333333) * 0.35
        }

        const getDeduction = (label) => {
          const item = next.deductions.find(d => d.label === label)
          return item ? Number(item.amount) : 0
        }

        const isDaily = next.employee?.rate_type === 'daily'
        const baseGross = isDaily
          ? (Number(next.base_salary) * Number(next.days_worked || 0))
          : (Number(next.base_salary) / payPeriods)
        // Exclude "Allowance" (undeclared) — off-the-books, not subject to BIR withholding
        const taxableAllowances = next.allowances
          .filter(a => a.label !== 'Allowance')
          .reduce((s, a) => s + Number(a.amount || 0), 0)
        const taxableGross = baseGross + taxableAllowances

        const earnedGross = taxableGross - (getDeduction('Late') + getDeduction('Undertime') + getDeduction('Absent') + getDeduction('Half Day'))
        const taxableIncome = earnedGross - (getDeduction('SSS EE Contribution') + getDeduction('PhilHealth EE Contribution') + getDeduction('Pag-IBIG EE Contribution'))
        
        const wTaxAmount = Math.round(calculateWTax(taxableIncome) * 100) / 100
        let wTaxItem = next.deductions.find(d => d.label === 'Withholding Tax')
        
        // Only update if we aren't manually editing the tax itself
        if (wTaxItem && (field !== 'amount' || type !== 'deductions' || next.deductions[index].label !== 'Withholding Tax')) {
          wTaxItem.amount = wTaxAmount
        } else if (!wTaxItem && wTaxAmount > 0) {
          next.deductions.push({ label: 'Withholding Tax', amount: wTaxAmount })
        }
      }

      syncDerivedItems()

      // 6. Recalculate totals
      const totalAllowances = next.allowances.reduce((s, a) => s + Number(a.amount || 0), 0)
      const totalDeductions = next.deductions.reduce((s, d) => s + Number(d.amount || 0), 0)

      const isDaily = next.employee?.rate_type === 'daily'
      const baseGross = isDaily
        ? (Number(next.base_salary) * Number(next.days_worked || 0))
        : (Number(next.base_salary) / payPeriods)

      next.gross_pay = baseGross + totalAllowances
      next.net_pay = next.gross_pay - totalDeductions
      
      return next
    })
  }

  const handleSaveEdit = () => {
    updateStatusMutation.mutate({ 
      id: editForm.id, 
      status: editForm.status,
      base_salary: editForm.base_salary,
      days_worked: editForm.days_worked,
      gross_pay: editForm.gross_pay,
      net_pay: editForm.net_pay,
      allowances: editForm.allowances,
      deductions: editForm.deductions,
      total_hours: editForm.total_hours,
      overtime_hours: editForm.overtime_hours,
      late_minutes: editForm.late_minutes,
      undertime_minutes: editForm.undertime_minutes,
    })
  }

  const moveCutoff = (delta) => {
    const next = delta > 0 ? getNextCutoff(currentCutoff, adminSettings) : getPrevCutoff(currentCutoff, adminSettings)
    localStorage.setItem('payroll_last_cutoff', JSON.stringify(next))
    setNavigatedCutoff(next)
  }

  const togglePaystubSelection = (payrollId) => {
    const newSelected = new Set(selectedPaystubs)
    if (newSelected.has(payrollId)) {
      newSelected.delete(payrollId)
    } else {
      newSelected.add(payrollId)
    }
    setSelectedPaystubs(newSelected)
  }

  const toggleSelectAllPaystubs = (allPaystubIds) => {
    if (selectedPaystubs.size === allPaystubIds.length) {
      setSelectedPaystubs(new Set())
    } else {
      setSelectedPaystubs(new Set(allPaystubIds))
    }
  }

  const addCcEmail = (email) => {
    if (email && !ccEmails.includes(email)) {
      setCcEmails([...ccEmails, email])
      setCcInput('')
    }
  }

  const removeCcEmail = (email) => {
    setCcEmails(ccEmails.filter(e => e !== email))
  }

  const addBccEmail = (email) => {
    if (email && !bccEmails.includes(email)) {
      setBccEmails([...bccEmails, email])
      setBccInput('')
    }
  }

  const removeBccEmail = (email) => {
    setBccEmails(bccEmails.filter(e => e !== email))
  }

  const saveCcBccHistory = () => {
    const allCc = [...new Set([...ccEmails, ...ccHistory])].slice(0, 10)
    const allBcc = [...new Set([...bccEmails, ...bccHistory])].slice(0, 10)
    localStorage.setItem('payroll_cc_history', JSON.stringify(allCc))
    localStorage.setItem('payroll_bcc_history', JSON.stringify(allBcc))
  }

  const handleSendPaystubs = async () => {
    if (selectedPaystubs.size === 0) {
      setAlert({ type: 'warning', message: 'Please select at least one paystub to send.' })
      return
    }

    // Save CC/BCC history before sending
    if (ccEmails.length > 0 || bccEmails.length > 0) {
      saveCcBccHistory()
    }

    const payrollIds = Array.from(selectedPaystubs)
    const selectedPayrollObjs = payrolls.filter(p => payrollIds.includes(p.id))

    try {
      // Generate Excel files for each selected payroll
      const formData = new FormData()
      
      // Add payroll IDs
      payrollIds.forEach((id, index) => {
        formData.append(`payroll_ids[${index}]`, id)
      })

      // Add CC and BCC emails
      ccEmails.forEach((email, index) => {
        formData.append(`cc_emails[${index}]`, email)
      })
      bccEmails.forEach((email, index) => {
        formData.append(`bcc_emails[${index}]`, email)
      })

      // Generate and add Excel files
      const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/api$/, '')
      const templateUrl = `${apiBaseUrl}/api/payroll-template`

      for (let i = 0; i < selectedPayrollObjs.length; i++) {
        const payroll = selectedPayrollObjs[i]
        const response = await fetch(templateUrl, {
          headers: {
            'Authorization': `Bearer ${localStorage.getItem('hr_token')}`
          }
        })
        const arrayBuffer = await response.arrayBuffer()
        
        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(arrayBuffer)
        const worksheet = workbook.worksheets[0]

        // Build employee details (same as export)
        const employeeName = `${payroll.employee?.first_name || ''} ${payroll.employee?.last_name || ''}`.trim()
        const payPeriod = `${format(parseISO(payroll.cutoff_start), 'MMM dd, yyyy')} - ${format(parseISO(payroll.cutoff_end), 'MMM dd, yyyy')}`
        const totalDeductions = (payroll.gross_pay || 0) - (payroll.net_pay || 0)
        
        const getScheduleDisplay = () => {
          if (!payroll.employee?.schedule) return ''
          const sched = payroll.employee.schedule
          if (typeof sched === 'object') {
            const { days, start_time, end_time } = sched
            if (days && start_time && end_time) {
              return `${days} (${start_time} - ${end_time})`
            }
            return sched.name || ''
          }
          return sched
        }
        
        const scheduleDisplay = getScheduleDisplay()

        const getEarningsAmount = (label) => {
          if (!payroll.allowances) return 0
          const earning = Array.isArray(payroll.allowances) 
            ? payroll.allowances.find(a => a?.label === label)
            : null
          return earning?.amount ? Number(earning.amount) : 0
        }

        const getDeductionAmount = (label) => {
          if (!payroll.deductions) return 0
          if (Array.isArray(payroll.deductions)) {
            const deduction = payroll.deductions.find(d => d?.label === label)
            return deduction?.amount ? Number(deduction.amount) : 0
          }
          return payroll.deductions[label] ? Number(payroll.deductions[label]) : 0
        }

        const totalAllowancesAmount = payroll.allowances?.reduce((sum, a) => sum + Number(a.amount || 0), 0) || 0
        const basicIncomeAmount = payroll.gross_pay - totalAllowancesAmount
        const overtimeAmount = getEarningsAmount('Overtime Pay')
        const restDayPayAmount = getEarningsAmount('Rest Day Pay')
        const restDayOTPayAmount = getEarningsAmount('Rest Day OT Pay')

        const dRate = Number(payroll.daily_rate) || 0
        const hRate = dRate / 8

        const restDayPayHours = restDayPayAmount > 0 && hRate > 0 ? restDayPayAmount / (hRate * 1.30) : 0
        const restDayOTPayHours = restDayOTPayAmount > 0 && hRate > 0 ? restDayOTPayAmount / (hRate * 1.69) : 0

        const nightDiffAmount = getEarningsAmount('Night Differential')
        const nightDiffHours = nightDiffAmount > 0 && hRate > 0 ? nightDiffAmount / (hRate * 0.10) : 0

        const specialHolidayAmount = getEarningsAmount('Special Holiday')
        const specialHolidayHoursLabel = specialHolidayAmount > 0 ? '—' : '0h'

        const legalHolidayAmount = getEarningsAmount('Legal Holiday')
        const legalHolidayHours = legalHolidayAmount > 0 && hRate > 0 ? legalHolidayAmount / (hRate * 1.00) : 0

        const absentAmount = getDeductionAmount('Absent')
        const absentDays = absentAmount > 0 && dRate > 0 ? absentAmount / dRate : 0

        const halfDayAmount = getDeductionAmount('Half Day')
        const halfDayDays = halfDayAmount > 0 && dRate > 0 ? halfDayAmount / (dRate / 2) : 0

        const { allowancesAmt, others } = splitAllowanceLines(payroll.allowances)
        const { others: deductionOthers } = splitDeductionLines(payroll.deductions)

        const fieldsMap = {
          'E13': employeeName,
          'E15': payroll.employee?.phone || payroll.employee?.contact_info || '',
          'E17': scheduleDisplay,
          'E19': payPeriod,
          'E21': payroll.days_worked ? `${payroll.days_worked} days` : '0 days',
          'L10': Number(payroll.net_pay) || 0,
          'L13': payroll.employee?.sss_number || '',
          'L15': payroll.employee?.philhealth_number || '',
          'L17': payroll.employee?.pagibig_number || '',
          'L19': payroll.employee?.bank_account_number || payroll.employee?.tin_number || '',
          'F27': payroll.days_worked ? `${payroll.days_worked} days` : '0 days',
          'F28': payroll.overtime_hours ? `${payroll.overtime_hours}h` : '0h',
          'F29': restDayPayHours ? `${Number(restDayPayHours).toFixed(2)}h` : '0h',
          'F30': restDayOTPayHours ? `${Number(restDayOTPayHours).toFixed(2)}h` : '0h',
          'F31': nightDiffHours ? `${Number(nightDiffHours).toFixed(2)}h` : '0h',
          'F32': specialHolidayHoursLabel,
          'F33': legalHolidayHours ? `${Number(legalHolidayHours).toFixed(2)}h` : '0h',
          'G27': Number(basicIncomeAmount) || 0,
          'G28': Number(overtimeAmount) || 0,
          'G29': Number(restDayPayAmount) || 0,
          'G30': Number(restDayOTPayAmount) || 0,
          'G31': Number(nightDiffAmount) || 0,
          'G32': Number(specialHolidayAmount) || 0,
          'G33': Number(legalHolidayAmount) || 0,
          'G34': Number(getEarningsAmount('13th Month Pay')) || 0,
          'G35': Number(allowancesAmt) || 0,
          'G39': Number(payroll.gross_pay) || 0,
          'N27': ((payroll.late_minutes || 0) + (payroll.undertime_minutes || 0)) ? `${(payroll.late_minutes || 0) + (payroll.undertime_minutes || 0)}m` : '0m',
          'N28': absentDays ? `${Number(absentDays).toFixed(2)}d` : '0d',
          'N29': halfDayDays ? `${Number(halfDayDays).toFixed(2)}d` : '0d',
          'O27': Number(getDeductionAmount('Late') + getDeductionAmount('Undertime')) || 0,
          'O28': Number(getDeductionAmount('Absent')) || 0,
          'O29': Number(getDeductionAmount('Half Day')) || 0,
          'O30': Number(getDeductionAmount('SSS EE Contribution')) || 0,
          'O31': Number(getDeductionAmount('PhilHealth EE Contribution')) || 0,
          'O32': Number(getDeductionAmount('Pag-IBIG EE Contribution')) || 0,
          'O33': Number(getDeductionAmount('Withholding Tax')) || 0,
          'O34': Number(getDeductionAmount('SSS Loan')) || 0,
          'O35': Number(getDeductionAmount('Pag-IBIG Loan')) || 0,
          'O39': Number(totalDeductions) || 0,
          'O40': Number(payroll.net_pay) || 0,
        }

        const currencyCells = [
          'L10', 'G27', 'G28', 'G29', 'G30', 'G31', 'G32', 'G33', 'G34', 'G35', 'G36', 'G39',
          'O27', 'O28', 'O29', 'O30', 'O31', 'O32', 'O33', 'O34', 'O35', 'O36', 'O39', 'O40'
        ]

        Object.entries(fieldsMap).forEach(([cell, value]) => {
          const cellRef = worksheet.getCell(cell)
          if (cellRef) {
            cellRef.value = value
            if (currencyCells.includes(cell)) {
              cellRef.numFmt = '"₱"#,##0.00;-"₱"#,##0.00'
            }
          }
        })

        insertOthersBreakdown(worksheet, others, deductionOthers)

        // Protect sheet before sending — prevents employee from editing the paystub
        worksheet.protect('', { selectLockedCells: true, selectUnlockedCells: true })

        // Generate blob and add to FormData
        const buffer = await workbook.xlsx.writeBuffer()
        const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
        const filename = `payroll-${payroll.employee?.first_name}-${payroll.employee?.last_name}-${format(parseISO(payroll.cutoff_end), 'MMM-dd-yyyy')}.xlsx`
        formData.append(`files[${i}]`, blob, filename)
      }

      // Send to backend
      sendPaystubsMutation.mutate(formData)
    } catch (error) {
      console.error('Error generating paystubs:', error)
      setAlert({ type: 'error', message: 'Failed to generate paystubs. Please try again.' })
    }
  }

  const finalizedPaystubs = payrolls.filter(p => p.status === 'finalized')
  const exportablePayrolls = payrolls.filter(p => p.status === 'finalized' || p.status === 'paid')

  // Builds the cell map and currency cell list for a payroll record
  const buildPaystubCellMap = (payroll) => {
    const employeeName = `${payroll.employee?.first_name || ''} ${payroll.employee?.last_name || ''}`.trim()
    const payPeriod = `${format(parseISO(payroll.cutoff_start), 'MMM dd, yyyy')} - ${format(parseISO(payroll.cutoff_end), 'MMM dd, yyyy')}`
    const totalDeductions = (payroll.gross_pay || 0) - (payroll.net_pay || 0)

    const sched = payroll.employee?.schedule
    const scheduleDisplay = sched
      ? (typeof sched === 'object'
          ? (sched.days && sched.start_time && sched.end_time
              ? `${sched.days} (${sched.start_time} - ${sched.end_time})`
              : sched.name || '')
          : sched)
      : ''

    const getE = (label) => {
      if (!payroll.allowances) return 0
      if (Array.isArray(payroll.allowances)) return Number(payroll.allowances.find(a => a?.label === label)?.amount || 0)
      return Number(payroll.allowances[label] || 0)
    }
    const getD = (label) => {
      if (!payroll.deductions) return 0
      if (Array.isArray(payroll.deductions)) return Number(payroll.deductions.find(d => d?.label === label)?.amount || 0)
      return Number(payroll.deductions[label] || 0)
    }

    const dRate = Number(payroll.daily_rate) || 0
    const hRate = dRate / 8
    const totalAllowances = payroll.allowances?.reduce((s, a) => s + Number(a.amount || 0), 0) || 0
    const basicIncome   = payroll.gross_pay - totalAllowances
    const otPay         = getE('Overtime Pay')
    const rdPay         = getE('Rest Day Pay')
    const rdOTPay       = getE('Rest Day OT Pay')
    const nightDiff     = getE('Night Differential')
    const specialHol    = getE('Special Holiday')
    const legalHol      = getE('Legal Holiday')
    const absentAmt     = getD('Absent')
    const halfDayAmt    = getD('Half Day')

    const { allowancesAmt, others } = splitAllowanceLines(payroll.allowances)

    const fieldsMap = {
      'E13': employeeName,
      'E15': payroll.employee?.phone || payroll.employee?.contact_info || '',
      'E17': scheduleDisplay,
      'E19': payPeriod,
      'E21': payroll.days_worked ? `${payroll.days_worked} days` : '0 days',
      'L10': Number(payroll.net_pay) || 0,
      'L13': payroll.employee?.sss_number || '',
      'L15': payroll.employee?.philhealth_number || '',
      'L17': payroll.employee?.pagibig_number || '',
      'L19': payroll.employee?.tin_number || '',
      'L21': payroll.employee?.bank_account_number || '',
      'F27': payroll.days_worked ? `${payroll.days_worked} days` : '0 days',
      'F28': payroll.overtime_hours ? `${payroll.overtime_hours}h` : '0h',
      'F29': rdPay > 0 && hRate > 0 ? `${(rdPay / (hRate * 1.30)).toFixed(2)}h` : '0h',
      'F30': rdOTPay > 0 && hRate > 0 ? `${(rdOTPay / (hRate * 1.69)).toFixed(2)}h` : '0h',
      'F31': nightDiff > 0 && hRate > 0 ? `${(nightDiff / (hRate * 0.10)).toFixed(2)}h` : '0h',
      'F32': specialHol > 0 ? '—' : '0h',
      'F33': legalHol > 0 && hRate > 0 ? `${(legalHol / (hRate * 1.00)).toFixed(2)}h` : '0h',
      'G27': Number(basicIncome) || 0,
      'G28': Number(otPay) || 0,
      'G29': Number(rdPay) || 0,
      'G30': Number(rdOTPay) || 0,
      'G31': Number(nightDiff) || 0,
      'G32': Number(specialHol) || 0,
      'G33': Number(legalHol) || 0,
      'G34': Number(getE('13th Month Pay')) || 0,
      'G35': Number(allowancesAmt) || 0,
      'G39': Number(payroll.gross_pay) || 0,
      'N27': (payroll.late_minutes || 0) + (payroll.undertime_minutes || 0) ? `${(payroll.late_minutes || 0) + (payroll.undertime_minutes || 0)}m` : '0m',
      'N28': absentAmt > 0 && dRate > 0 ? `${(absentAmt / dRate).toFixed(2)}d` : '0d',
      'N29': halfDayAmt > 0 && dRate > 0 ? `${(halfDayAmt / (dRate / 2)).toFixed(2)}d` : '0d',
      'O27': Number(getD('Late') + getD('Undertime')) || 0,
      'O28': Number(getD('Absent')) || 0,
      'O29': Number(getD('Half Day')) || 0,
      'O30': Number(getD('SSS EE Contribution')) || 0,
      'O31': Number(getD('PhilHealth EE Contribution')) || 0,
      'O32': Number(getD('Pag-IBIG EE Contribution')) || 0,
      'O33': Number(getD('Withholding Tax')) || 0,
      'O34': Number(getD('SSS Loan')) || 0,
      'O35': Number(getD('Pag-IBIG Loan')) || 0,
      'O39': Number(totalDeductions) || 0,
      'O40': Number(payroll.net_pay) || 0,
    }

    const currencyCells = ['L10','G27','G28','G29','G30','G31','G32','G33','G34','G35','G36','G39','O27','O28','O29','O30','O31','O32','O33','O34','O35','O36','O39','O40']

    return { fieldsMap, currencyCells }
  }

  // Applies cell map to a worksheet (in-place)
  const applyPaystubData = (worksheet, payroll) => {
    const { fieldsMap, currencyCells } = buildPaystubCellMap(payroll)
    Object.entries(fieldsMap).forEach(([cell, value]) => {
      const cellRef = worksheet.getCell(cell)
      if (!cellRef) return
      cellRef.value = value
      if (currencyCells.includes(cell)) cellRef.numFmt = '"₱"#,##0.00;-"₱"#,##0.00'
    })
    const { others } = splitAllowanceLines(payroll.allowances)
    const { others: deductionOthers } = splitDeductionLines(payroll.deductions)
    insertOthersBreakdown(worksheet, others, deductionOthers)
  }

  // Fetches the paystub template ArrayBuffer (called once per export operation)
  const fetchPaystubTemplate = async () => {
    const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/api$/, '')
    const res = await fetch(`${apiBaseUrl}/api/payroll-template`, {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('hr_token')}` }
    })
    return res.arrayBuffer()
  }

  // Copies template structure (columns, merges, rows+styles, images) into a fresh worksheet
  const copyTemplateToSheet = (sourceWb, sourceWs, targetWb, targetWs) => {
    // Sheet-level properties (default row height, tab color, etc.)
    if (sourceWs.properties) targetWs.properties = { ...sourceWs.properties }
    if (sourceWs.pageSetup) targetWs.pageSetup = { ...sourceWs.pageSetup }
    if (sourceWs.views?.length) targetWs.views = JSON.parse(JSON.stringify(sourceWs.views))

    // Columns: width + column-level style
    sourceWs.columns.forEach((col, idx) => {
      const targetCol = targetWs.getColumn(idx + 1)
      if (col.width) targetCol.width = col.width
      if (col.style) targetCol.style = JSON.parse(JSON.stringify(col.style))
      if (col.hidden) targetCol.hidden = col.hidden
    })

    // Merged regions: values are {top,left,bottom,right} row/col numbers
    Object.values(sourceWs._merges || {}).forEach(merge => {
      try { targetWs.mergeCells(merge.top, merge.left, merge.bottom, merge.right) } catch (_) {}
    })

    // Rows: height + per-cell style (do NOT set row.style — it resets merged cells)
    sourceWs.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const targetRow = targetWs.getRow(rowNumber)
      if (row.height) targetRow.height = row.height
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const targetCell = targetRow.getCell(colNumber)
        targetCell.value = cell.value
        if (cell.style) targetCell.style = JSON.parse(JSON.stringify(cell.style))
      })
      targetRow.commit()
    })

    // Images (logos, etc.) — look up buffer in source workbook's _media array
    try {
      const wsImages = sourceWs.getImages()
      wsImages.forEach(img => {
        const sourceMedia = sourceWb.media[img.imageId]
        if (!sourceMedia?.buffer) return
        const newImageId = targetWb.addImage({
          buffer: sourceMedia.buffer,
          extension: sourceMedia.extension,
        })
        targetWs.addImage(newImageId, img.range)
      })
    } catch (err) {
      console.error('Image copy failed:', err)
    }
  }

  const handleBatchExportExcel = async () => {
    if (exportablePayrolls.length === 0) return
    try {
      const templateBuffer = await fetchPaystubTemplate()

      // Load template once as the copy source
      const sourceWb = new ExcelJS.Workbook()
      await sourceWb.xlsx.load(templateBuffer)
      const sourceWs = sourceWb.worksheets[0]

      const masterWorkbook = new ExcelJS.Workbook()
      const usedSheetNames = new Set()

      for (let i = 0; i < exportablePayrolls.length; i++) {
        const payroll = exportablePayrolls[i]
        const empName = `${payroll.employee?.first_name || ''} ${payroll.employee?.last_name || ''}`.trim()
        const group = payroll.employee?.group?.trim()
        const groupAbbr = group ? group.replace(/[^A-Z]/g, '') : ''
        let base = (groupAbbr ? `${groupAbbr} - ${empName}` : empName) || `Employee ${i + 1}`
        let sheetName = base.substring(0, 31)
        if (usedSheetNames.has(sheetName)) {
          let counter = 2
          do {
            const suffix = ` (${counter})`
            sheetName = base.substring(0, 31 - suffix.length) + suffix
            counter++
          } while (usedSheetNames.has(sheetName))
        }
        usedSheetNames.add(sheetName)
        const ws = masterWorkbook.addWorksheet(sheetName)

        copyTemplateToSheet(sourceWb, sourceWs, masterWorkbook, ws)
        applyPaystubData(ws, payroll)
        ws.protect('', { selectLockedCells: true, selectUnlockedCells: true })
      }

      const buffer = await masterWorkbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `paystubs-${currentCutoff.label.replace(/ /g, '_')}.xlsx`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      window.URL.revokeObjectURL(url)
    } catch (error) {
      console.error('Batch export error:', error)
      setAlert({ type: 'error', message: 'Failed to export paystubs. Please try again.' })
    }
  }

  const exportPayrollToExcel = async (payroll) => {
    try {
      const templateBuffer = await fetchPaystubTemplate()
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(templateBuffer)
      const worksheet = workbook.worksheets[0]

      applyPaystubData(worksheet, payroll)
      worksheet.protect('', { selectLockedCells: true, selectUnlockedCells: true })

      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `payroll-${payroll.employee?.first_name}-${payroll.employee?.last_name}-${format(parseISO(payroll.cutoff_end), 'MMM-dd-yyyy')}.xlsx`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      window.URL.revokeObjectURL(url)
    } catch (error) {
      console.error('Export error details:', error)
      setAlert({ type: 'error', message: 'Failed to export payroll. Please try again.' })
    }
  }

  const getEEContrib = (label) => {
    if (!selectedPayroll) return 0
    const dList = isEditing && editForm ? editForm.deductions : (Array.isArray(selectedPayroll.deductions) ? selectedPayroll.deductions : Object.entries(selectedPayroll.deductions || {}).map(([k, v]) => ({ label: k, amount: v })))
    if (!dList) return 0
    const item = dList.find(d => d.label === label)
    return item ? Number(item.amount) : 0
  }
  
  const calculateERContributions = () => {
    if (!selectedPayroll) return { sssER: 0, phicER: 0, hdmfER: 0, totalER: 0 }
    
    // Get contribution basis: undeclared for daily rate, base_salary for monthly.
    // Must match PayrollController's backend basis exactly (no base_salary fallback
    // for daily employees — base_salary there is a per-day wage, not a monthly figure).
    const isDaily = selectedPayroll.employee?.rate_type === 'daily'
    const contributionBasis = isDaily
      ? Number(selectedPayroll.undeclared_salary)
      : Number(selectedPayroll.base_salary)

    if (contributionBasis <= 0) return { sssER: 0, phicER: 0, hdmfER: 0, totalER: 0 }

    // Calculate SSS ER from contribution table
    let sssER = 0
    if (adminSettings && Array.isArray(adminSettings)) {
      const sssSetting = adminSettings.find(s => s.key === 'sss_contribution_table')
      
      if (sssSetting && sssSetting.value) {
        let sssTable = sssSetting.value
        
        // Handle double-encoded JSON (parse multiple times if needed)
        let parseAttempts = 0
        while (typeof sssTable === 'string' && parseAttempts < 3) {
          try {
            sssTable = JSON.parse(sssTable)
            parseAttempts++
          } catch (e) {
            console.error('Failed to parse SSS table:', e)
            break
          }
        }
        
        // Ensure it's an array
        if (Array.isArray(sssTable) && sssTable.length > 0) {
          const bracket = sssTable.find(b => 
            contributionBasis >= b.min && (b.max === null || contributionBasis <= b.max)
          )
          sssER = bracket ? (bracket.er || 0) / payPeriods : 0
        }
      }
    }

    // Calculate PhilHealth ER: 5% total, 2.5% ER share
    let phicER = 0
    if (contributionBasis < 10000) {
      phicER = (500 * 0.5) / payPeriods
    } else if (contributionBasis > 100000) {
      phicER = (5000 * 0.5) / payPeriods
    } else {
      phicER = ((contributionBasis * 0.05) * 0.5) / payPeriods
    }

    // Calculate Pag-IBIG ER: 2% capped at 10k salary
    const pagibigBase = Math.min(contributionBasis, 10000)
    const hdmfER = (pagibigBase * 0.02) / payPeriods
    
    return {
      sssER: Number(sssER.toFixed(2)),
      phicER: Number(phicER.toFixed(2)),
      hdmfER: Number(hdmfER.toFixed(2)),
      totalER: Number((sssER + phicER + hdmfER).toFixed(2))
    }
  }
  
  const { sssER, phicER, hdmfER, totalER } = calculateERContributions()

  const totals = useMemo(() => {
    return payrolls.reduce((acc, p) => ({
      gross: acc.gross + Number(p.gross_pay),
      net: acc.net + Number(p.net_pay),
      count: acc.count + 1
    }), { gross: 0, net: 0, count: 0 })
  }, [payrolls])

  return (
    <div className="space-y-5">
      <PageHeader
        title="Payroll Processing"
        description="Calculate salaries and manage disbursements"
        action={
          <div className="flex items-center gap-2">
            <button
              onClick={() => moveCutoff(-1)}
              className="btn-secondary p-2"
            >
              <ChevronLeft size={16} />
            </button>
            <div className="flex items-center gap-2 bg-white border border-gray-200 px-4 py-2 rounded-lg shadow-sm">
              <Calendar size={14} className="text-brand-600" />
              <span className="text-sm font-semibold text-gray-700 min-w-[160px] text-center">
                {currentCutoff.label}
              </span>
            </div>
            <button
              onClick={() => moveCutoff(1)}
              className="btn-secondary p-2"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        }
        help={[
          { heading: 'Cutoff Navigation', items: [
            'Use the Previous / Next arrows at the top-right to switch between payroll periods.',
            'The current period label (e.g., "Jun 1–15, 2025") is shown between the arrows.',
          ]},
          { heading: 'Summary Cards', items: [
            'The three cards at the top show the total number of employees, total gross pay, and total net pay for the selected period.',
          ]},
          { heading: 'Generating Payroll', items: [
            'Click the Generate button to compute payroll for the current period. Records start in Draft status.',
            'Payroll can only be generated once per period — regenerating replaces the existing draft.',
          ]},
          { heading: 'Viewing & Editing', items: [
            'Click the file icon on any employee row to open their full payroll breakdown: earnings, deductions, attendance metrics, and employer contributions.',
            'Inside the detail view, click Edit to add or remove allowance and deduction line items.',
          ]},
          { heading: 'Finalize & Revert', items: [
            'Click the checkmark icon to finalize a payroll record — finalized records are locked from editing.',
            'Inside the detail view, click Revert to Draft to unlock a finalized record.',
          ]},
          { heading: 'Email Paystubs', items: [
            'Check the checkbox next to one or more employees, then click Email Paystubs.',
            'Enter optional CC or BCC addresses and click Send to deliver paystubs by email.',
          ]},
          { heading: 'Export', items: [
            'Click Export All to download the entire payroll batch as an Excel file using the configured template.',
          ]},
        ]}
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="card p-4 flex flex-col justify-between">
          <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">Total Employees</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{totals.count}</p>
        </div>
        <div className="card p-4 flex flex-col justify-between border-l-4 border-green-500">
          <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">Total Gross Pay</p>
          <p className="text-2xl font-bold text-green-600 mt-1">₱{totals.gross.toLocaleString()}</p>
        </div>
        <div className="card p-4 flex flex-col justify-between border-l-4 border-green-500">
          <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">Total Net Pay</p>
          <p className="text-2xl font-bold text-green-600 mt-1">₱{totals.net.toLocaleString()}</p>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 bg-gray-50/50 flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-semibold text-gray-700 whitespace-nowrap">Cutoff Details</h3>
              {payrollGroups.length > 0 && (
                <select
                  value={groupFilter}
                  onChange={e => setGroupFilter(e.target.value)}
                  className="input py-1.5 text-xs w-36"
                >
                  <option value="">All Groups</option>
                  {payrollGroups.map(g => <option key={g} value={g}>{g}</option>)}
                </select>
              )}
            </div>
            <div className="flex flex-wrap gap-2 items-center">
              <button
                disabled={generateMutation.isPending}
                onClick={() => generateMutation.mutate({
                  cutoff_start: currentCutoff.startDate,
                  cutoff_end: currentCutoff.endDate,
                  ...(groupFilter && { group: groupFilter }),
                })}
                className="btn-primary py-2 text-xs whitespace-nowrap"
              >
                {generateMutation.isPending ? <Spinner size="sm" /> : <><Plus size={14} /> {groupFilter ? `Generate — ${groupFilter}` : 'Generate for Period'}</>}
              </button>
              <button
                disabled={exportablePayrolls.length === 0}
                onClick={handleBatchExportExcel}
                className="btn-primary py-2 text-xs whitespace-nowrap bg-green-600 hover:bg-green-700 border-green-600"
                title={exportablePayrolls.length === 0 ? 'No finalized or paid payrolls to export' : ''}
              >
                <Download size={14} /> Export All Paystubs
              </button>
              <button
                disabled={finalizedPaystubs.length === 0 || sendPaystubsMutation.isPending}
                onClick={() => {
                  setShowEmailModal(true)
                  setCcEmails([])
                  setBccEmails([])
                  setCcInput('')
                  setBccInput('')
                }}
                className="btn-primary py-2 text-xs whitespace-nowrap bg-purple-600 hover:bg-purple-700 border-purple-600"
                title={finalizedPaystubs.length === 0 ? 'No finalized paystubs to send' : ''}
              >
                {sendPaystubsMutation.isPending ? <Spinner size="sm" /> : <><Mail size={14} /> Email Paystub</>}
              </button>
            </div>
          </div>
        </div>

        {isLoading ? (
          <PageSpinner />
        ) : payrolls.length === 0 ? (
          <div className="py-20 flex flex-col items-center justify-center text-center">
            <Banknote size={48} className="text-gray-100 mb-4" />
            <p className="text-sm font-medium text-gray-500">No payroll records for this cutoff</p>
            <p className="text-xs text-gray-400 mt-1">Click "Generate" above to calculate employee salaries</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50/50 text-left">
                  <th className="px-5 py-3 text-xs font-bold text-gray-400 uppercase tracking-wider">Employee</th>
                  <th className="px-5 py-3 text-xs font-bold text-gray-400 uppercase tracking-wider">Base Salary</th>
                  <th className="px-5 py-3 text-xs font-bold text-gray-400 uppercase tracking-wider text-center">Hours</th>
                  <th className="px-5 py-3 text-xs font-bold text-gray-400 uppercase tracking-wider text-center">OT/Late</th>
                  <th className="px-5 py-3 text-xs font-bold text-gray-400 uppercase tracking-wider">Gross Pay</th>
                  <th className="px-5 py-3 text-xs font-bold text-gray-400 uppercase tracking-wider">Net Pay</th>
                  <th className="px-5 py-3 text-xs font-bold text-gray-400 uppercase tracking-wider">Status</th>
                  <th className="px-5 py-3 text-xs font-bold text-gray-400 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {payrolls.map(p => (
                  <tr key={p.id} className="hover:bg-gray-50 group">
                    <td className="px-5 py-3">
                      <p className="font-semibold text-gray-900">{p.employee?.first_name} {p.employee?.last_name}</p>
                      <p className="text-[10px] text-gray-400 uppercase font-bold">{p.employee?.position}</p>
                    </td>
                    <td className="px-5 py-3 text-gray-600">₱{Number(p.base_salary).toLocaleString()}</td>
                    <td className="px-5 py-3 text-center text-gray-600 font-mono">
                      <div className="flex flex-col">
                        <span>{Number(p.total_hours).toFixed(1)}h</span>
                        <span className="text-[10px] text-gray-400 font-bold">{p.days_worked} Days</span>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-center">
                      <div className="flex flex-col gap-0.5">
                        <span className="text-[10px] text-blue-600 font-bold">OT: {Number(p.overtime_hours).toFixed(1)}h</span>
                        <span className="text-[10px] text-red-500 font-bold">Late: {p.late_minutes}m</span>
                      </div>
                    </td>
                    <td className="px-5 py-3 font-semibold text-gray-900">₱{Number(p.gross_pay).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                    <td className="px-5 py-3 font-bold text-green-600">₱{Number(p.net_pay).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                    <td className="px-5 py-3">
                      <StatusBadge status={p.status} />
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button 
                          onClick={() => setSelectedPayroll(p)}
                          className="p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded-md transition-colors"
                          title="View Details"
                        >
                          <FileDown size={16} />
                        </button>
                        {p.status === 'draft' && (
                          <button 
                            onClick={() => updateStatusMutation.mutate({ id: p.id, status: 'finalized' })}
                            className="p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded-md transition-colors"
                            title="Finalize"
                          >
                            <CheckCircle size={16} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal
        open={!!selectedPayroll}
        onClose={() => { setSelectedPayroll(null); setIsEditing(false) }}
        title={
          isEditing ? "Edit Payroll" : (
            <span className="flex flex-col gap-0.5">
              <span>Payroll Details</span>
              {selectedPayroll?.cutoff_start && selectedPayroll?.cutoff_end && (
                <span className="text-xs font-bold text-brand-600">
                  {format(parseISO(selectedPayroll.cutoff_start), 'MMM dd')} – {format(parseISO(selectedPayroll.cutoff_end), 'MMM dd, yyyy')}
                </span>
              )}
            </span>
          )
        }
        size="lg"
        headerAction={
          !isEditing && selectedPayroll && (
            <button 
              onClick={() => exportPayrollToExcel(selectedPayroll)}
              className="btn-secondary py-2 px-3 text-xs flex items-center gap-2"
              title="Export to Excel"
            >
              <Download size={14} /> Export
            </button>
          )
        }
        footer={selectedPayroll && (
          <div className="flex flex-col w-full gap-4">
            <div className="flex justify-between items-center bg-green-50 p-4 rounded-xl border border-green-100">
              <div>
                <p className="text-[10px] text-green-500 uppercase font-bold tracking-widest">Net Disbursement</p>
                <p className="text-2xl font-black text-green-700">
                  ₱{(isEditing ? editForm.net_pay : selectedPayroll.net_pay).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </p>
              </div>
              <div className="text-right">
                <p className="text-[10px] text-gray-400 uppercase font-bold">Gross Pay</p>
                <p className="text-sm font-bold text-gray-600">
                  ₱{(isEditing ? editForm.gross_pay : selectedPayroll.gross_pay).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </p>
              </div>
            </div>
            
            <div className="flex gap-2">
              {isEditing ? (
                <>
                  <button 
                    disabled={updateStatusMutation.isPending}
                    onClick={handleSaveEdit}
                    className="btn-primary flex-1 py-3"
                  >
                    {updateStatusMutation.isPending ? <Spinner size="sm" /> : 'Save Changes'}
                  </button>
                  <button onClick={() => setIsEditing(false)} className="btn-secondary px-6">Cancel</button>
                </>
              ) : (
                <>
                  {selectedPayroll.status === 'draft' && (
                    <button 
                      onClick={() => updateStatusMutation.mutate({ id: selectedPayroll.id, status: 'finalized' })}
                      className="btn-primary flex-1 py-3"
                    >
                      Finalize Payroll
                    </button>
                  )}
                  {selectedPayroll.status === 'finalized' && (
                    <div className="flex gap-2 flex-1">
                      <button 
                        onClick={() => updateStatusMutation.mutate({ id: selectedPayroll.id, status: 'paid' })}
                        className="btn-primary flex-1 py-3 bg-green-600 hover:bg-green-700 border-green-600"
                      >
                        Mark as Paid
                      </button>
                      <button 
                        onClick={() => revertToDraftMutation.mutate(selectedPayroll.id)}
                        className="btn-secondary py-3 bg-yellow-500 hover:bg-yellow-600 border-yellow-500 text-white"
                        title="Revert to draft status for editing"
                      >
                        Revert to Draft
                      </button>
                    </div>
                  )}
                  <button onClick={() => setSelectedPayroll(null)} className="btn-secondary px-6">Close</button>
                </>
              )}
            </div>
          </div>
        )}
      >
        {selectedPayroll && (
          <div className="space-y-6">
            <div className="flex justify-between items-start">
              <div>
                <h4 className="text-lg font-bold text-gray-900">{selectedPayroll.employee?.first_name} {selectedPayroll.employee?.last_name}</h4>
                <p className="text-xs text-gray-500">{selectedPayroll.employee?.position} • {selectedPayroll.employee?.department}</p>
              </div>
              <div className="flex flex-col items-end gap-2">
                <StatusBadge status={isEditing ? editForm.status : selectedPayroll.status} />
                {!isEditing && selectedPayroll.status === 'draft' && (
                  <button onClick={handleEditInit} className="text-brand-600 text-xs font-bold hover:underline flex items-center gap-1">
                    <Plus size={12} /> Edit Fields
                  </button>
                )}
                {!isEditing && selectedPayroll.undeclared_salary && selectedPayroll.status === 'draft' && selectedPayroll.employee?.rate_type !== 'daily' && (
                  <button 
                    onClick={() => setShowToggleConfirm(true)}
                    className="text-blue-600 text-xs font-bold hover:underline"
                    title="Toggle undertime deduction salary"
                  >
                    Switch Salary
                  </button>
                )}
                {!isEditing && (selectedPayroll.status === 'finalized' || selectedPayroll.status === 'paid') && (
                  <p className="text-xs text-gray-400 italic">This payroll is locked</p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] text-gray-400 uppercase font-bold tracking-widest">Earnings</p>
                  {isEditing && (
                    <select 
                      onChange={(e) => {
                        if (e.target.value === 'custom') handleAddField('allowances')
                        else if (e.target.value) handleAddField('allowances', e.target.value)
                        e.target.value = ''
                      }}
                      className="text-[10px] text-blue-600 font-bold bg-blue-50 hover:bg-blue-100 px-2 py-1 rounded border-none focus:ring-0"
                    >
                      <option value="">+ Add Item</option>
                      <option value="Overtime Pay">Overtime Pay</option>
                      <option value="Rest Day Pay">Rest Day Pay</option>
                      <option value="Rest Day OT Pay">Rest Day OT Pay</option>
                      <option value="Night Differential">Night Differential</option>
                      <option value="Special Holiday">Special Holiday</option>
                      <option value="Legal Holiday">Legal Holiday</option>
                      <option value="13th Month Pay">13th Month Pay</option>
                      <option value="custom">Other (Custom)</option>
                    </select>
                  )}
                </div>
                
                <div className="space-y-2">
                  <div className="flex justify-between items-center text-sm p-3 bg-gray-50 rounded-lg border border-gray-100">
                    <span className="text-gray-600">
                      { (isEditing ? editForm.employee?.rate_type : selectedPayroll.employee?.rate_type) === 'daily' 
                        ? `Base Pay (${isEditing ? editForm.days_worked : selectedPayroll.days_worked} Days)`
                        : `Base Salary (${payPeriods === 1 ? 'Monthly' : 'Half'})`
                      }
                    </span>
                    {isEditing ? (
                      <div className="flex items-center gap-1">
                        <span className="text-gray-400">₱</span>
                        <input
                          type="number"
                          className="w-24 text-right bg-transparent font-semibold focus:outline-none"
                          value={editForm.base_salary}
                          onChange={(e) => handleFieldChange(null, null, 'base_salary', e.target.value)}
                        />
                      </div>
                    ) : (
                      <span className="font-semibold text-gray-900">
                        ₱{ (selectedPayroll.employee?.rate_type === 'daily'
                            ? (Number(selectedPayroll.base_salary) * Number(selectedPayroll.days_worked))
                            : (Number(selectedPayroll.base_salary) / payPeriods)
                           ).toLocaleString() }
                      </span>
                    )}
                  </div>

                  {(isEditing ? editForm.allowances : (Array.isArray(selectedPayroll.allowances) ? selectedPayroll.allowances : Object.entries(selectedPayroll.allowances || {}).map(([k, v]) => ({ label: k, amount: v })))).map((item, idx) => (
                    <div key={idx} className="flex justify-between items-center text-sm p-3 bg-blue-50/50 rounded-lg border border-blue-100 group">
                      {isEditing ? (
                        <>
                          {isCustomEarning(item.label) ? (
                            <input
                              className="bg-transparent text-blue-700 placeholder:text-blue-300 focus:outline-none flex-1 mr-2"
                              value={item.label || ''}
                              placeholder="Description"
                              onChange={(e) => handleFieldChange('allowances', idx, 'label', e.target.value)}
                            />
                          ) : (
                            <span className="text-blue-700 capitalize flex-1 mr-2">{(item.label || '').replace('_', ' ')}</span>
                          )}
                          <div className="flex items-center gap-2">
                            <input 
                              type="number" 
                              className="w-20 text-right bg-transparent font-semibold focus:outline-none"
                              value={item.amount}
                              onChange={(e) => handleFieldChange('allowances', idx, 'amount', e.target.value)}
                            />
                            <button onClick={() => handleRemoveField('allowances', idx)} className="text-red-400 hover:text-red-600">
                              <Plus size={14} className="rotate-45" />
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <span className="text-blue-700 capitalize">
                            {(item.label || '').replace('_', ' ')}
                            {item.label === 'Night Differential' && ` (${(item.amount / ((Number(selectedPayroll.daily_rate) / 8) * 0.10) || 0).toFixed(1)}h)`}
                            {item.label === 'Legal Holiday' && ` (${(item.amount / ((Number(selectedPayroll.daily_rate) / 8) * 1.00) || 0).toFixed(1)}h)`}
                          </span>
                          <span className="font-semibold text-blue-800">+₱{Number(item.amount).toLocaleString()}</span>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] text-gray-400 uppercase font-bold tracking-widest">Deductions</p>
                  {isEditing && (
                    <select 
                      onChange={(e) => {
                        if (e.target.value === 'custom') handleAddField('deductions')
                        else if (e.target.value) handleAddField('deductions', e.target.value)
                        e.target.value = ''
                      }}
                      className="text-[10px] text-red-600 font-bold bg-red-50 hover:bg-red-100 px-2 py-1 rounded border-none focus:ring-0"
                    >
                      <option value="">+ Add Item</option>
                      <option value="Late">Late</option>
                      <option value="Undertime">Undertime</option>
                      <option value="Absent">Absent</option>
                      <option value="Half Day">Half Day</option>
                      <option value="SSS EE Contribution">SSS EE Contribution</option>
                      <option value="PhilHealth EE Contribution">PhilHealth EE Contribution</option>
                      <option value="Pag-IBIG EE Contribution">Pag-IBIG EE Contribution</option>
                      <option value="SSS Loan">SSS Loan</option>
                      <option value="Pag-IBIG Loan">Pag-IBIG Loan</option>
                      <option value="Cash Advance">Cash Advance</option>
                      <option value="custom">Other (Custom)</option>
                    </select>
                  )}
                </div>
                
                <div className="space-y-2">
                  {(isEditing ? editForm.deductions : (Array.isArray(selectedPayroll.deductions) ? selectedPayroll.deductions : Object.entries(selectedPayroll.deductions || {}).map(([k, v]) => ({ label: k, amount: v })))).map((item, idx) => (
                    <div key={idx} className="flex justify-between items-center text-sm p-3 bg-red-50/50 rounded-lg border border-red-100 group">
                      {isEditing ? (
                        <>
                          {isCustomDeduction(item.label) ? (
                            <input
                              className="bg-transparent text-red-700 placeholder:text-red-300 focus:outline-none flex-1 mr-2"
                              value={item.label || ''}
                              placeholder="Description"
                              onChange={(e) => handleFieldChange('deductions', idx, 'label', e.target.value)}
                            />
                          ) : (
                            <span className="text-red-700 capitalize flex-1 mr-2">{item.label === 'Cash Advance/Others' ? 'Cash Advance' : (item.label || '').replace('_', ' ')}</span>
                          )}
                          <div className="flex items-center gap-2">
                            <input 
                              type="number" 
                              className="w-20 text-right bg-transparent font-semibold focus:outline-none text-red-700"
                              value={item.amount}
                              onChange={(e) => handleFieldChange('deductions', idx, 'amount', e.target.value)}
                            />
                            <button onClick={() => handleRemoveField('deductions', idx)} className="text-red-400 hover:text-red-600">
                              <Plus size={14} className="rotate-45" />
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <span className="text-red-700 capitalize">{item.label === 'Cash Advance/Others' ? 'Cash Advance' : (item.label || '').replace('_', ' ')}</span>
                          <span className="font-semibold text-red-800">-₱{Number(item.amount).toLocaleString()}</span>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="bg-gray-50/50 p-4 rounded-xl border border-gray-100">
              <p className="text-[10px] text-gray-400 uppercase font-bold tracking-widest mb-3">Attendance Metrics</p>
              <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
                {[
                  { label: 'Work Hours', value: isEditing ? editForm.total_hours : selectedPayroll.total_hours, suffix: 'h', key: 'total_hours' },
                  { label: 'Days Worked', value: isEditing ? editForm.days_worked : selectedPayroll.days_worked, suffix: 'd', key: 'days_worked' },
                  { label: 'Absent', value: isEditing ? editForm.absent_days : (() => {
                    const dList = Array.isArray(selectedPayroll.deductions) ? selectedPayroll.deductions : Object.entries(selectedPayroll.deductions || {}).map(([k, v]) => ({ label: k, amount: v }));
                    const absentItem = dList.find(d => d.label === 'Absent');
                    return absentItem ? (Number(absentItem.amount) / (Number(selectedPayroll.daily_rate) || 1)) : 0;
                  })(), suffix: 'd', key: 'absent_days' },
                  { label: 'Overtime', value: isEditing ? editForm.overtime_hours : selectedPayroll.overtime_hours, suffix: 'h', key: 'overtime_hours' },
                  { label: 'Late', value: isEditing ? editForm.late_minutes : selectedPayroll.late_minutes, suffix: 'm', key: 'late_minutes' },
                  { label: 'Undertime', value: isEditing ? editForm.undertime_minutes : selectedPayroll.undertime_minutes, suffix: 'm', key: 'undertime_minutes' },
                ].map(m => (
                  <div key={m.label}>
                    <p className="text-[10px] text-gray-400 font-medium">{m.label}</p>
                    {isEditing ? (
                      <div className="flex items-center gap-1 border-b border-gray-200">
                        <input 
                          type="number" 
                          className="w-full bg-transparent text-sm font-bold focus:outline-none py-1"
                          value={m.value}
                          onChange={(e) => handleFieldChange(null, null, m.key, e.target.value)}
                        />
                        <span className="text-[10px] text-gray-400">{m.suffix}</span>
                      </div>
                    ) : (
                      <p className="text-sm font-bold text-gray-700">{Number(m.value).toFixed(1)}{m.suffix}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {!isEditing && (
              <div className="bg-orange-50/30 p-4 rounded-xl border border-orange-100/50">
                <p className="text-[10px] text-orange-500 uppercase font-bold tracking-widest mb-3">Employer Contributions (ER)</p>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div>
                    <p className="text-[10px] text-gray-400 font-medium">SSS ER</p>
                    <p className="text-sm font-bold text-gray-700">₱{sssER.toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-gray-400 font-medium">PhilHealth ER</p>
                    <p className="text-sm font-bold text-gray-700">₱{phicER.toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-gray-400 font-medium">Pag-IBIG ER</p>
                    <p className="text-sm font-bold text-gray-700">₱{hdmfER.toLocaleString()}</p>
                  </div>
                  <div className="border-l border-orange-200 pl-4">
                    <p className="text-[10px] text-orange-500 font-bold uppercase">Total ER</p>
                    <p className="text-sm font-black text-orange-600">₱{totalER.toLocaleString()}</p>
                  </div>
                </div>
                <p className="text-[9px] text-gray-400 mt-2 italic">* Employer shares do not affect the employee's net pay and are not included in the payroll slip export.</p>
              </div>
            )}

            <div className="flex justify-center">
              <button 
                onClick={() => setShowBreakdown(!showBreakdown)}
                className="text-[10px] text-gray-400 font-bold hover:text-brand-600 uppercase tracking-widest flex items-center gap-1 transition-colors"
              >
                <Plus size={10} className={showBreakdown ? 'rotate-45' : ''} />
                {showBreakdown ? 'Hide Calculation Logic' : 'View Calculation Logic'}
              </button>
            </div>

            {showBreakdown && (
              <div className="bg-brand-50/30 p-4 rounded-xl border border-brand-100/50 animate-in fade-in slide-in-from-top-2 duration-300">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-1 h-4 bg-brand-500 rounded-full"></div>
                  <p className="text-[10px] text-brand-600 uppercase font-bold tracking-widest">Calculation Breakdown</p>
                </div>
                
                <div className="space-y-4">
                  <div className="bg-white/50 p-3 rounded-lg border border-brand-100/30">
                    <p className="text-[10px] text-gray-400 font-bold uppercase mb-3">Base Salary Rules</p>
                    <div className="space-y-2">
                      <div className="flex justify-between text-xs">
                        <span className="text-gray-500">Rate Type</span>
                        <span className="font-bold text-gray-700 uppercase">{selectedPayroll.employee.rate_type}</span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-gray-500">Base Salary</span>
                        <span className="font-bold text-gray-700">₱{Number(selectedPayroll.base_salary).toLocaleString()}</span>
                      </div>
                      {selectedPayroll.undeclared_salary && (
                        <div className="flex justify-between text-xs">
                          <span className="text-gray-500">Benefits</span>
                          <span className="font-bold text-blue-700">₱{Number(selectedPayroll.undeclared_salary).toLocaleString()}</span>
                        </div>
                      )}
                      <div className="flex justify-between text-xs pt-1 border-t border-gray-100">
                        <span className="text-gray-500">Derived Daily Rate</span>
                        <span className="font-bold text-brand-600">₱{Number(selectedPayroll.daily_rate).toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-gray-500">Hourly Rate</span>
                        <span className="font-bold text-brand-600">₱{(Number(selectedPayroll.daily_rate) / 8).toFixed(2)}</span>
                      </div>
                      <p className="text-[9px] text-gray-400 italic">
                        Daily Rate / 8 hours
                      </p>
                      <p className="text-[9px] text-gray-400 italic">
                        {(() => {
                          if (selectedPayroll.employee.rate_type !== 'monthly') return 'Daily Rate Formula: Base salary as daily rate'
                          // use_undeclared=true means the last "Switch Salary" toggle put this
                          // payroll on undeclared_salary — must match that basis here too, or
                          // the reverse-engineered divisor comes out as nonsense (e.g. 174/172
                          // instead of 261/313) whenever undeclared salary is in use.
                          const basisLabel = selectedPayroll.use_undeclared ? 'Undeclared' : 'Base'
                          const basisAmount = Number(selectedPayroll.use_undeclared ? selectedPayroll.undeclared_salary : selectedPayroll.base_salary)
                          const dRate = Number(selectedPayroll.daily_rate)
                          return `Daily Rate Formula: (${basisLabel} × 12) / ${dRate > 0 ? Math.round((basisAmount * 12) / dRate) : 'divisor'}`
                        })()}
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="bg-white/50 p-3 rounded-lg border border-brand-100/30">
                      <p className="text-[10px] text-gray-400 font-bold uppercase mb-2">Earnings Logic</p>
                      <div className="space-y-2 text-xs">
                        <div className="flex justify-between items-start">
                          <div className="flex flex-col">
                            <span className="text-gray-500">Regular Base</span>
                            <span className="text-[9px] text-gray-400 italic">
                              {selectedPayroll.employee.rate_type === 'daily' 
                                ? `₱${Number(selectedPayroll.daily_rate).toLocaleString()} × ${selectedPayroll.days_worked}d`
                                : `₱${Number(selectedPayroll.base_salary).toLocaleString()} / ${payPeriods}`}
                            </span>
                          </div>
                          <span className="text-gray-700 font-medium">₱{Number(selectedPayroll.gross_pay - (selectedPayroll.allowances?.reduce((acc, a) => acc + a.amount, 0) || 0)).toLocaleString()}</span>
                        </div>

                        {selectedPayroll.allowances?.map((a, i) => {
                          let formula = '';
                          const hRate = Number(selectedPayroll.daily_rate) / 8;
                          if (a.label === 'Overtime Pay') {
                            const otHours = a.amount / (hRate * 1.25);
                            formula = `${otHours.toFixed(2)}h × ₱${hRate.toFixed(2)} × 1.25`;
                          } else if (a.label === 'Rest Day Pay') {
                            const rdHours = a.amount / (hRate * 1.30);
                            formula = `${rdHours.toFixed(2)}h × ₱${hRate.toFixed(2)} × 1.30`;
                          } else if (a.label === 'Rest Day OT Pay') {
                            const rdotHours = a.amount / (hRate * 1.69);
                            formula = `${rdotHours.toFixed(2)}h × ₱${hRate.toFixed(2)} × 1.69`;
                          } else if (a.label === 'Night Differential') {
                            const ndHours = a.amount / (hRate * 0.10);
                            formula = `${ndHours.toFixed(2)}h × ₱${hRate.toFixed(2)} × 0.10`;
                          } else if (a.label === 'Legal Holiday') {
                            const lhHours = a.amount / (hRate * 1.00);
                            formula = `${lhHours.toFixed(2)}h × ₱${hRate.toFixed(2)} × 1.00`;
                          }

                          return (
                            <div key={i} className="flex justify-between items-start pt-1 border-t border-gray-100/50">
                              <div className="flex flex-col">
                                <span className="text-gray-500">{a.label}</span>
                                {formula && <span className="text-[9px] text-gray-400 italic">{formula}</span>}
                              </div>
                              <span className="text-brand-600 font-medium">+ ₱{Number(a.amount).toLocaleString()}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div className="bg-white/50 p-3 rounded-lg border border-brand-100/30">
                      <p className="text-[10px] text-gray-400 font-bold uppercase mb-2">Deductions Logic</p>
                      <div className="space-y-2 text-xs">
                        {Object.entries(selectedPayroll.deductions || {}).map(([rawKey, rawVal]) => {
                          const val = typeof rawVal === 'object' ? rawVal.amount : rawVal;
                          const key = typeof rawVal === 'object' ? rawVal.label : rawKey;
                          
                          let formula = '';
                          const hRate = Number(selectedPayroll.daily_rate) / 8;
                          const dRate = Number(selectedPayroll.daily_rate);
                          
                          if (key === 'Late') {
                            formula = `${selectedPayroll.late_minutes}m / 60 × ₱${hRate.toFixed(2)}`;
                          } else if (key === 'Undertime') {
                            formula = `${selectedPayroll.undertime_minutes}m / 60 × ₱${hRate.toFixed(2)}`;
                          } else if (key === 'Absent') {
                            const days = dRate > 0 ? Number(val) / dRate : 0;
                            formula = `${Math.round(days)}d × ₱${dRate.toLocaleString()}`;
                          } else if (key === 'Half Day') {
                            const count = dRate > 0 ? Number(val) / (dRate / 2) : 0;
                            formula = `${Math.round(count)} sessions × (₱${dRate.toLocaleString()} / 2)`;
                          } else if (key.includes('EE Contribution')) {
                            formula = 'Statutory Fixed';
                          }

                          return (
                            <div key={key} className="flex justify-between items-start pt-1 first:pt-0 border-t first:border-0 border-gray-100/50">
                              <div className="flex flex-col">
                                <span className="text-gray-500">{key}</span>
                                {formula && <span className="text-[9px] text-gray-400 italic">{formula}</span>}
                              </div>
                              <span className="text-red-500 font-medium">- ₱{Number(val).toLocaleString()}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

          </div>
        )}
      </Modal>

      <Modal
        open={showEmailModal}
        onClose={() => {
          setShowEmailModal(false)
          setSelectedPaystubs(new Set())
          setCcEmails([])
          setBccEmails([])
          setCcInput('')
          setBccInput('')
        }}
        title="Email Paystubs"
        size="lg"
        footer={
          <div className="flex gap-2 justify-end">
            <button 
              onClick={() => {
                setShowEmailModal(false)
                setSelectedPaystubs(new Set())
                setCcEmails([])
                setBccEmails([])
                setCcInput('')
                setBccInput('')
              }}
              className="btn-secondary px-6"
            >
              Cancel
            </button>
            <button 
              disabled={selectedPaystubs.size === 0 || sendPaystubsMutation.isPending}
              onClick={handleSendPaystubs}
              className="btn-primary px-6"
            >
              {sendPaystubsMutation.isPending ? (
                <><Spinner size="sm" /> Sending...</>
              ) : (
                <><Mail size={14} /> Send {selectedPaystubs.size > 0 ? `(${selectedPaystubs.size})` : ''}</>
              )}
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
            <p className="text-sm text-blue-800 font-medium">
              ℹ️ Only paystubs with "Finalized" status can be sent
            </p>
            <p className="text-xs text-blue-600 mt-1">
              Employees will receive their paystub as an attachment. Their status will automatically change to "Paid" after sending.
            </p>
          </div>

          {/* CC/BCC Section */}
          <div className="space-y-3">
            {/* CC Field */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">CC Emails (Optional)</label>
              <div className="flex gap-2 mb-2">
                <input
                  type="email"
                  value={ccInput}
                  onChange={(e) => setCcInput(e.target.value)}
                  onKeyPress={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addCcEmail(ccInput)
                    }
                  }}
                  placeholder="Enter email and press Enter"
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <button
                  onClick={() => addCcEmail(ccInput)}
                  className="px-3 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm font-medium transition"
                >
                  Add
                </button>
              </div>
              
              {/* CC Suggestions */}
              {ccHistory.length > 0 && ccInput === '' && (
                <div className="mb-2">
                  <p className="text-xs text-gray-500 mb-1">Previously used:</p>
                  <div className="flex flex-wrap gap-1">
                    {ccHistory.filter(email => !ccEmails.includes(email)).map(email => (
                      <button
                        key={email}
                        onClick={() => addCcEmail(email)}
                        className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded transition"
                      >
                        {email}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Added CC Emails */}
              {ccEmails.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {ccEmails.map(email => (
                    <span key={email} className="inline-flex items-center gap-1 px-2 py-1 bg-blue-100 text-blue-700 rounded text-xs">
                      {email}
                      <button
                        onClick={() => removeCcEmail(email)}
                        className="hover:text-blue-900 font-bold"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* BCC Field */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">BCC Emails (Optional)</label>
              <div className="flex gap-2 mb-2">
                <input
                  type="email"
                  value={bccInput}
                  onChange={(e) => setBccInput(e.target.value)}
                  onKeyPress={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addBccEmail(bccInput)
                    }
                  }}
                  placeholder="Enter email and press Enter"
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <button
                  onClick={() => addBccEmail(bccInput)}
                  className="px-3 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm font-medium transition"
                >
                  Add
                </button>
              </div>

              {/* BCC Suggestions */}
              {bccHistory.length > 0 && bccInput === '' && (
                <div className="mb-2">
                  <p className="text-xs text-gray-500 mb-1">Previously used:</p>
                  <div className="flex flex-wrap gap-1">
                    {bccHistory.filter(email => !bccEmails.includes(email)).map(email => (
                      <button
                        key={email}
                        onClick={() => addBccEmail(email)}
                        className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded transition"
                      >
                        {email}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Added BCC Emails */}
              {bccEmails.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {bccEmails.map(email => (
                    <span key={email} className="inline-flex items-center gap-1 px-2 py-1 bg-purple-100 text-purple-700 rounded text-xs">
                      {email}
                      <button
                        onClick={() => removeBccEmail(email)}
                        className="hover:text-purple-900 font-bold"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {finalizedPaystubs.length === 0 ? (
            <div className="py-8 flex flex-col items-center justify-center text-center">
              <Mail size={48} className="text-gray-200 mb-4" />
              <p className="text-sm font-medium text-gray-500">No finalized paystubs available</p>
              <p className="text-xs text-gray-400 mt-1">Finalize paystubs from the payroll list first</p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-200">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedPaystubs.size === finalizedPaystubs.length}
                    onChange={() => toggleSelectAllPaystubs(finalizedPaystubs.map(p => p.id))}
                    className="w-4 h-4 rounded border-gray-300 accent-brand-600"
                  />
                  <span className="text-sm font-semibold text-gray-700">
                    Select All ({finalizedPaystubs.length})
                  </span>
                </label>
              </div>

              <div className="space-y-2 max-h-96 overflow-y-auto border border-gray-200 rounded-lg p-3">
                {finalizedPaystubs.map((payroll) => (
                  <label key={payroll.id} className="flex items-center gap-3 p-2 hover:bg-gray-50 rounded cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedPaystubs.has(payroll.id)}
                      onChange={() => togglePaystubSelection(payroll.id)}
                      className="w-4 h-4 rounded border-gray-300 accent-brand-600"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900">
                        {payroll.employee?.first_name} {payroll.employee?.last_name}
                      </p>
                      <p className="text-xs text-gray-500">
                        {payroll.employee?.email}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        ₱{Number(payroll.net_pay).toLocaleString()} net pay
                      </p>
                    </div>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
      </Modal>

      {/* Toggle Salary Basis Confirmation Modal */}
      <Modal
        open={showToggleConfirm}
        onClose={() => setShowToggleConfirm(false)}
        title="Switch Deduction Salary Basis"
        size="sm"
        footer={
          <div className="flex gap-2 justify-end">
            <button 
              onClick={() => setShowToggleConfirm(false)}
              className="btn-secondary px-6"
            >
              Cancel
            </button>
            <button 
              disabled={toggleUndertimeMutation.isPending}
              onClick={() => toggleUndertimeMutation.mutate(selectedPayroll.id)}
              className="btn-primary px-6 bg-blue-600 hover:bg-blue-700 border-blue-600"
            >
              {toggleUndertimeMutation.isPending ? (
                <><Spinner size="sm" /> Switching...</>
              ) : (
                'Confirm Switch'
              )}
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
            <p className="text-sm text-blue-800 font-medium">
              Switch Salary Basis for Deductions
            </p>
          </div>

          <div className="space-y-3">
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Current Setting</p>
              <div className="p-3 bg-gray-50 rounded-lg border border-gray-200">
                <p className="text-sm font-bold text-gray-900">
                  Using: <span className="text-brand-600">{selectedPayroll?.use_undeclared ? 'Benefits' : 'Base Salary'}</span>
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  Daily rate: ₱{Number(selectedPayroll?.daily_rate).toLocaleString()}
                </p>
                <p className="text-xs text-gray-500">
                  Hourly rate: ₱{(Number(selectedPayroll?.daily_rate) / 8).toFixed(2)}
                </p>
              </div>
            </div>

            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">After Switch</p>
              <div className="p-3 bg-blue-50 rounded-lg border border-blue-200">
                <p className="text-sm font-bold text-blue-900">
                  Will use: <span className="text-blue-600">{selectedPayroll?.use_undeclared ? 'Base Salary' : 'Benefits'}</span>
                </p>
                <p className="text-xs text-blue-600 mt-1">
                  Daily and hourly rates will be recalculated
                </p>
              </div>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
              <p className="text-xs text-amber-800 font-medium mb-1">
                ⚠️ The following deductions will be recalculated:
              </p>
              <ul className="text-xs text-amber-700 space-y-1 ml-4">
                <li>• <strong>Late</strong> - based on new hourly rate</li>
                <li>• <strong>Undertime</strong> - based on new hourly rate</li>
                <li>• <strong>Absent</strong> - based on new daily rate</li>
                <li>• <strong>Half Day</strong> - based on new daily rate</li>
              </ul>
              <p className="text-xs text-amber-700 mt-2">
                Net pay will be automatically updated.
              </p>
            </div>
          </div>
        </div>
      </Modal>

      {/* Toggle Success Confirmation Modal */}
      <Modal
        open={!!toggleSuccess}
        onClose={() => setToggleSuccess(null)}
        title="Success"
        size="sm"
        footer={
          <div className="flex gap-2 justify-end">
            <button 
              onClick={() => setToggleSuccess(null)}
              className="btn-primary px-6"
            >
              Close
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-center">
            <div className="text-4xl mb-2">✓</div>
            <p className="text-sm text-green-800 font-bold">
              {toggleSuccess?.message}
            </p>
          </div>

          <div className="bg-gray-50 rounded-lg p-4 space-y-2">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Updated Payroll Details</p>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-600">Gross Pay:</span>
                <span className="font-bold text-gray-900">₱{Number(toggleSuccess?.data?.gross_pay).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Total Deductions:</span>
                <span className="font-bold text-red-600">₱{(Number(toggleSuccess?.data?.gross_pay) - Number(toggleSuccess?.data?.net_pay)).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
              </div>
              <div className="flex justify-between border-t pt-2">
                <span className="font-bold text-gray-900">Net Pay:</span>
                <span className="text-lg font-black text-green-600">₱{Number(toggleSuccess?.data?.net_pay).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
              </div>
            </div>
          </div>
        </div>
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
    </div>
  )
}
