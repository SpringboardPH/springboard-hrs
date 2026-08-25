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
      { day: 3, enabled: true, clock_in: '22:00:00', clock_out: '06:00:00', grace_enabled: false },
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
const postMidnight = { day_of_week: 3, minutes_since_midnight: 60, time: '01:00:00', date: '2026-08-26' }
const wedEnd = { day_of_week: 3, minutes_since_midnight: 6 * 60, time: '06:00:00', date: '2026-08-26' }
const wedMorning = { day_of_week: 3, minutes_since_midnight: 9 * 60, time: '09:00:00', date: '2026-08-26' }
const tooEarly = { day_of_week: 2, minutes_since_midnight: 20 * 60, time: '20:00:00', date: '2026-08-25' }
const openEarly = { day_of_week: 3, minutes_since_midnight: 5 * 60 + 58, time: '05:58:00', date: '2026-08-26' }
const openLate = { day_of_week: 3, minutes_since_midnight: 6 * 60 + 16, time: '06:16:00', date: '2026-08-26' }

const nightEvening = getClockWindow(nightSchedule, evening)
assert(canClockIn(nightEvening), 'night shift allows clock-in at Tue 21:11 (early window)')

const nightPost = getClockWindow(nightSchedule, postMidnight)
assert(canClockIn(nightPost), 'night shift allows clock-in at Wed 01:00 (adopt yesterday)')
assert(nightPost.adoptedYesterdayShift === true, 'Wed 01:00 marks adoptedYesterdayShift')

const nightWedEnd = getClockWindow(nightSchedule, wedEnd)
assert(!canClockIn(nightWedEnd), 'night shift blocks clock-in at Wed 06:00 (shift ended)')
assert(nightWedEnd.adoptedYesterdayShift !== true, 'Wed 06:00 does not adopt yesterday')

const nightWedMorning = getClockWindow(nightSchedule, wedMorning)
assert(!canClockIn(nightWedMorning), 'night shift blocks clock-in at Wed 09:00 (too early for tonight)')

const nightTooEarly = getClockWindow(nightSchedule, tooEarly)
assert(!canClockIn(nightTooEarly), 'night shift blocks clock-in at Tue 20:00 (before early window)')

const dayEvening = getClockWindow(daySchedule, evening)
assert(!canClockIn(dayEvening), 'standard 9-6 still blocks clock-in at 21:11')

const nightFmt = getClockWindow(nightSchedule, evening)
assert(nightFmt.formatTime(nightFmt.outEnd) === '06:00', 'formatTime keeps wall-clock for wrapped outEnd')

const openShiftEarly = getClockWindow(nightSchedule, openEarly, { openShiftDayOfWeek: 2 })
assert(openShiftEarly.currentMinutes < openShiftEarly.outStart, 'open Tue shift at Wed 05:58 is early for clock-out')
assert(openShiftEarly.currentMinutes <= openShiftEarly.outEnd, 'open Tue shift at Wed 05:58 still before outEnd')

const openShiftLate = getClockWindow(nightSchedule, openLate, { openShiftDayOfWeek: 2 })
assert(!(openShiftLate.currentMinutes < openShiftLate.outStart), 'open Tue shift at Wed 06:16 is not early')
assert(openShiftLate.currentMinutes > openShiftLate.outEnd, 'open Tue shift at Wed 06:16 is past outEnd')

if (process.exitCode) {
  console.error('\nverify-night-clock-window: FAILED')
  process.exit(1)
}
console.log('\nverify-night-clock-window: OK')
