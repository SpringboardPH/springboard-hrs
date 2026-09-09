<?php

namespace Tests\Feature;

use App\Models\AttendanceLog;
use App\Models\Employee;
use App\Models\EmployeeSchedule;
use App\Models\ScheduleTemplate;
use App\Models\User;
use App\Services\AttendanceService;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class FlexiOvernightClockOutTest extends TestCase
{
    use RefreshDatabase;

    private function weekdayRules(): array
    {
        $rules = [];
        for ($day = 0; $day <= 6; $day++) {
            $enabled = $day >= 1 && $day <= 5;
            $rules[] = [
                'day'           => $day,
                'enabled'       => $enabled,
                'clock_in'      => $enabled ? '09:00:00' : null,
                'clock_out'     => $enabled ? '17:00:00' : null,
                'grace_enabled' => false,
                'grace_type'    => '-/+',
                'grace_minutes' => 0,
            ];
        }

        return $rules;
    }

    private function makeLinkedEmployee(string $suffix): array
    {
        $user = User::factory()->create([
            'role'  => 'employee',
            'email' => "flexi-overnight-{$suffix}@example.com",
        ]);

        $employee = Employee::create([
            'user_id'      => $user->id,
            'employee_id'  => "EMP-FOX-{$suffix}",
            'first_name'   => 'Flexi',
            'last_name'    => "Overnight{$suffix}",
            'email'        => $user->email,
            'position'     => 'Tester',
            'hire_date'    => '2026-01-01',
            'salary'       => 20000,
            'status'       => 'active',
        ]);

        return [$user, $employee];
    }

    private function makeFlexiTemplate(): ScheduleTemplate
    {
        return ScheduleTemplate::create([
            'type'                   => 'flexi',
            'name'                   => 'Flexi Overnight',
            'work_days'              => [1, 2, 3, 4, 5],
            'day_rules'              => $this->weekdayRules(),
            'start_time'             => '09:00:00',
            'end_time'               => '17:00:00',
            'required_hours_per_day' => 8,
        ]);
    }

    private function makeFixedTemplate(): ScheduleTemplate
    {
        return ScheduleTemplate::create([
            'type'                   => 'fixed',
            'name'                   => 'Fixed 9-5',
            'work_days'              => [1, 2, 3, 4, 5],
            'day_rules'              => $this->weekdayRules(),
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

    public function test_personal_today_surfaces_yesterdays_open_flexi_punch()
    {
        [$user, $employee] = $this->makeLinkedEmployee('A');
        $this->assignSchedule($employee, $this->makeFlexiTemplate());

        $this->travelTo(Carbon::parse('2026-01-05 22:00:00'));
        $this->actingAs($user)->postJson('/api/attendance/clock-in')->assertCreated();

        $this->travelTo(Carbon::parse('2026-01-06 06:00:00'));
        $response = $this->actingAs($user)->getJson('/api/attendance/today?personal=true');

        $response->assertOk();
        $this->assertTrue($response->json('data.clocked_in'));
        $this->assertFalse($response->json('data.clocked_out'));
        $this->assertSame('2026-01-05', $response->json('data.shift_date'));
        $this->assertFalse($response->json('data.overnight_clock_in_blocked'));
        $this->assertSame('22:00:00', $response->json('data.clock_in_time'));
    }

    public function test_clock_out_next_calendar_day_closes_yesterdays_flexi_log()
    {
        [$user, $employee] = $this->makeLinkedEmployee('B');
        $this->assignSchedule($employee, $this->makeFlexiTemplate());

        $this->travelTo(Carbon::parse('2026-01-05 22:00:00'));
        $this->actingAs($user)->postJson('/api/attendance/clock-in')->assertCreated();

        $this->travelTo(Carbon::parse('2026-01-06 06:00:00'));
        $this->actingAs($user)->postJson('/api/attendance/clock-out')->assertOk();

        $this->assertSame(1, AttendanceLog::where('employee_id', $employee->id)->count());
        $log = AttendanceLog::where('employee_id', $employee->id)->sole();
        $this->assertSame('2026-01-05', $log->date->toDateString());
        $this->assertSame('22:00:00', $log->clock_in_time);
        $this->assertSame('06:00:00', $log->clock_out_time);
        $this->assertSame('completed', $log->status);
        $this->assertEquals(8.0, AttendanceService::evaluateFlexi(
            $log->clock_in_time,
            $log->clock_out_time,
            8
        )['hours_worked']);
    }

    public function test_after_flexi_overnight_clock_out_a_new_today_clock_in_is_allowed()
    {
        [$user, $employee] = $this->makeLinkedEmployee('C');
        $this->assignSchedule($employee, $this->makeFlexiTemplate());

        $this->travelTo(Carbon::parse('2026-01-05 22:00:00'));
        $this->actingAs($user)->postJson('/api/attendance/clock-in')->assertCreated();

        $this->travelTo(Carbon::parse('2026-01-06 06:00:00'));
        $this->actingAs($user)->postJson('/api/attendance/clock-out')->assertOk();

        $today = $this->actingAs($user)->getJson('/api/attendance/today?personal=true');
        $today->assertOk();
        $this->assertFalse($today->json('data.clocked_in'));

        $this->actingAs($user)->postJson('/api/attendance/clock-in')->assertCreated();

        $this->assertSame(2, AttendanceLog::where('employee_id', $employee->id)->count());
        $this->assertDatabaseHas('attendance_logs', [
            'employee_id'    => $employee->id,
            'date'           => '2026-01-05',
            'clock_out_time' => '06:00:00',
        ]);
        $this->assertDatabaseHas('attendance_logs', [
            'employee_id'   => $employee->id,
            'date'          => '2026-01-06',
            'clock_in_time' => '06:00:00',
        ]);
    }

    public function test_re_clock_in_while_yesterdays_flexi_punch_is_open_is_rejected()
    {
        [$user, $employee] = $this->makeLinkedEmployee('D');
        $this->assignSchedule($employee, $this->makeFlexiTemplate());

        $this->travelTo(Carbon::parse('2026-01-05 22:00:00'));
        $this->actingAs($user)->postJson('/api/attendance/clock-in')->assertCreated();

        $this->travelTo(Carbon::parse('2026-01-06 03:00:00'));
        $response = $this->actingAs($user)->postJson('/api/attendance/clock-in');

        $response->assertStatus(400);
        $this->assertSame('You have already clocked in for the current shift', $response->json('message'));
        $this->assertSame(1, AttendanceLog::where('employee_id', $employee->id)->count());
        $log = AttendanceLog::where('employee_id', $employee->id)->sole();
        $this->assertSame('2026-01-05', $log->date->toDateString());
        $this->assertNull($log->clock_out_time);
    }

    public function test_forgotten_daytime_flexi_punch_still_surfaces_the_next_morning()
    {
        [$user, $employee] = $this->makeLinkedEmployee('E');
        $this->assignSchedule($employee, $this->makeFlexiTemplate());

        $this->travelTo(Carbon::parse('2026-01-05 09:00:00'));
        $this->actingAs($user)->postJson('/api/attendance/clock-in')->assertCreated();

        $this->travelTo(Carbon::parse('2026-01-06 09:00:00'));
        $response = $this->actingAs($user)->getJson('/api/attendance/today?personal=true');

        $response->assertOk();
        $this->assertTrue($response->json('data.clocked_in'));
        $this->assertSame('2026-01-05', $response->json('data.shift_date'));
        $this->assertSame('09:00:00', $response->json('data.clock_in_time'));
    }

    public function test_fixed_schedule_open_punch_is_not_adopted_the_next_day()
    {
        [$user, $employee] = $this->makeLinkedEmployee('F');
        $this->assignSchedule($employee, $this->makeFixedTemplate());

        $this->travelTo(Carbon::parse('2026-01-05 09:00:00'));
        $this->actingAs($user)->postJson('/api/attendance/clock-in')->assertCreated();

        $this->travelTo(Carbon::parse('2026-01-06 09:00:00'));
        $response = $this->actingAs($user)->getJson('/api/attendance/today?personal=true');

        $response->assertOk();
        $this->assertFalse($response->json('data.clocked_in'));
        $this->assertNull($response->json('data.clock_in_time'));
    }
}
