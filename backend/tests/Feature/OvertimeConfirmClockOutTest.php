<?php

namespace Tests\Feature;

use App\Models\AttendanceLog;
use App\Models\Employee;
use App\Models\EmployeeRequest;
use App\Models\EmployeeSchedule;
use App\Models\ScheduleTemplate;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class OvertimeConfirmClockOutTest extends TestCase
{
    use RefreshDatabase;

    private function buildMondayDayRules(string $clockIn, string $clockOut, bool $graceEnabled = true): array
    {
        $rules = [];
        for ($day = 0; $day <= 6; $day++) {
            $enabled = $day === 1;
            $rules[] = [
                'day'            => $day,
                'enabled'        => $enabled,
                'clock_in'       => $enabled ? $clockIn : null,
                'clock_out'      => $enabled ? $clockOut : null,
                'grace_enabled'  => $enabled && $graceEnabled,
                'grace_type'     => '-/+',
                'grace_minutes'  => 15,
            ];
        }

        return $rules;
    }

    private function makeEmployee(string $suffix): Employee
    {
        return Employee::create([
            'employee_id' => "EMP-OTC-{$suffix}",
            'first_name'  => 'Ot',
            'last_name'   => "Confirm{$suffix}",
            'email'       => "ot-confirm-{$suffix}@example.com",
            'position'    => 'Tester',
            'hire_date'   => '2026-01-01',
            'salary'      => 20000,
            'status'      => 'active',
        ]);
    }

    private function makeLinkedEmployee(string $suffix): array
    {
        $user = User::factory()->create([
            'role'  => 'employee',
            'email' => "ot-confirm-user-{$suffix}@example.com",
        ]);

        $employee = $this->makeEmployee($suffix);
        $employee->update(['user_id' => $user->id, 'email' => $user->email]);

        return [$user, $employee->fresh()];
    }

    private function makeFixedTemplate(): ScheduleTemplate
    {
        return ScheduleTemplate::create([
            'type'                   => 'fixed',
            'name'                   => 'Fixed 9-5 Grace',
            'work_days'              => [1, 2, 3, 4, 5],
            'day_rules'              => $this->buildMondayDayRules('09:00:00', '17:00:00'),
            'start_time'             => '09:00:00',
            'end_time'               => '17:00:00',
            'work_start_time'        => '09:00:00',
            'work_end_time'          => '17:00:00',
            'required_hours_per_day' => 8,
        ]);
    }

    private function assignSchedule(Employee $employee, ScheduleTemplate $template): void
    {
        EmployeeSchedule::create([
            'employee_id'          => $employee->id,
            'schedule_template_id' => $template->id,
            'start_date'           => '2026-01-01',
            'end_date'             => '2026-01-31',
            'status'               => 'active',
        ]);
    }

    private function clockIn(Employee $employee, User $actor): void
    {
        $this->actingAs($actor)->postJson('/api/attendance/clock-in', [
            'employee_id' => $actor->isAdminOrHr() ? $employee->id : null,
        ])->assertCreated();
    }

    public function test_clock_out_past_grace_requires_ot_confirm_before_persisting()
    {
        [$user, $employee] = $this->makeLinkedEmployee('A');
        $this->assignSchedule($employee, $this->makeFixedTemplate());

        $this->travelTo(Carbon::parse('2026-01-05 09:00:00'));
        $this->clockIn($employee, $user);

        $this->travelTo(Carbon::parse('2026-01-05 18:00:00'));
        $response = $this->actingAs($user)->postJson('/api/attendance/clock-out');

        $response->assertStatus(422)
            ->assertJsonPath('ot_confirm_required', true)
            ->assertJsonPath('data.overtime_hours', 0.8);

        $log = AttendanceLog::where('employee_id', $employee->id)->sole();
        $this->assertNull($log->clock_out_time);
        $this->assertSame(0, EmployeeRequest::count());
    }

    public function test_declining_ot_confirm_clocks_out_without_request()
    {
        [$user, $employee] = $this->makeLinkedEmployee('B');
        $this->assignSchedule($employee, $this->makeFixedTemplate());

        $this->travelTo(Carbon::parse('2026-01-05 09:00:00'));
        $this->clockIn($employee, $user);

        $this->travelTo(Carbon::parse('2026-01-05 18:00:00'));
        $this->actingAs($user)->postJson('/api/attendance/clock-out', [
            'file_overtime_request' => false,
        ])->assertOk();

        $log = AttendanceLog::where('employee_id', $employee->id)->sole();
        $this->assertSame('18:00:00', $log->clock_out_time);
        $this->assertSame('completed', $log->status);
        $this->assertSame(0, EmployeeRequest::count());
    }

    public function test_accepting_ot_confirm_files_pending_request()
    {
        [$user, $employee] = $this->makeLinkedEmployee('C');
        $this->assignSchedule($employee, $this->makeFixedTemplate());

        $this->travelTo(Carbon::parse('2026-01-05 09:00:00'));
        $this->clockIn($employee, $user);

        $this->travelTo(Carbon::parse('2026-01-05 18:00:00'));
        $this->actingAs($user)->postJson('/api/attendance/clock-out', [
            'file_overtime_request' => true,
        ])->assertOk();

        $request = EmployeeRequest::where('employee_id', $employee->id)->sole();
        $this->assertSame('overtime', $request->request_type);
        $this->assertSame('pending', $request->status);
        $this->assertTrue($request->meta['auto_filed']);
        $this->assertEquals(0.8, $request->meta['overtime_hours']);
    }

    public function test_hr_is_overtime_override_bypasses_ot_confirm()
    {
        $employee = $this->makeEmployee('D');
        $this->assignSchedule($employee, $this->makeFixedTemplate());
        $admin = User::factory()->create(['role' => 'admin']);

        $this->travelTo(Carbon::parse('2026-01-05 09:00:00'));
        $this->clockIn($employee, $admin);

        $this->travelTo(Carbon::parse('2026-01-05 18:00:00'));
        $this->actingAs($admin)->postJson('/api/attendance/clock-out', [
            'employee_id' => $employee->id,
            'is_overtime' => true,
        ])->assertOk();

        $log = AttendanceLog::where('employee_id', $employee->id)->sole();
        $this->assertSame('overtime', $log->status);
        $this->assertSame(0, EmployeeRequest::count());
    }

    public function test_undertime_still_auto_files_without_ot_confirm()
    {
        [$user, $employee] = $this->makeLinkedEmployee('E');
        $this->assignSchedule($employee, $this->makeFixedTemplate());

        $this->travelTo(Carbon::parse('2026-01-05 09:00:00'));
        $this->clockIn($employee, $user);

        $this->travelTo(Carbon::parse('2026-01-05 14:00:00'));
        $this->actingAs($user)->postJson('/api/attendance/clock-out', [
            'confirm_early_clock_out' => true,
        ])->assertOk();

        $request = EmployeeRequest::where('employee_id', $employee->id)->sole();
        $this->assertSame('undertime', $request->request_type);
    }

    public function test_flexi_overtime_requires_confirm()
    {
        [$user, $employee] = $this->makeLinkedEmployee('F');
        $template = ScheduleTemplate::create([
            'type'                   => 'flexi',
            'name'                   => 'Flexi 8h',
            'work_days'              => [1, 2, 3, 4, 5],
            'day_rules'              => $this->buildMondayDayRules('09:00:00', '17:00:00', false),
            'required_hours_per_day' => 8,
        ]);
        $this->assignSchedule($employee, $template);

        $this->travelTo(Carbon::parse('2026-01-05 08:00:00'));
        $this->clockIn($employee, $user);

        $this->travelTo(Carbon::parse('2026-01-05 18:00:00'));
        $this->actingAs($user)->postJson('/api/attendance/clock-out')
            ->assertStatus(422)
            ->assertJsonPath('ot_confirm_required', true);
    }
}
