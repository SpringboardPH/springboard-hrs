<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Employee;
use App\Models\Payroll;
use App\Models\AttendanceLog;
use App\Models\EmployeeSchedule;
use App\Services\AttendanceService;
use Illuminate\Http\Request;
use Carbon\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;

class PayrollController extends Controller
{
    /**
     * Parse time string to minutes for duration calculations
     */
    private function parseTimeToMinutes(string $time): int
    {
        [$hour, $minute] = array_map('intval', explode(':', substr($time, 0, 5)));
        return $hour * 60 + $minute;
    }

    /**
     * Close out any half_day / undertime request still pending when payroll runs.
     *
     * Approving one of these excuses the shortfall, so a request left pending forever
     * would be a permanent free pass — pending and approved both suppress the
     * deduction. Generating payroll is the deadline: anything HR has not excused by
     * now is treated as not excused, which stamps the shortfall onto the log so the
     * deduction applies. HR has the whole cutoff to act, and reverting the payroll to
     * draft does not un-reject these — that is a deliberate manual decision.
     */
    private function resolvePendingShortfallRequests(int $employeeId, string $start, string $end): void
    {
        $pending = \App\Models\EmployeeRequest::where('employee_id', $employeeId)
            ->whereIn('request_type', ['half_day', 'undertime'])
            ->where('status', 'pending')
            ->get()
            ->filter(function ($req) use ($start, $end) {
                $date = $req->meta['date'] ?? null;
                return $date && $date >= $start && $date <= $end;
            });

        foreach ($pending as $req) {
            $req->update([
                'status'         => 'rejected',
                'response_notes' => 'Not excused before payroll generation for '
                    . $start . ' to ' . $end . ' — shortfall deducted automatically.',
            ]);

            $logId = $req->meta['attendance_log_id'] ?? null;
            if ($logId) {
                AttendanceLog::where('id', $logId)
                    ->where('employee_id', $employeeId)
                    ->whereNotIn('status', ['absent', 'on_leave', 'rest_day'])
                    ->update(['status' => $req->request_type]);
            }
        }
    }

    /**
     * Display a listing of payroll records.
     */
    public function index(Request $request)
    {
        $query = Payroll::with('employee')
            ->where('status', '!=', 'archived')
            ->whereHas('employee', function ($q) {
                $q->where(function ($q2) {
                    $q2->whereDoesntHave('user')->orWhereHas('user', fn($u) => $u->where('role', '!=', 'admin'));
                });
            });

        if ($request->has('cutoff_start') && $request->has('cutoff_end')) {
            $query->where('cutoff_start', $request->cutoff_start)
                ->where('cutoff_end', $request->cutoff_end);
        }

        if ($request->has('employee_id')) {
            $query->where('employee_id', $request->employee_id);
        }

        if ($request->has('group')) {
            $query->whereHas('employee', fn($q) => $q->where('group', $request->group));
        }

        $records = $query->orderBy('cutoff_end', 'desc')->get();

        return response()->json([
            'success' => true,
            'data' => $records,
            'message' => 'Payroll records retrieved',
        ]);
    }

    /**
     * Generate payroll for a specific cutoff period.
     */
    public function generate(Request $request)
    {
        $request->validate([
            'cutoff_start' => 'required|date',
            'cutoff_end' => 'required|date',
        ]);

        $start = $request->cutoff_start;
        $end = $request->cutoff_end;

        $frequency = \App\Models\SystemSettings::where('key', 'payroll_frequency')->value('value') ?? 'semi_monthly';
        $periods = $frequency === 'monthly' ? 1 : 2;

        $loanFloor = (float) \App\Models\SystemSettings::get('loan_min_net_pay_floor', 0);

        $employeeQuery = Employee::where('status', 'active')->where(function ($q) {
            $q->whereDoesntHave('user')->orWhereHas('user', fn($u) => $u->where('role', '!=', 'admin'));
        });
        if ($request->has('group') && $request->group !== '') {
            $employeeQuery->where('group', $request->group);
        }
        $employees = $employeeQuery->get();
        $generatedPayrolls = [];

        foreach ($employees as $employee) {
            // Skip if payroll already finalized or paid for this cutoff
            $existingPayroll = Payroll::where('employee_id', $employee->id)
                ->where('cutoff_start', $start)
                ->where('cutoff_end', $end)
                ->whereIn('status', ['finalized', 'paid'])
                ->first();
            
            if ($existingPayroll) {
                // Add to generated list but don't regenerate
                $generatedPayrolls[] = $existingPayroll->load('employee');
                continue;
            }

            // Not yet hired as of this cutoff → earned nothing for a period before their
            // hire date. Skip, and remove any stale (non-finalized) draft so regenerating
            // cleans up an erroneously-generated pre-hire payroll.
            if ($employee->hire_date && $employee->hire_date->gt(Carbon::parse($end))) {
                $stale = Payroll::where('employee_id', $employee->id)
                    ->where('cutoff_start', $start)
                    ->where('cutoff_end', $end)
                    ->whereNotIn('status', ['finalized', 'paid'])
                    ->first();
                if ($stale) {
                    \App\Services\LoanService::reverseForPayroll($stale->id);
                    $stale->delete();
                }
                continue;
            }

            // Regenerating a draft must reverse its prior loan charges first (idempotency)
            $existingDraft = Payroll::where('employee_id', $employee->id)
                ->where('cutoff_start', $start)
                ->where('cutoff_end', $end)
                ->first();

            if ($existingDraft) {
                \App\Services\LoanService::reverseForPayroll($existingDraft->id);
            }

            $this->resolvePendingShortfallRequests($employee->id, $start, $end);

            $logs = AttendanceLog::where('employee_id', $employee->id)
                ->whereBetween('date', [$start, $end])
                ->get();

            // Get latest schedule to determine work days and divisor.
            // Flexi templates only populate day_rules (no work_days), so derive from
            // day_rules first — falls back to work_days for legacy fixed templates.
            $latestSchedule = EmployeeSchedule::getCurrentForEmployee($employee->id);
            $latestTemplate = $latestSchedule?->template;
            if ($latestTemplate?->day_rules) {
                $workDays = collect($latestTemplate->day_rules)
                    ->filter(fn($rule) => !empty($rule['enabled']))
                    ->pluck('day')
                    ->map(fn($day) => (int) $day)
                    ->values()
                    ->all();
            } else {
                $workDays = $latestTemplate?->work_days ?? [1, 2, 3, 4, 5];
            }
            $daysInWeek = count($workDays);

            // HR Rule: Mon-Fri = 261 working days/year, Mon-Sat = 313 working days/year
            $divisor = ($daysInWeek <= 5) ? 261 : 313;

            $baseSalary = (float) $employee->salary;
            $isDaily = $employee->rate_type === 'daily';

            // Daily rate computation:
            //   Monthly: (base_salary * 12) / divisor
            //   Daily:   base_salary as-is (fixed per-day rate)
            $dailyRate = $isDaily ? $baseSalary : ($baseSalary * 12) / $divisor;
            $hourlyRate = $dailyRate / 8;

            $metrics = [
                'total_hours' => 0,
                'overtime_hours' => 0,
                'late_minutes' => 0,
                'undertime_minutes' => 0,
                'undertime_deduction' => 0,
                'rest_day_hours' => 0,
                'rest_day_pay' => 0,
                'rest_day_ot_hours' => 0,
                'absent_days' => 0,
                'paid_leave_days' => 0,
                'night_hours_regular' => 0,      // x1.00
                'night_hours_ot' => 0,           // x1.25
                'night_hours_rest_regular' => 0, // x1.30
                'night_hours_rest_ot' => 0,      // x1.69
            ];

            // Fetch approved leaves covering this cutoff — used to classify absent logs
            $approvedLeaves = \App\Models\LeaveRequest::with('leaveType')
                ->where('employee_id', $employee->id)
                ->where('status', 'approved')
                ->where('start_date', '<=', $end)
                ->where('end_date', '>=', $start)
                ->get();

            $daysWorkedCount = 0;
            $countedWorkDates = [];        // dates already counted in daysWorkedCount

            $dateOtHours = [];             // date → OT hours from attendance
            $attendanceUndertimeDates = []; // dates with attendance undertime > 0

            $events = \App\Models\CalendarEvent::whereBetween('event_date', [$start, $end])
                ->with('type')
                ->get()
                ->keyBy(fn($e) => $e->event_date->format('Y-m-d'));

            foreach ($logs as $log) {
                $dateStr = Carbon::parse($log->date)->format('Y-m-d');
                $date = Carbon::parse($log->date);
                $event = $events->get($dateStr);

                $schedule = EmployeeSchedule::getForEmployeeOnDate($employee->id, $date);
                $logTemplate = $schedule?->template;
                if (!$logTemplate && $log->schedule_template_id) {
                    // No active EmployeeSchedule row for this date (schedules get
                    // reassigned) — fall back to the template snapshotted on the
                    // log at clock-in time so history stays stable.
                    $logTemplate = \App\Models\ScheduleTemplate::find($log->schedule_template_id);
                }
                $isFlexiSchedule = ($log->schedule_type ?? $logTemplate?->type ?? 'fixed') === 'flexi';

                // Flexi: rest day is derived from the schedule ACTIVE ON THIS DATE (disabled
                // day_rule) — not the employee's current schedule, which may have been
                // reassigned since. Using the outer-scope $workDays (current schedule) here
                // would misclassify old rest days as working days once the day set changes.
                // Fixed: never inferred from the schedule — a day not assigned to a fixed
                // schedule is simply not scheduled, not paid rest-day work. Rest day pay for
                // fixed only applies when HR manually sets that status on the log.
                $logWorkDays = $workDays;
                if ($isFlexiSchedule && $logTemplate) {
                    $logWorkDays = $logTemplate->day_rules
                        ? collect($logTemplate->day_rules)
                            ->filter(fn($rule) => !empty($rule['enabled']))
                            ->pluck('day')
                            ->map(fn($day) => (int) $day)
                            ->values()
                            ->all()
                        : ($logTemplate->work_days ?? $workDays);
                }
                $isRestDay = $isFlexiSchedule
                    ? !in_array($date->dayOfWeek, $logWorkDays)
                    : $log->status === 'rest_day';

                // Track absences and half days for deduction purposes
                if ($log->status === 'absent') {
                    // Skip deduction if it's a holiday/event that doesn't count as absence
                    if ($event && $event->type && !$event->type->counts_as_absence) {
                        continue;
                    }
                    // Check if this date is covered by an approved leave request
                    $coveredLeave = $approvedLeaves->first(
                        fn($leave) => $dateStr >= $leave->start_date->format('Y-m-d')
                                   && $dateStr <= $leave->end_date->format('Y-m-d')
                    );
                    if ($coveredLeave) {
                        if ($coveredLeave->leaveType?->is_paid) {
                            $metrics['paid_leave_days']++;
                        } else {
                            $metrics['absent_days']++; // Unpaid leave: full deduction
                        }
                        continue;
                    }
                    $metrics['absent_days']++;
                    continue;
                }

                // Rest days only count in payroll when the employee GENUINELY worked them —
                // a real clock-in AND a self-initiated clock-out. Skip rest-day logs that were
                // never truly worked: an open punch (no clock-out) or one force-closed by
                // auto-clock-out. Such logs then neither pay nor deduct.
                // ponytail: a system close is identified by the '[System] Automatically clocked
                // out' marker auto-clock-out writes; clear that note on a log to re-include it.
                if ($isRestDay) {
                    $selfClockedOut = $log->clock_out_time
                        && !str_contains((string) $log->clock_out_notes, '[System] Automatically clocked out');
                    if (!$selfClockedOut) {
                        continue;
                    }
                }

                if ($isFlexiSchedule) {
                    $expectedHours = $logTemplate?->required_hours_per_day ?? 8;
                    $details = AttendanceService::calculateFlexiDetails(
                        $log->clock_in_time,
                        $log->clock_out_time,
                        $expectedHours
                    );
                    // Flexi has no fixed end time — undertime is purely hours-based.
                    // half_day is a label only; the hour shortfall still docks here.
                    // 'late' only docks late minutes (below) — undertime minutes
                    // apply once a rejected undertime request stamps the log.
                    $earlyDepartureMin = in_array($log->status, ['completed', 'late', 'overtime'])
                        ? 0
                        : $details['undertime_minutes'];
                } else {
                    // Resolve the DAY RULE for the log's date, not the template-level
                    // work_start_time/work_end_time (which only reflects the FIRST
                    // enabled day rule and is wrong for any other day on a mixed
                    // template — e.g. a Wed 22:00-06:00 night rule judged against a
                    // Mon 06:00-15:00 template-level start produces a phantom ~13h
                    // "late" deduction that wipes out the employee's pay).
                    $template = $logTemplate;

                    $dayRule = null;
                    if ($template && is_array($template->day_rules)) {
                        foreach ($template->day_rules as $rule) {
                            if ((int) ($rule['day'] ?? -1) === $date->dayOfWeek) {
                                $dayRule = $rule;
                                break;
                            }
                        }
                    }

                    $workStart = $dayRule['clock_in']  ?? $template?->work_start_time ?? '09:00:00';
                    $workEnd   = $dayRule['clock_out'] ?? $template?->work_end_time   ?? '18:00:00';

                    $workStartMin = $this->parseTimeToMinutes($workStart);
                    $workEndMin   = $this->parseTimeToMinutes($workEnd);
                    if ($workEndMin < $workStartMin) {
                        $workEndMin += 1440;
                    }
                    $expectedHours = ($workEndMin - $workStartMin) / 60;

                    $details = AttendanceService::calculateDetails(
                        $log->clock_in_time,
                        $log->clock_out_time,
                        $expectedHours,
                        $workStart,
                        $dayRule,
                        $workEnd
                    );

                    $earlyDepartureMin = 0;
                    // half_day is a label only — hours still dock as early departure.
                    // 'late' only docks late minutes (below).
                    if (!in_array($log->status, ['completed', 'late', 'overtime'])) {
                        $clockOutMin = $log->clock_out_time
                            ? $this->parseTimeToMinutes($log->clock_out_time)
                            : $this->parseTimeToMinutes($workEnd);
                        $earlyDepartureMin = max(0, $this->parseTimeToMinutes($workEnd) - $clockOutMin);
                    }
                }

                // Only count overtime hours if status is actually 'overtime' (not covered by grace
                // period) — except fixed-schedule rest days, where 'status' is already spent on the
                // manual rest_day flag, so hours beyond the expected day count as OT directly (fixed
                // has no separate OT-approval step that would otherwise promote status to 'overtime').
                $overtimeHours = ($log->status === 'overtime' || (!$isFlexiSchedule && $isRestDay))
                    ? $details['overtime_hours']
                    : 0;

                // Night differential follows clocked hours, not schedule type — accrues for
                // fixed, flexi, and rest-day logs alike (DOLE Art. 86). Night hours are bucketed
                // by the rate that applies to them: overtime is the chronological TAIL of the
                // shift, so the night hours inside that tail get the OT/rest-day-OT rate, and
                // the rest get the regular/rest-day rate. Reuses $overtimeHours (already gated
                // to APPROVED overtime above) so unapproved excess hours never get the OT rate.
                $totalNight = AttendanceService::calculateNightHours($log->clock_in_time, $log->clock_out_time);
                $otNight = $overtimeHours > 0
                    ? AttendanceService::calculateNightHours(
                        AttendanceService::shiftTimeBy($log->clock_out_time, $overtimeHours),
                        $log->clock_out_time
                    )
                    : 0.0;
                $otNight = min($otNight, $totalNight);
                $regularNight = max(0, $totalNight - $otNight);

                if ($isRestDay) {
                    $metrics['night_hours_rest_ot'] += $otNight;
                    $metrics['night_hours_rest_regular'] += $regularNight;
                } else {
                    $metrics['night_hours_ot'] += $otNight;
                    $metrics['night_hours_regular'] += $regularNight;
                }

                // Track per-date OT hours for request deduplication
                if (!$isRestDay && $details['overtime_hours'] > 0) {
                    $dateOtHours[$dateStr] = ($dateOtHours[$dateStr] ?? 0) + $details['overtime_hours'];
                }

                // Track dates with undertime for request deduplication
                if ($earlyDepartureMin > 0) {
                    $attendanceUndertimeDates[$dateStr] = true;
                }

                if ($isRestDay) {
                    // Rest day: regular pay is a day rate (like Base Pay), not an hourly
                    // rate — completing the required hours earns the full daily_rate * 1.30,
                    // prorated if they clocked out early. Hours beyond that only count once
                    // OT is approved (status === 'overtime') — while pending, the excess
                    // isn't paid at all yet.
                    $restRegularHours = min($details['hours_worked'], $expectedHours);
                    $metrics['rest_day_hours'] += $restRegularHours;
                    $metrics['rest_day_pay'] += $expectedHours > 0
                        ? ($restRegularHours / $expectedHours) * $dailyRate * 1.30
                        : 0;
                    $metrics['rest_day_ot_hours'] += $overtimeHours;
                } else {
                    $creditedHours = in_array($log->status, ['completed', 'overtime'], true)
                        ? $expectedHours
                        : $details['hours_worked'];
                    $metrics['total_hours'] += $creditedHours;
                    $metrics['overtime_hours'] += $overtimeHours;
                    if ($details['hours_worked'] > 0 || in_array($log->status, ['completed', 'overtime'], true)) {
                        $daysWorkedCount++;
                        $countedWorkDates[$dateStr] = true;
                    }
                }

                // Rest day pay is already prorated against hours worked (above) — late/
                // undertime deductions don't apply on top of that, since there's no
                // scheduled window to be late for or leave early from on a day off.
                if (!$isRestDay) {
                    // 'completed' means the grace period covered the deviation (see
                    // AttendanceService::calculateStatus) — calculateDetails()'s
                    // late_minutes is the raw pre-grace value, so it must be excluded
                    // here or grace-covered clock-ins still get docked.
                    if ($log->status !== 'completed') {
                        $metrics['late_minutes'] += $details['late_minutes'];
                    }
                    $metrics['undertime_minutes'] += $earlyDepartureMin;

                    // Flexi undertime is deducted at the employee's own required-hours rate
                    // (daily_rate / required_hours), not the flat /8 hourly rate — otherwise
                    // the deduction can exceed the full day's pay when required hours > 8.
                    $undertimeRate = ($isFlexiSchedule && $expectedHours > 0) ? ($dailyRate / $expectedHours) : $hourlyRate;
                    $metrics['undertime_deduction'] += ($earlyDepartureMin / 60) * $undertimeRate;
                }
            }

            // Count non-absence holidays on scheduled work days as paid days.
            // These have no AttendanceLog (employee didn't clock in) so the loop above misses them.
            $isLatestFlexiSchedule = ($latestSchedule?->template?->type ?? 'fixed') === 'flexi';
            if ($isLatestFlexiSchedule) {
                $holidayExpectedHours = $latestSchedule?->template?->required_hours_per_day ?? 8;
            } else {
                $holidayWorkStart = $latestSchedule?->template?->work_start_time ?? '09:00:00';
                $holidayWorkEnd   = $latestSchedule?->template?->work_end_time   ?? '18:00:00';
                $holidayStartMin  = $this->parseTimeToMinutes($holidayWorkStart);
                $holidayEndMin    = $this->parseTimeToMinutes($holidayWorkEnd);
                if ($holidayEndMin < $holidayStartMin) $holidayEndMin += 1440;
                $holidayExpectedHours = ($holidayEndMin - $holidayStartMin) / 60;
            }

            foreach ($events as $dateStr => $event) {
                if ($event->type && !$event->type->counts_as_absence) {
                    $holidayDate = Carbon::parse($dateStr);
                    if (in_array($holidayDate->dayOfWeek, $workDays) && !isset($countedWorkDates[$dateStr])) {
                        $daysWorkedCount++;
                        $metrics['total_hours'] += $holidayExpectedHours;
                    }
                }
            }

            // ── Employee Request Adjustments ─────────────────────────────
            // Build index of dates already handled by attendance logs
            $attendanceHalfDates = $logs->filter(fn($l) => $l->status === 'half_day')
                                        ->mapWithKeys(fn($l) => [Carbon::parse($l->date)->format('Y-m-d') => true]);
            // $dateOtHours and $attendanceUndertimeDates were populated in the first loop above

            // Only EMPLOYEE-INITIATED requests carry their own pay effect here: they are
            // filed ahead of time ("I need to leave at 3pm Friday") and have no attendance
            // log to read the deviation from. Auto-filed requests are the opposite — they
            // are raised FROM a log, and their decision is already recorded as that log's
            // status, so counting them here would double-deduct (a half_day log already
            // docks its hour shortfall as undertime).
            $approvedRequests = \App\Models\EmployeeRequest::where('employee_id', $employee->id)
                ->whereIn('request_type', ['overtime', 'half_day', 'undertime'])
                ->where('status', 'approved')
                ->get()
                ->filter(fn($r) => isset($r->meta['date'])
                    && empty($r->meta['auto_filed'])
                    && $r->meta['date'] >= $start
                    && $r->meta['date'] <= $end);

            $requestOvertimePay      = 0;
            $requestHalfDayDeduction = 0;
            $requestUndertimeMinutes = 0;

            foreach ($approvedRequests as $req) {
                $reqDate = $req->meta['date'];

                if ($req->request_type === 'overtime') {
                    $startTime = $req->meta['start_time'] ?? null;
                    $endTime   = $req->meta['end_time']   ?? null;
                    if ($startTime && $endTime) {
                        $reqOtHours    = Carbon::parse($startTime)->diffInMinutes(Carbon::parse($endTime)) / 60;
                        $attendOtHours = $dateOtHours[$reqDate] ?? 0;
                        // Add only the delta beyond what attendance already captured
                        $additionalOtHours = round(max(0, $reqOtHours - $attendOtHours), 1);
                        $requestOvertimePay += $additionalOtHours * ($dailyRate * 1.25 / 8);
                    }
                }

                if ($req->request_type === 'half_day' && !isset($attendanceHalfDates[$reqDate])) {
                    // No half_day attendance log for this date — add deduction
                    $requestHalfDayDeduction += $dailyRate / 2;
                }

                if ($req->request_type === 'undertime' && !isset($attendanceUndertimeDates[$reqDate])) {
                    // No undertime captured in attendance for this date — add from request
                    $departureTime = $req->meta['departure_time'] ?? null;
                    if ($departureTime) {
                        $schedule = EmployeeSchedule::getForEmployeeOnDate($employee->id, Carbon::parse($reqDate));
                        $scheduledEnd = $schedule?->template?->work_end_time ?? '18:00:00';
                        $scheduledEndMin  = $this->parseTimeToMinutes($scheduledEnd);
                        $departureMin     = $this->parseTimeToMinutes($departureTime);
                        $undertimeMins    = max(0, $scheduledEndMin - $departureMin);
                        $requestUndertimeMinutes += $undertimeMins;
                    }
                }
            }
            // ── End Request Adjustments ──────────────────────────────────

            // ── Gross Base ───────────────────────────────────────────────
            // Daily employees: paid per actual day worked
            // Monthly employees: base divided by number of pay periods
            $grossBase = $isDaily
                ? $dailyRate * $daysWorkedCount
                : $baseSalary / $periods;

            // ── Allowances / Premiums ─────────────────────────────────────
            $undeclaredSalary = (float) $employee->undeclared_salary;
            
            // For daily rate: undeclared_salary is THE compensation, no allowance
            // For monthly rate: undeclared_salary creates an allowance on top
            $undeclaredDiff = $undeclaredSalary > $baseSalary ? $undeclaredSalary - $baseSalary : 0;
            
            $undeclaredAllowance = $isDaily
                ? 0  // Daily rate: undeclared is not an allowance, it's the base rate
                : $undeclaredDiff / $periods;

            // OT Pay:          daily_rate * 1.25 / 8 * OT hours
            // Rest Day Pay:    daily_rate * 1.30, prorated by hours worked / required hours
            // Rest Day OT Pay: daily_rate * 1.69 / 8 * rest day OT hours
            $overtimePay = $metrics['overtime_hours'] * ($dailyRate * 1.25 / 8) + $requestOvertimePay;
            $restDayPay = $metrics['rest_day_pay'];
            $restDayOTPay = $metrics['rest_day_ot_hours'] * ($dailyRate * 1.69 / 8);
            // TEMPORARILY DISABLED — night differential figures were wrong; re-enable
            // by restoring the calculation below once the underlying issue is fixed.
            // $nightDiffPay =
            //       \App\Services\PayrollService::calculateNightDifferential($metrics['night_hours_regular'], $hourlyRate, 1.00)
            //     + \App\Services\PayrollService::calculateNightDifferential($metrics['night_hours_ot'], $hourlyRate, 1.25)
            //     + \App\Services\PayrollService::calculateNightDifferential($metrics['night_hours_rest_regular'], $hourlyRate, 1.30)
            //     + \App\Services\PayrollService::calculateNightDifferential($metrics['night_hours_rest_ot'], $hourlyRate, 1.69);
            // $totalNightHours = $metrics['night_hours_regular'] + $metrics['night_hours_ot']
            //     + $metrics['night_hours_rest_regular'] + $metrics['night_hours_rest_ot'];
            $nightDiffPay = 0.0;
            $totalNightHours = 0.0;

            // Paid leave: daily employees need explicit pay added back;
            // monthly employees already receive full salary so no adjustment needed.
            $leavePay = $isDaily ? $metrics['paid_leave_days'] * $dailyRate : 0;

            // ── Deductions ────────────────────────────────────────────────
            $lateDeduction = ($metrics['late_minutes'] / 60) * $hourlyRate;
            $undertimeDeduction = $metrics['undertime_deduction'] + (($requestUndertimeMinutes / 60) * $hourlyRate);
            $absentDeduction = $metrics['absent_days'] * $dailyRate;
            // Attendance half-day is a status mark; hours already dock via undertime.
            // Only employee-filed half-day requests with no log still use this lump.
            $halfDayDeduction = $requestHalfDayDeduction;

            // Gov't mandatory contributions — applied every cutoff
            // (HR deducts these on every payslip, not just end-of-month)
            // Daily rate: contributions based on undeclared_salary; Monthly: based on base_salary
            $contributionBasis = $isDaily ? $undeclaredSalary : $baseSalary;
            $sss = \App\Services\PayrollService::calculateSSS($contributionBasis, $periods);
            $philhealth = \App\Services\PayrollService::calculatePhilHealth($contributionBasis, $periods);
            $pagibig = \App\Services\PayrollService::calculatePagIBIG($contributionBasis, $periods);

            $totalAllowances = $overtimePay + $restDayPay + $restDayOTPay + $undeclaredAllowance + $leavePay + $nightDiffPay;
            $finalGross = $grossBase + $totalAllowances;

            // Withholding Tax Calculation
            // Taxable base excludes undeclared allowance (off-the-books, not subject to BIR withholding)
            // Night differential IS taxable compensation, so it belongs in the tax base.
            $taxableBase = $grossBase + $overtimePay + $restDayPay + $restDayOTPay + $leavePay + $nightDiffPay;
            $earnedTaxableBase = $taxableBase - ($lateDeduction + $undertimeDeduction + $absentDeduction + $halfDayDeduction);
            $taxableIncome = $earnedTaxableBase - ($sss + $philhealth + $pagibig);
            $wTax = \App\Services\PayrollService::calculateWithholdingTax($taxableIncome, $frequency);

            // ── Totals ────────────────────────────────────────────────────
            $totalDeductions = $lateDeduction + $undertimeDeduction
                + $absentDeduction + $halfDayDeduction
                + $sss + $philhealth + $pagibig + $wTax;

            $finalNet = max(0, round($finalGross - $totalDeductions, 2));

                    $deductions = array_filter([
                        'Late' => round($lateDeduction, 2),
                        'Undertime' => round($undertimeDeduction, 2),
                        'Absent' => round($absentDeduction, 2),
                        'Half Day' => round($halfDayDeduction, 2),
                        'SSS EE Contribution' => round($sss, 2),
                        'PhilHealth EE Contribution' => round($philhealth, 2),
                        'Pag-IBIG EE Contribution' => round($pagibig, 2),
                        'Withholding Tax' => round($wTax, 2),
                    ], fn($val) => $val > 0);

                    $allowances = array_filter([
                        ['label' => 'Overtime Pay', 'amount' => round($overtimePay, 2)],
                        ['label' => 'Rest Day Pay', 'amount' => round($restDayPay, 2)],
                        ['label' => 'Rest Day OT Pay', 'amount' => round($restDayOTPay, 2)],
                        ['label' => 'Allowance', 'amount' => round($undeclaredAllowance, 2)],
                        ['label' => 'Leave Pay', 'amount' => round($leavePay, 2)],
                        ['label' => 'Night Differential (' . round($totalNightHours, 2) . ' hrs)', 'amount' => round($nightDiffPay, 2)],
                    ], fn($a) => $a['amount'] > 0);

            $payroll = Payroll::updateOrCreate(
                [
                    'employee_id' => $employee->id,
                    'cutoff_start' => $start,
                    'cutoff_end' => $end,
                ],
                [
                    'base_salary' => $baseSalary,
                    'undeclared_salary' => $undeclaredSalary > $baseSalary ? $undeclaredSalary : null,
                    'daily_rate' => round($dailyRate, 2),
                    'total_hours' => round($metrics['total_hours'] + $metrics['rest_day_hours'], 2),
                    'days_worked' => $daysWorkedCount,
                    'overtime_hours' => round($metrics['overtime_hours'] + $metrics['rest_day_ot_hours'], 2),
                    'late_minutes' => $metrics['late_minutes'],
                    'undertime_minutes' => $metrics['undertime_minutes'],
                    'gross_pay' => round($finalGross, 2),
                    'deductions' => $deductions,
                    'allowances' => array_values($allowances), // Reset indices
                    'net_pay' => round($finalNet, 2),
                    'status' => 'draft',
                    'use_undeclared' => false,
                    'processed_at' => \App\Helpers\SystemClock::now(),
                ]
            );

            $loanResult = \App\Services\LoanService::chargeForPayroll(
                $employee->id,
                $start,
                $end,
                $payroll->id,
                (float) $payroll->net_pay,
                $loanFloor
            );

            if ($loanResult['total'] > 0) {
                $payroll->update([
                    'deductions' => array_merge($deductions, $loanResult['deductions']),
                    'net_pay' => max(0, round($payroll->net_pay - $loanResult['total'], 2)),
                ]);
            }

            $generatedPayrolls[] = $payroll->load('employee');
        }

        return response()->json([
            'success' => true,
            'data' => $generatedPayrolls,
            'message' => 'Payroll generated successfully using HR standard rules.',
        ]);
    }

    /**
     * Display a specific payroll record.
     */
    public function show(int $id)
    {
        $payroll = Payroll::with('employee')->findOrFail($id);

        return response()->json([
            'success' => true,
            'data' => $payroll,
        ]);
    }

    /**
     * Update payroll record (edit fields or change status).
     * Note: Finalized and paid payrolls cannot be edited.
     */
    public function update(Request $request, int $id)
    {
        $payroll = Payroll::findOrFail($id);

        // Prevent any updates to finalized or paid payrolls
        if (in_array($payroll->status, ['finalized', 'paid'])) {
            return response()->json([
                'success' => false,
                'message' => 'Cannot update finalized or paid payrolls. They are locked for audit purposes.',
            ], 422);
        }

        $request->validate([
            'status' => 'sometimes|in:draft,finalized',
            'base_salary' => 'sometimes|numeric',
            'gross_pay' => 'sometimes|numeric',
            'net_pay' => 'sometimes|numeric',
            'total_hours' => 'sometimes|numeric',
            'overtime_hours' => 'sometimes|numeric',
            'late_minutes' => 'sometimes|numeric',
            'undertime_minutes' => 'sometimes|numeric',
            'deductions' => 'sometimes|array',
            'allowances' => 'sometimes|array',
        ]);

        $data = $request->all();

        // Normalize deductions if they come as [{label, amount}] from frontend
        if (isset($data['deductions']) && is_array($data['deductions'])) {
            $normalized = [];
            foreach ($data['deductions'] as $key => $value) {
                if (is_array($value) && isset($value['label'])) {
                    $normalized[$value['label']] = $value['amount'];
                } else {
                    $normalized[$key] = $value;
                }
            }
            $data['deductions'] = $normalized;
        }

        $payroll->fill($data);

        if ($request->status === 'paid' && !$payroll->paid_at) {
            $payroll->paid_at = \App\Helpers\SystemClock::now();
        }

        $payroll->save();

        return response()->json([
            'success' => true,
            'data' => $payroll->load('employee'),
            'message' => 'Payroll record updated successfully.',
        ]);
    }

    /**
     * Export payroll to Excel file (use frontend export button instead).
     */
    public function export(int $id)
    {
        return response()->json([
            'success' => false,
            'message' => 'Please use the export button on the frontend to download paystubs.',
        ], 400);
    }

    /**
     * Send paystubs to selected employees and mark as paid.
     * Expects the paystub file to be sent from frontend with optional CC/BCC emails.
     */
    public function sendPaystubs(Request $request)
    {
        $request->validate([
            'payroll_ids' => 'required|array|min:1',
            'payroll_ids.*' => 'integer|exists:payrolls,id',
            'files' => 'required|array',
            'files.*' => 'file|mimes:xlsx,xls',
            'cc_emails' => 'sometimes|array',
            'cc_emails.*' => 'email',
            'bcc_emails' => 'sometimes|array',
            'bcc_emails.*' => 'email',
        ]);

        $payrolls = Payroll::with('employee')
            ->whereIn('id', $request->payroll_ids)
            ->where('status', 'finalized')
            ->get()
            ->keyBy('id');

        if ($payrolls->isEmpty()) {
            return response()->json([
                'success' => false,
                'message' => 'No finalized payrolls found to send.',
            ], 422);
        }

        $sent = [];
        $failed = [];
        $uploadedFiles = $request->file('files') ?? [];
        $ccEmails = $request->input('cc_emails', []);
        $bccEmails = $request->input('bcc_emails', []);

        foreach ($request->payroll_ids as $index => $payrollId) {
            $payroll = $payrolls->get($payrollId);
            if (!$payroll) {
                $failed[] = [
                    'payroll_id' => $payrollId,
                    'employee' => null,
                    'error' => 'Payroll not found or not finalized',
                ];
                continue;
            }
            try {
                // Validate employee has email
                if (!$payroll->employee?->email) {
                    $failed[] = [
                        'payroll_id' => $payroll->id,
                        'employee' => $payroll->employee?->full_name,
                        'error' => 'No email address on file',
                    ];
                    continue;
                }

                // Get the corresponding file from the uploaded files
                $file = $uploadedFiles[$index] ?? null;
                if (!$file) {
                    $failed[] = [
                        'payroll_id' => $payroll->id,
                        'employee' => $payroll->employee?->full_name,
                        'error' => 'Paystub file not provided',
                    ];
                    continue;
                }

                // Send email with attachment
                $mail = Mail::to($payroll->employee->email);
                
                if (!empty($ccEmails)) {
                    $mail->cc($ccEmails);
                }
                
                if (!empty($bccEmails)) {
                    $mail->bcc($bccEmails);
                }
                
                $mail->send(new \App\Mail\PaystubMail($payroll, $file->getRealPath()));

                // Mark as paid
                $payroll->update([
                    'status' => 'paid',
                    'paid_at' => \App\Helpers\SystemClock::now(),
                ]);

                $sent[] = [
                    'payroll_id' => $payroll->id,
                    'employee' => $payroll->employee->full_name,
                    'email' => $payroll->employee->email,
                ];
            } catch (\Exception $e) {
                $failed[] = [
                    'payroll_id' => $payroll->id,
                    'employee' => $payroll->employee?->full_name,
                    'error' => $e->getMessage(),
                ];
            }
        }

        return response()->json([
            'success' => count($failed) === 0,
            'data' => [
                'sent' => $sent,
                'failed' => $failed,
            ],
            'message' => count($sent) . ' paystub(s) sent successfully. ' . (count($failed) > 0 ? count($failed) . ' failed.' : ''),
        ]);
    }

    /**
     * Revert a finalized payroll back to draft status.
     * Only allowed if payroll has not been marked as paid.
     */
    public function revertToDraft(int $id)
    {
        $payroll = Payroll::findOrFail($id);

        // Only allow reverting finalized payrolls, not paid ones
        if ($payroll->status === 'paid') {
            return response()->json([
                'success' => false,
                'message' => 'Cannot revert a payroll that has already been marked as paid.',
            ], 422);
        }

        if ($payroll->status !== 'finalized') {
            return response()->json([
                'success' => false,
                'message' => 'Only finalized payrolls can be reverted to draft.',
            ], 422);
        }

        try {
            $payroll->update([
                'status' => 'draft',
                'paid_at' => null, // Clear the paid timestamp if any
            ]);

            return response()->json([
                'success' => true,
                'data' => $payroll->load('employee'),
                'message' => 'Payroll reverted to draft status successfully.',
            ]);
        } catch (\Exception $e) {
            return response()->json([
                'success' => false,
                'message' => 'Failed to revert payroll: ' . $e->getMessage(),
            ], 500);
        }
    }

    /**
     * Toggle undertime calculation between base salary and undeclared salary.
     * Recalculates deductions and net pay accordingly.
     */
    public function toggleUndertimeCalculation(Request $request, int $id)
    {
        $payroll = Payroll::with('employee')->findOrFail($id);

        // Only allowed for draft payrolls
        if ($payroll->status !== 'draft') {
            return response()->json([
                'success' => false,
                'message' => 'Only draft payrolls can have their calculation method changed.',
            ], 422);
        }

        // Check if undeclared salary exists
        if (!$payroll->undeclared_salary) {
            return response()->json([
                'success' => false,
                'message' => 'This employee does not have an undeclared salary configured.',
            ], 422);
        }

        // Calculate the appropriate salary to use for deductions
        $salaryForDeductions = $payroll->use_undeclared 
            ? $payroll->base_salary 
            : $payroll->undeclared_salary;

        // Recalculate daily and hourly rates. NOTE: Employee::schedule is an array-returning
        // accessor, not a relation — ->template on it always resolves to null, so this must
        // go through EmployeeSchedule::getCurrentForEmployee() like generate() does, not
        // $payroll->employee->schedule.
        $currentSchedule = EmployeeSchedule::getCurrentForEmployee($payroll->employee_id);
        $currentTemplate = $currentSchedule?->template;
        if ($currentTemplate?->day_rules) {
            $workDays = collect($currentTemplate->day_rules)
                ->filter(fn($rule) => !empty($rule['enabled']))
                ->pluck('day')
                ->map(fn($day) => (int) $day)
                ->values()
                ->all();
        } else {
            $workDays = $currentTemplate?->work_days ?? [1, 2, 3, 4, 5];
        }
        $daysInWeek = count($workDays);
        $divisor = ($daysInWeek <= 5) ? 261 : 313;

        $isDaily = $payroll->employee->rate_type === 'daily';
        $dailyRate = $isDaily ? $salaryForDeductions : ($salaryForDeductions * 12) / $divisor;
        $hourlyRate = $dailyRate / 8;

        // Recalculate deductions based on new daily/hourly rate
        $newUndertimeDeduction = ($payroll->undertime_minutes / 60) * $hourlyRate;
        $newLateDeduction = ($payroll->late_minutes / 60) * $hourlyRate;
        
        // Calculate absent days from deductions (if present)
        $deductions = is_array($payroll->deductions) ? $payroll->deductions : [];
        $oldAbsentDeduction = (float)($deductions['Absent'] ?? 0);
        $absentDays = ($oldAbsentDeduction > 0 && $payroll->daily_rate > 0) ? $oldAbsentDeduction / $payroll->daily_rate : 0;
        $newAbsentDeduction = $absentDays * $dailyRate;

        // Calculate half day deduction
        $oldHalfDayDeduction = (float)($deductions['Half Day'] ?? 0);
        $halfDays = $oldHalfDayDeduction > 0 ? $oldHalfDayDeduction / (($payroll->daily_rate ?: 1) / 2) : 0;
        $newHalfDayDeduction = $halfDays * ($dailyRate / 2);

        // Update all affected deductions
        $deductions['Undertime'] = round($newUndertimeDeduction, 2);
        $deductions['Late'] = round($newLateDeduction, 2);
        
        if ($newAbsentDeduction > 0) {
            $deductions['Absent'] = round($newAbsentDeduction, 2);
        } else {
            unset($deductions['Absent']);
        }

        if ($newHalfDayDeduction > 0) {
            $deductions['Half Day'] = round($newHalfDayDeduction, 2);
        } else {
            unset($deductions['Half Day']);
        }

        // Recalculate Withholding Tax
        // Exclude undeclared allowance ("Allowance" label) from taxable base — it's off-the-books
        $payFrequency = \App\Models\SystemSettings::where('key', 'payroll_frequency')->value('value') ?? 'semi_monthly';

        $sss = (float)($deductions['SSS EE Contribution'] ?? 0);
        $philhealth = (float)($deductions['PhilHealth EE Contribution'] ?? 0);
        $pagibig = (float)($deductions['Pag-IBIG EE Contribution'] ?? 0);

        $allowances = is_array($payroll->allowances) ? $payroll->allowances : [];
        $undeclaredAmt = collect($allowances)->where('label', 'Allowance')->sum('amount');
        $taxableGross = $payroll->gross_pay - $undeclaredAmt;
        $earnedGross = $taxableGross - ($deductions['Late'] + $deductions['Undertime'] + ($deductions['Absent'] ?? 0) + ($deductions['Half Day'] ?? 0));
        $taxableIncome = $earnedGross - ($sss + $philhealth + $pagibig);
        $wTax = \App\Services\PayrollService::calculateWithholdingTax($taxableIncome, $payFrequency);
        
        if ($wTax > 0) {
            $deductions['Withholding Tax'] = round($wTax, 2);
        } else {
            unset($deductions['Withholding Tax']);
        }

        // Remove zero deductions
        foreach ($deductions as $key => $value) {
            if ($value <= 0) {
                unset($deductions[$key]);
            }
        }

        // Recalculate totals
        $totalDeductions = array_sum($deductions);
        $newNetPay = $payroll->gross_pay - $totalDeductions;

        // Toggle the flag and save
        $payroll->update([
            'use_undeclared' => !$payroll->use_undeclared,
            'daily_rate' => round($dailyRate, 2),
            'deductions' => $deductions,
            'net_pay' => round($newNetPay, 2),
        ]);

        return response()->json([
            'success' => true,
            'data' => $payroll->load('employee'),
            'message' => 'Deduction calculations toggled successfully. Now using ' .
                        ($payroll->use_undeclared ? 'undeclared' : 'base') . ' salary for late, undertime, and absent deductions',
        ]);
    }

}