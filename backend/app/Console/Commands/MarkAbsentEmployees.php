<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use App\Models\AttendanceLog;
use App\Models\CalendarEvent;
use App\Models\Employee;
use App\Models\EmployeeSchedule;
use App\Models\LeaveRequest;
use App\Helpers\SystemClock;
use App\Services\HolidayAttendanceService;
use Illuminate\Support\Carbon;

class MarkAbsentEmployees extends Command
{
    protected $signature = 'attendance:mark-absent {date?} {--to=} {--employee=}';
    protected $description = 'Scan for scheduled working days with no attendance log and mark them as absent';

    public function handle(HolidayAttendanceService $holidayAttendance)
    {
        $dateInput = $this->argument('date');
        $toInput   = $this->option('to');
        $employeeId = $this->option('employee');

        if ($dateInput) {
            $startDate = Carbon::parse($dateInput)->startOfDay();
            $endDate = $toInput ? Carbon::parse($toInput)->startOfDay() : $startDate->copy();
        } else {
            $now = SystemClock::now();
            $anchor = ($now->hour < 4)
                ? $now->copy()->subDay()->startOfDay()
                : $now->copy()->startOfDay();
            $startDate = $anchor->copy()->subDay();
            $endDate = $toInput ? Carbon::parse($toInput)->startOfDay() : $anchor->copy();
        }

        // Build date range
        $dates = [];
        for ($d = $startDate->copy(); $d->lte($endDate); $d->addDay()) {
            $dates[] = $d->toDateString();
        }

        $employeeQuery = Employee::where('status', 'active');
        if ($employeeId) {
            $employeeQuery->where('id', $employeeId);
        }
        $employees = $employeeQuery->get();

        $statusByEmployeeDate = [];
        if ($dates !== []) {
            $windowStart = Carbon::parse($dates[0])->subDay()->toDateString();
            $windowEnd = Carbon::parse(end($dates))->addDay()->toDateString();
            $adjacentLogs = AttendanceLog::whereIn('employee_id', $employees->pluck('id'))
                ->whereBetween('date', [$windowStart, $windowEnd])
                ->get(['employee_id', 'date', 'status']);
            foreach ($adjacentLogs as $log) {
                $statusByEmployeeDate[$log->employee_id][Carbon::parse($log->date)->format('Y-m-d')] = $log->status;
            }
        }

        foreach ($dates as $dateStr) {
            $targetDate = Carbon::parse($dateStr);
            $this->info("Scanning for absences on: " . $dateStr);

        foreach ($employees as $employee) {
            // Skip if an attendance log already exists for this date
            $exists = AttendanceLog::where('employee_id', $employee->id)
                ->where('date', $targetDate->toDateString())
                ->exists();

            if ($exists) continue;

            $onLeave = LeaveRequest::where('employee_id', $employee->id)
                ->where('status', 'approved')
                ->where('start_date', '<=', $targetDate->toDateString())
                ->where('end_date', '>=', $targetDate->toDateString())
                ->exists();

            if ($onLeave) continue;

            $isHoliday = CalendarEvent::where('event_date', $targetDate->toDateString())
                ->whereHas('type', function ($q) {
                    $q->where('counts_as_absence', false);
                })->exists();

            $schedule = EmployeeSchedule::getForEmployeeOnDate($employee->id, $targetDate);
            if (!$schedule || !$schedule->template) continue;

            $template = $schedule->template;
            $dayOfWeek = $targetDate->dayOfWeek;
            
            $isWorkingDay = false;
            $dayRule = null;
            if ($template->day_rules) {
                foreach ($template->day_rules as $rule) {
                    if ($rule['day'] == $dayOfWeek) {
                        $dayRule = $rule;
                        if ($rule['enabled']) {
                            $isWorkingDay = true;
                        }
                        break;
                    }
                }
            } elseif ($template->work_days) {
                if (in_array($dayOfWeek, $template->work_days)) {
                    $isWorkingDay = true;
                }
            } else {
                // Flexi templates with no day config default to Mon–Fri
                $isWorkingDay = $dayOfWeek >= Carbon::MONDAY && $dayOfWeek <= Carbon::FRIDAY;
            }

            if ($isWorkingDay && $template->wrapsMidnight($dayRule)) {
                // Shift started on $targetDate and ends the next calendar day.
                $shiftEnd = $targetDate->copy()->addDay()
                    ->setTimeFrom(Carbon::parse($template->shiftEndFor($dayRule)));
                if (SystemClock::now()->lt($shiftEnd)) {
                    continue;
                }
            }

            if ($isWorkingDay) {
                $status = 'absent';
                $notes = '[System] Automatically marked absent.';
                if ($isHoliday && !$holidayAttendance->isSandwiched($employee->id, $dateStr, $statusByEmployeeDate)) {
                    $status = 'holiday';
                    $notes = '[System] Automatically marked holiday.';
                }

                AttendanceLog::create([
                    'employee_id' => $employee->id,
                    'date' => $targetDate->toDateString(),
                    'status' => $status,
                    'schedule_template_id' => $template->id,
                    'schedule_template_name' => $template->name,
                    'clock_in_notes' => $notes,
                ]);
                $statusByEmployeeDate[$employee->id][$dateStr] = $status;
            }
        }
        } // end foreach $dates
        $this->info('Absentee marking completed.');
    }
}
