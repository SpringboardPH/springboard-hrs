<?php

namespace Tests\Feature;

use App\Models\AttendanceLog;
use App\Models\Employee;
use App\Models\EmployeeSchedule;
use App\Models\ScheduleTemplate;
use App\Models\SystemSettings;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class AutoClockOutFlexiTest extends TestCase
{
    use RefreshDatabase;

    public function test_flexi_employee_who_forgets_to_clock_out_is_closed_without_crashing()
    {
        SystemSettings::set('auto_clock_out_enabled', true, null, 'boolean');

        $employee = Employee::create([
            'employee_id' => 'EMP-FLEXI-1',
            'first_name'  => 'Flexi',
            'last_name'   => 'Worker',
            'email'       => 'flexi-worker@example.com',
            'position'    => 'Tester',
            'hire_date'   => '2026-01-01',
            'salary'      => 20000,
            'status'      => 'active',
        ]);

        $template = ScheduleTemplate::create([
            'type'                    => 'flexi',
            'name'                    => 'Flexi 8h',
            'work_days'               => [1, 2, 3, 4, 5],
            'day_rules'               => [['day' => 1, 'enabled' => true]],
            // legacy required columns, unused for flexi
            'start_time'              => '09:00:00',
            'end_time'                => '17:00:00',
            'required_hours_per_day'  => 8,
        ]);

        EmployeeSchedule::create([
            'employee_id'           => $employee->id,
            'schedule_template_id'  => $template->id,
            'start_date'            => '2026-01-05',
            'end_date'              => '2026-01-11',
            'status'                => 'active',
        ]);

        // Clocked in but forgot to clock out; worked "16h" by the time the
        // cron force-closes at 23:59 — far more than the 8h required.
        $log = AttendanceLog::create([
            'employee_id'    => $employee->id,
            'date'           => '2026-01-05', // Monday
            'clock_in_time'  => '08:00:00',
            'clock_out_time' => null,
        ]);

        $this->artisan('attendance:auto-clock-out')->assertExitCode(0);

        $log->refresh();
        $this->assertSame('23:59:00', $log->clock_out_time);
        // Must be capped, not 'overtime' — matches the fixed-schedule cap behavior.
        $this->assertSame('completed', $log->status);
    }

    public function test_flexi_late_start_force_close_is_completed_not_undertime()
    {
        SystemSettings::set('auto_clock_out_enabled', true, null, 'boolean');

        $employee = Employee::create([
            'employee_id' => 'EMP-FLEXI-2',
            'first_name'  => 'Late',
            'last_name'   => 'Flexi',
            'email'       => 'late-flexi@example.com',
            'position'    => 'Tester',
            'hire_date'   => '2026-01-01',
            'salary'      => 20000,
            'status'      => 'active',
        ]);

        $template = ScheduleTemplate::create([
            'type'                   => 'flexi',
            'name'                   => 'Flexi 8h',
            'work_days'              => [1, 2, 3, 4, 5],
            'day_rules'              => [['day' => 1, 'enabled' => true]],
            'start_time'             => '09:00:00',
            'end_time'               => '17:00:00',
            'required_hours_per_day' => 8,
        ]);

        EmployeeSchedule::create([
            'employee_id'          => $employee->id,
            'schedule_template_id' => $template->id,
            'start_date'           => '2026-01-05',
            'end_date'             => '2026-01-11',
            'status'               => 'active',
        ]);

        // 18:00→23:59 is under 8h; raw flexi math would say undertime, but a
        // force-close is not a real shortfall.
        $log = AttendanceLog::create([
            'employee_id'    => $employee->id,
            'date'           => '2026-01-05',
            'clock_in_time'  => '18:00:00',
            'clock_out_time' => null,
        ]);

        $this->artisan('attendance:auto-clock-out')->assertExitCode(0);

        $log->refresh();
        $this->assertSame('23:59:00', $log->clock_out_time);
        $this->assertSame('completed', $log->status);
    }

    public function test_fixed_late_arrival_force_close_is_completed_not_undertime()
    {
        SystemSettings::set('auto_clock_out_enabled', true, null, 'boolean');

        $employee = Employee::create([
            'employee_id' => 'EMP-FIXED-1',
            'first_name'  => 'Late',
            'last_name'   => 'Fixed',
            'email'       => 'late-fixed@example.com',
            'position'    => 'Tester',
            'hire_date'   => '2026-01-01',
            'salary'      => 20000,
            'status'      => 'active',
        ]);

        $template = ScheduleTemplate::create([
            'type'                   => 'fixed',
            'name'                   => 'Fixed 9-18',
            'work_days'              => [1, 2, 3, 4, 5],
            'day_rules'              => [[
                'day' => 1,
                'enabled' => true,
                'clock_in' => '09:00:00',
                'clock_out' => '18:00:00',
                'grace_enabled' => true,
                'grace_type' => '-/+',
                'grace_minutes' => 15,
            ]],
            'start_time'             => '09:00:00',
            'end_time'               => '18:00:00',
            'required_hours_per_day' => 9,
        ]);

        EmployeeSchedule::create([
            'employee_id'          => $employee->id,
            'schedule_template_id' => $template->id,
            'start_date'           => '2026-01-05',
            'end_date'             => '2026-01-11',
            'status'               => 'active',
        ]);

        // 11:00 in + regular hours capped at schedule end → undertime under
        // evaluateFixed; force-close must not invent that shortfall.
        $log = AttendanceLog::create([
            'employee_id'    => $employee->id,
            'date'           => '2026-01-05',
            'clock_in_time'  => '11:00:00',
            'clock_out_time' => null,
            'schedule_type'  => 'fixed',
        ]);

        $this->artisan('attendance:auto-clock-out')->assertExitCode(0);

        $log->refresh();
        $this->assertSame('23:59:00', $log->clock_out_time);
        $this->assertSame('completed', $log->status);
    }
}
