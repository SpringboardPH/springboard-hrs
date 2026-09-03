const MANILA_TZ = 'Asia/Manila'

/** Calendar date in Asia/Manila for Laravel `date` JSON (UTC ISO or `yyyy-MM-dd`). */
export function toAttendanceDateStr(value) {
  if (value == null || value === '') return ''
  const raw = String(value)
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) {
    const prefix = raw.match(/^(\d{4}-\d{2}-\d{2})/)
    return prefix ? prefix[1] : ''
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: MANILA_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(parsed)
  const get = (type) => parts.find((part) => part.type === type)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

function timeToMinutes(timeString) {
  if (!timeString) return 0
  const parts = timeString.split(':')
  const hours = parseInt(parts[0], 10) || 0
  const minutes = parseInt(parts[1], 10) || 0
  return hours * 60 + minutes
}

export const calculateHoursWorked = (clockInTime, clockOutTime) => {
  if (!clockInTime || !clockOutTime) return '—'
  
  try {
    const inMinutes = timeToMinutes(clockInTime)
    const outMinutes = timeToMinutes(clockOutTime)
    const diffMinutes = outMinutes - inMinutes
    
    if (diffMinutes < 0) return '—'
    
    const hours = Math.floor(diffMinutes / 60)
    const minutes = Math.round(diffMinutes % 60)
    
    return `${hours}h ${minutes}m`
  } catch {
    return '—'
  }
}
