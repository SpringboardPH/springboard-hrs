<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use App\Models\AttendanceLog;
use App\Models\Employee;
use App\Models\EmployeeSchedule;
use Illuminate\Support\Carbon;

class AutoClockOut extends Command
{
    protected $signature = 'attendance:auto-clock-out';
    protected $description = 'Automatically clock out employees who missed their departure window';

    public function handle()
    {
        if (!\App\Models\SystemSettings::get('auto_clock_out_enabled', true)) {
            $this->info('Auto clock-out is disabled in system settings. Skipping.');
            return;
        }

        $employees = Employee::all();
        foreach ($employees as $employee) {
            $this->performAutoClockOut($employee->id);
        }
        $this->info('Auto clock-out completed.');
    }

    private function performAutoClockOut(int $employeeId)
    {
        // ponytail: this command is INCOMPATIBLE with overnight shifts and is only safe
        // because `auto_clock_out_enabled` is currently off (see handle()). Re-enabling it
        // will guillotine every night shift: it force-closes open logs at 23:59, so an
        // employee two hours into a 22:00-06:00 shift is clocked out mid-shift and paid
        // for ~2 hours instead of 8.
        // Before flipping that setting back on, this method must learn about:
        //   - fixed/night templates: skip logs where $template->wrapsMidnight($dayRule) is
        //     true and the shift has not ended; close an abandoned one at
        //     $template->shiftEndFor($dayRule) rather than 23:59.
        //   - flexi: has NO end time, so "still working" and "forgot to clock out" are
        //     indistinguishable at 23:59. Needs its own rule (e.g. defer while hours worked
        //     < required_hours_per_day) — that is an open product decision, not just code.
        //
        // This command runs at 23:59 PM daily, so we always clock out any open logs
        $openLogs = AttendanceLog::where('employee_id', $employeeId)
            ->whereNotNull('clock_in_time')
            ->whereNull('clock_out_time')
            ->get();

        foreach ($openLogs as $log) {
            /** @var AttendanceLog $log */
            $date = Carbon::parse($log->date);
            $schedule = EmployeeSchedule::getForEmployeeOnDate($employeeId, $date);
            if (!$schedule || !$schedule->template) continue;

            // Always use 23:59:00 (11:59 PM) for the clock-out time.
            // A 23:59 force-close means the employee forgot to clock out, so neither the
            // overtime nor the shortfall it implies is real. Status is always completed.
            // No deviation request is filed here, by design.
            $log->update([
                'clock_out_time' => '23:59:00',
                'status'         => 'completed',
                'clock_out_notes' => ($log->clock_out_notes ? $log->clock_out_notes . "\n" : '') . '[System] Automatically clocked out due to missed departure window.',
            ]);
        }
    }
}
