import { getClockWindow } from '../src/utils/attendance.js'

const nightSchedule = {
  template: {
    type: 'night',
    name: 'Night Shift (10PM-6AM)',
    work_start_time: '22:00:00',
    work_end_time: '06:00:00',
    clock_in_start: '21:45:00',
    clock_in_end: '22:15:00',
    clock_out_start: '06:00:00',
    clock_out_end: '06:15:00',
    day_rules: [
      { day: 2, enabled: true, clock_in: '22:00:00', clock_out: '06:00:00', grace_enabled: false },
    ],
  },
}

const daySchedule = {
  template: {
    type: 'fixed',
    name: 'Standard 9-6 (Mon-Fri)',
    work_start_time: '09:00:00',
    work_end_time: '18:00:00',
    clock_in_start: '08:45:00',
    clock_in_end: '18:15:00',
    clock_out_start: '18:00:00',
    clock_out_end: '18:15:00',
    day_rules: [
      { day: 2, enabled: true, clock_in: '09:00:00', clock_out: '18:00:00', grace_enabled: false },
    ],
  },
}

const canClockIn = (win) =>
  Boolean(win) && !win.isInactiveDay && win.currentMinutes >= win.inStart && win.currentMinutes <= win.outEnd

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exitCode = 1
  } else {
    console.log('PASS:', msg)
  }
}

const evening = { day_of_week: 2, minutes_since_midnight: 21 * 60 + 11, time: '21:11:00', date: '2026-08-25' }
const postMidnight = { day_of_week: 2, minutes_since_midnight: 60, time: '01:00:00', date: '2026-08-26' }
const tooEarly = { day_of_week: 2, minutes_since_midnight: 20 * 60, time: '20:00:00', date: '2026-08-25' }

const nightEvening = getClockWindow(nightSchedule, evening)
assert(canClockIn(nightEvening), 'night shift allows clock-in at 21:11 (early window)')

const nightPost = getClockWindow(nightSchedule, postMidnight)
assert(canClockIn(nightPost), 'night shift allows clock-in at 01:00 (wrapped span)')

const nightTooEarly = getClockWindow(nightSchedule, tooEarly)
assert(!canClockIn(nightTooEarly), 'night shift blocks clock-in at 20:00 (before early window)')

const dayEvening = getClockWindow(daySchedule, evening)
assert(!canClockIn(dayEvening), 'standard 9-6 still blocks clock-in at 21:11')

const nightFmt = getClockWindow(nightSchedule, evening)
assert(nightFmt.formatTime(nightFmt.outEnd) === '06:00', 'formatTime keeps wall-clock for wrapped outEnd')

if (process.exitCode) {
  console.error('\nverify-night-clock-window: FAILED')
  process.exit(1)
}
console.log('\nverify-night-clock-window: OK')
