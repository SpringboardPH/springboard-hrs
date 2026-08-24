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
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

class NightDifferentialTest extends TestCase
{
    use RefreshDatabase;

    #[DataProvider('nightHoursProvider')]
    public function test_calculate_night_hours(?string $clockIn, ?string $clockOut, float $expected)
    {
        $this->assertEquals($expected, AttendanceService::calculateNightHours($clockIn, $clockOut));
    }

    public static function nightHoursProvider(): array
    {
        return [
            'canonical night shift'        => ['22:00:00', '06:00:00', 8.0],
            'partial overlap at the front' => ['18:00:00', '23:00:00', 1.0],
            'previous nights tail'         => ['04:00:00', '12:00:00', 2.0],
            'pure day shift'               => ['09:00:00', '18:00:00', 0.0],
            'both null'                    => [null, null, 0.0],
            'day shift with OT into window' => ['09:00:00', '23:30:00', 1.5],
            'clocked in early out late'    => ['21:00:00', '07:00:00', 8.0],
        ];
    }

    public function test_overnight_late_arrival_is_correctly_flagged()
    {
        $details = AttendanceService::calculateDetails('00:30:00', '06:00:00', 8, '22:00:00');
        $this->assertEquals(150, $details['late_minutes']);
        $this->assertEquals(5.5, $details['hours_worked']);
    }

    public function test_on_time_night_shift_is_not_marked_late()
    {
        $details = AttendanceService::calculateDetails('22:00:00', '06:00:00', 8, '22:00:00');
        $this->assertEquals(0, $details['late_minutes']);
        $this->assertEquals(8.0, $details['hours_worked']);
    }

    public function test_normal_day_shift_is_unaffected()
    {
        $details = AttendanceService::calculateDetails('09:15:00', '18:00:00', 9, '09:00:00');
        $this->assertEquals(15, $details['late_minutes']);
    }

    public function test_night_template_wraps_midnight_on_overnight_day_rule()
    {
        $template = new ScheduleTemplate([
            'type' => 'night',
            'work_start_time' => '22:00:00',
            'work_end_time' => '06:00:00',
        ]);

        $rule = ['clock_in' => '22:00:00', 'clock_out' => '06:00:00'];

        $this->assertTrue($template->wrapsMidnight($rule));
    }

    public function test_night_template_does_not_wrap_on_a_mixed_week_early_day_rule()
    {
        $template = new ScheduleTemplate([
            'type' => 'night',
            'work_start_time' => '22:00:00',
            'work_end_time' => '06:00:00',
        ]);

        $rule = ['clock_in' => '06:00:00', 'clock_out' => '15:00:00'];

        $this->assertFalse($template->wrapsMidnight($rule));
    }

    public function test_fixed_template_never_wraps_midnight_even_with_overnight_day_rule()
    {
        $template = new ScheduleTemplate([
            'type' => 'fixed',
            'work_start_time' => '22:00:00',
            'work_end_time' => '06:00:00',
        ]);

        $rule = ['clock_in' => '22:00:00', 'clock_out' => '06:00:00'];

        $this->assertFalse($template->wrapsMidnight($rule));
    }

    public function test_wraps_midnight_falls_back_to_template_times_when_no_day_rule_given()
    {
        $template = new ScheduleTemplate([
            'type' => 'night',
            'work_start_time' => '22:00:00',
            'work_end_time' => '06:00:00',
        ]);

        $this->assertTrue($template->wrapsMidnight(null));
    }

    public function test_shift_end_for_returns_the_day_rules_clock_out()
    {
        $template = new ScheduleTemplate([
            'type' => 'night',
            'work_start_time' => '22:00:00',
            'work_end_time' => '06:00:00',
        ]);

        $overnightRule = ['clock_in' => '22:00:00', 'clock_out' => '06:00:00'];
        $earlyRule = ['clock_in' => '06:00:00', 'clock_out' => '15:00:00'];

        $this->assertEquals('06:00:00', $template->shiftEndFor($overnightRule));
        $this->assertEquals('15:00:00', $template->shiftEndFor($earlyRule));
    }

    public function test_wraps_midnight_returns_false_for_a_disabled_day_rule()
    {
        $template = new ScheduleTemplate([
            'type' => 'night',
            'work_start_time' => '22:00:00',
            'work_end_time' => '06:00:00',
        ]);

        // Sunday, disabled: no shift exists that day, so it must not claim to wrap.
        $disabledRule = ['day' => 0, 'enabled' => false, 'clock_in' => null, 'clock_out' => null];

        $this->assertFalse($template->wrapsMidnight($disabledRule));
        $this->assertEquals('06:00:00', $template->shiftEndFor($disabledRule));
    }

    /**
     * Builds a full 7-day day_rules payload with a single enabled day.
     */
    private function buildDayRules(int $enabledDay, ?string $clockIn, ?string $clockOut): array
    {
        $rules = [];
        for ($day = 0; $day <= 6; $day++) {
            $enabled = $day === $enabledDay;
            $rules[] = [
                'day' => $day,
                'enabled' => $enabled,
                'clock_in' => $enabled ? $clockIn : null,
                'clock_out' => $enabled ? $clockOut : null,
                'grace_enabled' => false,
                'grace_type' => '-/+',
                'grace_minutes' => 15,
            ];
        }

        return $rules;
    }

    public function test_store_route_persists_night_type_and_derives_8_hour_wrapping_shift()
    {
        $admin = User::factory()->create(['role' => 'admin']);

        $response = $this->actingAs($admin)->postJson('/api/admin/schedule-templates', [
            'name' => 'Night Shift Template',
            'type' => 'night',
            'day_rules' => $this->buildDayRules(3, '22:00:00', '06:00:00'),
        ]);

        $response->assertCreated();
        $this->assertSame('night', $response->json('data.type'));
        $this->assertSame(8, $response->json('data.required_hours_per_day'));

        $this->assertDatabaseHas('schedule_templates', [
            'name' => 'Night Shift Template',
            'type' => 'night',
            'required_hours_per_day' => 8,
        ]);
    }

    public function test_store_route_still_defaults_to_fixed_when_type_is_omitted()
    {
        $admin = User::factory()->create(['role' => 'admin']);

        $response = $this->actingAs($admin)->postJson('/api/admin/schedule-templates', [
            'name' => 'Untyped Template',
            'day_rules' => $this->buildDayRules(3, '09:00:00', '18:00:00'),
        ]);

        $response->assertCreated();
        $this->assertSame('fixed', $response->json('data.type'));
        $this->assertDatabaseHas('schedule_templates', [
            'name' => 'Untyped Template',
            'type' => 'fixed',
        ]);
    }

    public function test_store_route_persists_fixed_when_type_explicitly_fixed()
    {
        $admin = User::factory()->create(['role' => 'admin']);

        $response = $this->actingAs($admin)->postJson('/api/admin/schedule-templates', [
            'name' => 'Explicit Fixed Template',
            'type' => 'fixed',
            'day_rules' => $this->buildDayRules(3, '09:00:00', '18:00:00'),
        ]);

        $response->assertCreated();
        $this->assertSame('fixed', $response->json('data.type'));
        $this->assertDatabaseHas('schedule_templates', [
            'name' => 'Explicit Fixed Template',
            'type' => 'fixed',
        ]);
    }

    public function test_night_template_created_via_store_route_wraps_midnight_on_its_wednesday_rule()
    {
        $admin = User::factory()->create(['role' => 'admin']);

        $response = $this->actingAs($admin)->postJson('/api/admin/schedule-templates', [
            'name' => 'Night Shift Round Trip',
            'type' => 'night',
            'day_rules' => $this->buildDayRules(3, '22:00:00', '06:00:00'),
        ]);

        $response->assertCreated();

        $template = ScheduleTemplate::where('name', 'Night Shift Round Trip')->firstOrFail();
        $this->assertSame('night', $template->type);

        $wednesdayRule = collect($template->day_rules)->firstWhere('day', 3);
        $this->assertNotNull($wednesdayRule);
        $this->assertTrue($template->wrapsMidnight($wednesdayRule));
    }

    /**
     * Builds a full 7-day day_rules payload where every day in $enabledDays
     * shares the same clock_in/clock_out.
     */
    private function buildWeekDayRules(array $enabledDays, string $clockIn, string $clockOut): array
    {
        $rules = [];
        for ($day = 0; $day <= 6; $day++) {
            $enabled = in_array($day, $enabledDays, true);
            $rules[] = [
                'day' => $day,
                'enabled' => $enabled,
                'clock_in' => $enabled ? $clockIn : null,
                'clock_out' => $enabled ? $clockOut : null,
                'grace_enabled' => false,
                'grace_type' => '-/+',
                'grace_minutes' => 15,
            ];
        }

        return $rules;
    }

    /**
     * Mixed-week day_rules: Monday (day 1) is an early, non-wrapping shift;
     * Wednesday (day 3) is a wrapping night shift. All other days disabled.
     */
    private function buildMixedWeekDayRules(): array
    {
        $rules = [];
        for ($day = 0; $day <= 6; $day++) {
            if ($day === 1) {
                $rules[] = [
                    'day' => 1, 'enabled' => true,
                    'clock_in' => '06:00:00', 'clock_out' => '15:00:00',
                    'grace_enabled' => false, 'grace_type' => '-/+', 'grace_minutes' => 15,
                ];
            } elseif ($day === 3) {
                $rules[] = [
                    'day' => 3, 'enabled' => true,
                    'clock_in' => '22:00:00', 'clock_out' => '06:00:00',
                    'grace_enabled' => false, 'grace_type' => '-/+', 'grace_minutes' => 15,
                ];
            } else {
                $rules[] = [
                    'day' => $day, 'enabled' => false,
                    'clock_in' => null, 'clock_out' => null,
                    'grace_enabled' => false, 'grace_type' => '-/+', 'grace_minutes' => 15,
                ];
            }
        }

        return $rules;
    }

    private function makeEmployee(string $suffix): Employee
    {
        return Employee::create([
            'employee_id' => "EMP-ND-{$suffix}",
            'first_name'  => 'Night',
            'last_name'   => "Shift{$suffix}",
            'email'       => "night-shift-{$suffix}@example.com",
            'position'    => 'Tester',
            'hire_date'   => '2026-01-01',
            'salary'      => 20000,
            'status'      => 'active',
        ]);
    }

    private function makeNightTemplate(array $dayRules, array $workDays): ScheduleTemplate
    {
        return ScheduleTemplate::create([
            'type' => 'night',
            'name' => 'Night Shift ' . uniqid(),
            'work_days' => $workDays,
            'day_rules' => $dayRules,
            'start_time' => '22:00:00',
            'end_time' => '06:00:00',
            'work_start_time' => '22:00:00',
            'work_end_time' => '06:00:00',
            'required_hours_per_day' => 8,
        ]);
    }

    private function assignSchedule(Employee $employee, ScheduleTemplate $template): EmployeeSchedule
    {
        return EmployeeSchedule::create([
            'employee_id' => $employee->id,
            'schedule_template_id' => $template->id,
            'start_date' => '2026-01-01',
            'end_date' => '2026-01-31',
            'status' => 'active',
        ]);
    }

    public function test_night_shift_clock_in_at_shift_start_succeeds_and_is_not_late()
    {
        $employee = $this->makeEmployee('1');
        $template = $this->makeNightTemplate(
            $this->buildWeekDayRules([1, 2, 3, 4, 5], '22:00:00', '06:00:00'),
            [1, 2, 3, 4, 5]
        );
        $this->assignSchedule($employee, $template);
        $admin = User::factory()->create(['role' => 'admin']);

        $this->travelTo(Carbon::parse('2026-01-05 22:00:00')); // Monday

        $response = $this->actingAs($admin)->postJson('/api/attendance/clock-in', [
            'employee_id' => $employee->id,
        ]);

        $response->assertCreated();
        $this->assertSame('working', $response->json('data.status'));

        $log = AttendanceLog::where('employee_id', $employee->id)->sole();
        $this->assertSame('2026-01-05', $log->date->toDateString());
    }

    public function test_post_midnight_arrival_resolves_to_yesterdays_shift()
    {
        $employee = $this->makeEmployee('2');
        $template = $this->makeNightTemplate(
            $this->buildWeekDayRules([1, 2, 3, 4, 5], '22:00:00', '06:00:00'),
            [1, 2, 3, 4, 5]
        );
        $this->assignSchedule($employee, $template);
        $admin = User::factory()->create(['role' => 'admin']);

        $this->travelTo(Carbon::parse('2026-01-06 00:30:00')); // Tuesday 00:30, shift began Monday 22:00

        $response = $this->actingAs($admin)->postJson('/api/attendance/clock-in', [
            'employee_id' => $employee->id,
        ]);

        $response->assertCreated();
        $this->assertSame('working', $response->json('data.status'));

        $this->assertSame(1, AttendanceLog::where('employee_id', $employee->id)->count());
        $log = AttendanceLog::where('employee_id', $employee->id)->sole();
        $this->assertSame('2026-01-05', $log->date->toDateString());
    }

    public function test_one_night_shift_produces_exactly_one_attendance_log_row()
    {
        $employee = $this->makeEmployee('3');
        $template = $this->makeNightTemplate(
            $this->buildWeekDayRules([1, 2, 3, 4, 5], '22:00:00', '06:00:00'),
            [1, 2, 3, 4, 5]
        );
        $this->assignSchedule($employee, $template);
        $admin = User::factory()->create(['role' => 'admin']);

        $this->travelTo(Carbon::parse('2026-01-05 22:00:00')); // Monday
        $this->actingAs($admin)->postJson('/api/attendance/clock-in', ['employee_id' => $employee->id])
            ->assertCreated();

        $this->travelTo(Carbon::parse('2026-01-06 06:00:00')); // Tuesday
        $this->actingAs($admin)->postJson('/api/attendance/clock-out', ['employee_id' => $employee->id])
            ->assertOk();

        $this->assertSame(1, AttendanceLog::where('employee_id', $employee->id)->count());
        $log = AttendanceLog::where('employee_id', $employee->id)->sole();
        $this->assertSame('2026-01-05', $log->date->toDateString());
        $this->assertSame('22:00:00', $log->clock_in_time);
        $this->assertSame('06:00:00', $log->clock_out_time);
    }

    public function test_mixed_week_unwrap_is_per_day_rule_not_per_template()
    {
        $employee = $this->makeEmployee('4');
        $template = $this->makeNightTemplate($this->buildMixedWeekDayRules(), [1, 3]);
        $this->assignSchedule($employee, $template);
        $admin = User::factory()->create(['role' => 'admin']);

        // Monday's day rule is 06:00-15:00 (does not wrap) - a 22:00 arrival
        // is well past its window and must be rejected.
        $this->travelTo(Carbon::parse('2026-01-05 22:00:00')); // Monday
        $this->actingAs($admin)->postJson('/api/attendance/clock-in', ['employee_id' => $employee->id])
            ->assertStatus(400);

        // Wednesday's day rule is 22:00-06:00 (wraps) - the same clock time succeeds.
        $this->travelTo(Carbon::parse('2026-01-07 22:00:00')); // Wednesday
        $this->actingAs($admin)->postJson('/api/attendance/clock-in', ['employee_id' => $employee->id])
            ->assertCreated();
    }

    public function test_fixed_template_night_time_handling_is_unaffected()
    {
        $template = ScheduleTemplate::create([
            'type' => 'fixed',
            'name' => 'Fixed 9-6 Regression',
            'work_days' => [1, 2, 3, 4, 5],
            'day_rules' => $this->buildWeekDayRules([1, 2, 3, 4, 5], '09:00:00', '18:00:00'),
            'start_time' => '09:00:00',
            'end_time' => '18:00:00',
            'work_start_time' => '09:00:00',
            'work_end_time' => '18:00:00',
            'required_hours_per_day' => 9,
        ]);
        $admin = User::factory()->create(['role' => 'admin']);

        $onTimeEmployee = $this->makeEmployee('5a');
        $this->assignSchedule($onTimeEmployee, $template);

        $this->travelTo(Carbon::parse('2026-01-05 09:15:00')); // Monday
        $response = $this->actingAs($admin)->postJson('/api/attendance/clock-in', [
            'employee_id' => $onTimeEmployee->id,
        ]);
        $response->assertCreated();
        $this->assertSame('working', $response->json('data.status'));

        $lateArrivalEmployee = $this->makeEmployee('5b');
        $this->assignSchedule($lateArrivalEmployee, $template);

        $this->travelTo(Carbon::parse('2026-01-05 22:00:00')); // Monday, same day
        $this->actingAs($admin)->postJson('/api/attendance/clock-in', [
            'employee_id' => $lateArrivalEmployee->id,
        ])->assertStatus(400);
    }

    public function test_clock_in_after_already_completing_last_nights_shift_is_rejected_not_a_new_shift()
    {
        $employee = $this->makeEmployee('6');
        $template = $this->makeNightTemplate(
            $this->buildWeekDayRules([1, 2, 3, 4, 5], '22:00:00', '06:00:00'),
            [1, 2, 3, 4, 5]
        );
        $this->assignSchedule($employee, $template);
        $admin = User::factory()->create(['role' => 'admin']);

        $this->travelTo(Carbon::parse('2026-01-05 22:00:00')); // Monday 22:00
        $this->actingAs($admin)->postJson('/api/attendance/clock-in', ['employee_id' => $employee->id])
            ->assertCreated();

        $this->travelTo(Carbon::parse('2026-01-06 05:00:00')); // Tuesday 05:00
        $this->actingAs($admin)->postJson('/api/attendance/clock-out', [
            'employee_id' => $employee->id,
            'confirm_early_clock_out' => true,
        ])->assertOk();

        // Monday's shift is closed. A second arrival at 05:30 is 16.5 hours before
        // Tuesday's own 22:00 shift and must not be reinterpreted as a post-midnight
        // arrival for it — that would open a spurious second attendance_log row.
        $this->travelTo(Carbon::parse('2026-01-06 05:30:00')); // Tuesday 05:30
        $this->actingAs($admin)->postJson('/api/attendance/clock-in', ['employee_id' => $employee->id])
            ->assertStatus(400);

        $this->assertSame(1, AttendanceLog::where('employee_id', $employee->id)->count());
    }

    public function test_re_clock_in_while_last_nights_shift_still_open_is_rejected_and_leaves_it_open()
    {
        $employee = $this->makeEmployee('7');
        $template = $this->makeNightTemplate(
            $this->buildWeekDayRules([1, 2, 3, 4, 5], '22:00:00', '06:00:00'),
            [1, 2, 3, 4, 5]
        );
        $this->assignSchedule($employee, $template);
        $admin = User::factory()->create(['role' => 'admin']);

        $this->travelTo(Carbon::parse('2026-01-05 22:00:00')); // Monday 22:00
        $this->actingAs($admin)->postJson('/api/attendance/clock-in', ['employee_id' => $employee->id])
            ->assertCreated();

        // Monday's row is still open (no clock-out yet). A second arrival at
        // 03:00 must be recognized as the same shift continuing, not a fresh
        // clock-in — otherwise it opens a second row and strands Monday's open
        // forever (clockOut() would match Tuesday's row first).
        $this->travelTo(Carbon::parse('2026-01-06 03:00:00')); // Tuesday 03:00
        $response = $this->actingAs($admin)->postJson('/api/attendance/clock-in', ['employee_id' => $employee->id]);
        $response->assertStatus(400);
        $this->assertSame('You have already clocked in for the current shift', $response->json('message'));

        $this->assertSame(1, AttendanceLog::where('employee_id', $employee->id)->count());
        $log = AttendanceLog::where('employee_id', $employee->id)->sole();
        $this->assertSame('2026-01-05', $log->date->toDateString());
        $this->assertNull($log->clock_out_time);
    }

    public function test_mixed_week_early_arrival_does_not_wrongly_adopt_a_disabled_sunday()
    {
        $employee = $this->makeEmployee('8');
        $template = $this->makeNightTemplate($this->buildMixedWeekDayRules(), [1, 3]);
        $this->assignSchedule($employee, $template);
        $admin = User::factory()->create(['role' => 'admin']);

        // Monday's day rule is 06:00-15:00; Sunday is disabled with null times.
        // Without the wrapsMidnight() disabled-day fix, this arrival would
        // wrongly adopt Sunday's (non-existent) wrapping shift via the
        // template-time fallback and get rejected as an unscheduled rest day.
        $this->travelTo(Carbon::parse('2026-01-05 05:30:00')); // Monday 05:30, within the 1hr early allowance
        $response = $this->actingAs($admin)->postJson('/api/attendance/clock-in', ['employee_id' => $employee->id]);

        $response->assertCreated();
        $this->assertSame('working', $response->json('data.status'));

        $log = AttendanceLog::where('employee_id', $employee->id)->sole();
        $this->assertSame('2026-01-05', $log->date->toDateString());
    }

    public function test_mark_absent_does_not_flag_an_in_progress_night_shift()
    {
        $employee = $this->makeEmployee('9');
        $template = $this->makeNightTemplate(
            $this->buildWeekDayRules([1, 2, 3, 4, 5], '22:00:00', '06:00:00'),
            [1, 2, 3, 4, 5]
        );
        $this->assignSchedule($employee, $template);

        $this->travelTo(Carbon::parse('2026-01-06 00:00:00')); // Tuesday 00:00
        $this->artisan('attendance:mark-absent')->run();

        $this->assertSame(0, AttendanceLog::where('employee_id', $employee->id)
            ->where('date', '2026-01-05')->count());
    }

    public function test_mark_absent_eventually_flags_a_genuine_night_no_show()
    {
        $employee = $this->makeEmployee('10');
        $template = $this->makeNightTemplate(
            $this->buildWeekDayRules([1, 2, 3, 4, 5], '22:00:00', '06:00:00'),
            [1, 2, 3, 4, 5]
        );
        $this->assignSchedule($employee, $template);

        $this->travelTo(Carbon::parse('2026-01-07 00:00:00')); // Wednesday 00:00, shift long over
        $this->artisan('attendance:mark-absent')->run();

        $log = AttendanceLog::where('employee_id', $employee->id)
            ->where('date', '2026-01-05')->sole();
        $this->assertSame('absent', $log->status);
    }

    public function test_mark_absent_never_flags_an_employee_already_clocked_in_at_shift_start()
    {
        $employee = $this->makeEmployee('11');
        $template = $this->makeNightTemplate(
            $this->buildWeekDayRules([1, 2, 3, 4, 5], '22:00:00', '06:00:00'),
            [1, 2, 3, 4, 5]
        );
        $this->assignSchedule($employee, $template);
        $admin = User::factory()->create(['role' => 'admin']);

        $this->travelTo(Carbon::parse('2026-01-05 22:00:00')); // Monday 22:00
        $this->actingAs($admin)->postJson('/api/attendance/clock-in', ['employee_id' => $employee->id])
            ->assertCreated();

        $this->travelTo(Carbon::parse('2026-01-06 00:00:00')); // Tuesday 00:00
        $this->artisan('attendance:mark-absent')->run();

        $log = AttendanceLog::where('employee_id', $employee->id)
            ->where('date', '2026-01-05')->sole();
        $this->assertSame('22:00:00', $log->clock_in_time);
        $this->assertNotSame('absent', $log->status);
    }

    public function test_mark_absent_regression_plain_fixed_no_show_still_flagged()
    {
        $employee = $this->makeEmployee('12');
        $template = ScheduleTemplate::create([
            'type' => 'fixed',
            'name' => 'Fixed 9-6 Mark Absent Regression',
            'work_days' => [1, 2, 3, 4, 5],
            'day_rules' => $this->buildWeekDayRules([1, 2, 3, 4, 5], '09:00:00', '18:00:00'),
            'start_time' => '09:00:00',
            'end_time' => '18:00:00',
            'work_start_time' => '09:00:00',
            'work_end_time' => '18:00:00',
            'required_hours_per_day' => 9,
        ]);
        $this->assignSchedule($employee, $template);

        $this->travelTo(Carbon::parse('2026-01-06 00:00:00')); // Tuesday 00:00
        $this->artisan('attendance:mark-absent')->run();

        $log = AttendanceLog::where('employee_id', $employee->id)
            ->where('date', '2026-01-05')->sole();
        $this->assertSame('absent', $log->status);
    }

    public function test_mark_absent_mixed_week_non_wrapping_day_still_flagged_like_a_day_shift()
    {
        $employee = $this->makeEmployee('13');
        $template = $this->makeNightTemplate($this->buildMixedWeekDayRules(), [1, 3]);
        $this->assignSchedule($employee, $template);

        $this->travelTo(Carbon::parse('2026-01-06 00:00:00')); // Tuesday 00:00
        $this->artisan('attendance:mark-absent')->run();

        $log = AttendanceLog::where('employee_id', $employee->id)
            ->where('date', '2026-01-05')->sole();
        $this->assertSame('absent', $log->status);
    }

    // ── Night differential PAY (money path) ──────────────────────────────

    private function makePayEmployee(string $suffix): Employee
    {
        return Employee::create([
            'employee_id' => "EMP-NDPAY-{$suffix}",
            'first_name'  => 'NightPay',
            'last_name'   => "Case{$suffix}",
            'email'       => "nd-pay-{$suffix}@example.com",
            'position'    => 'Tester',
            'hire_date'   => '2026-01-01',
            'salary'      => 1000,
            'rate_type'   => 'daily',
            'status'      => 'active',
        ]);
    }

    public function test_canonical_night_shift_pays_10_percent_premium_not_110_percent()
    {
        $employee = $this->makePayEmployee('1');
        // Attach a real schedule so this exercises the path HR actually uses —
        // makePayEmployee() previously had no EmployeeSchedule at all, which hid
        // the C1 phantom-late bug (see the new no-schedule/mixed-template tests
        // below for the cases that were actually broken).
        $template = $this->makeNightTemplate(
            $this->buildWeekDayRules([1, 2, 3, 4, 5], '22:00:00', '06:00:00'),
            [1, 2, 3, 4, 5]
        );
        $this->assignSchedule($employee, $template);

        AttendanceLog::create([
            'employee_id' => $employee->id,
            'date' => '2026-01-05',
            'clock_in_time' => '22:00:00',
            'clock_out_time' => '06:00:00',
            'status' => 'completed',
            'schedule_type' => 'night',
        ]);
        $admin = User::factory()->create(['role' => 'admin']);

        $this->actingAs($admin)->postJson('/api/payroll/generate', [
            'cutoff_start' => '2026-01-05', 'cutoff_end' => '2026-01-05',
        ])->assertOk();

        $payroll = \App\Models\Payroll::where('employee_id', $employee->id)->sole();
        $ndLine = collect($payroll->allowances)->firstWhere('label', 'Night Differential (8 hrs)');
        $this->assertNotNull($ndLine);
        $this->assertEquals(100.00, (float) $ndLine['amount']);

        // C1: a real schedule must not produce a phantom "Late" deduction that
        // annihilates the employee's day. ₱1,000 base + ₱100 ND = ₱1,100 net.
        $this->assertArrayNotHasKey('Late', $payroll->deductions);
        $this->assertEquals(1100.00, (float) $payroll->net_pay);
    }

    public function test_mixed_template_night_shift_nets_full_pay_and_day_shift_is_unaffected()
    {
        // The mixed template (Mon 06:00-15:00 day shift, Wed 22:00-06:00 night
        // shift) is the worst case for C1: the template-level work_start_time
        // is a single hardcoded value that cannot be correct for both day rules.
        $employee = $this->makePayEmployee('11');
        $template = $this->makeNightTemplate($this->buildMixedWeekDayRules(), [1, 3]);
        $this->assignSchedule($employee, $template);

        AttendanceLog::create([
            'employee_id' => $employee->id,
            'date' => '2026-01-05', // Monday — early day shift
            'clock_in_time' => '06:00:00',
            'clock_out_time' => '15:00:00',
            'status' => 'completed',
            'schedule_type' => 'fixed',
        ]);
        AttendanceLog::create([
            'employee_id' => $employee->id,
            'date' => '2026-01-07', // Wednesday — overnight shift
            'clock_in_time' => '22:00:00',
            'clock_out_time' => '06:00:00',
            'status' => 'completed',
            'schedule_type' => 'night',
        ]);
        $admin = User::factory()->create(['role' => 'admin']);

        $this->actingAs($admin)->postJson('/api/payroll/generate', [
            'cutoff_start' => '2026-01-05', 'cutoff_end' => '2026-01-07',
        ])->assertOk();

        $payroll = \App\Models\Payroll::where('employee_id', $employee->id)->sole();
        $this->assertArrayNotHasKey('Late', $payroll->deductions);

        $ndLine = collect($payroll->allowances)->firstWhere('label', 'Night Differential (8 hrs)');
        $this->assertNotNull($ndLine);
        $this->assertEquals(100.00, (float) $ndLine['amount']);

        $this->assertSame(2, $payroll->days_worked);
        // 2 days x ₱1,000 base + ₱100 ND, no deductions = ₱2,100 net.
        $this->assertEquals(2100.00, (float) $payroll->net_pay);
    }

    public function test_payroll_uses_logs_schedule_template_snapshot_when_no_employee_schedule_row_exists()
    {
        // Payroll runs on historical data and schedules get reassigned — the log's
        // snapshotted schedule_template_id must alone be enough to resolve the
        // correct day rule, without any active EmployeeSchedule row.
        $employee = $this->makePayEmployee('12');
        $template = $this->makeNightTemplate(
            $this->buildWeekDayRules([1, 2, 3, 4, 5], '22:00:00', '06:00:00'),
            [1, 2, 3, 4, 5]
        );

        AttendanceLog::create([
            'employee_id' => $employee->id,
            'date' => '2026-01-05',
            'clock_in_time' => '22:00:00',
            'clock_out_time' => '06:00:00',
            'status' => 'completed',
            'schedule_type' => 'night',
            'schedule_template_id' => $template->id,
            'schedule_template_name' => $template->name,
        ]);
        $admin = User::factory()->create(['role' => 'admin']);

        $this->actingAs($admin)->postJson('/api/payroll/generate', [
            'cutoff_start' => '2026-01-05', 'cutoff_end' => '2026-01-05',
        ])->assertOk();

        $payroll = \App\Models\Payroll::where('employee_id', $employee->id)->sole();
        $this->assertArrayNotHasKey('Late', $payroll->deductions);
        $this->assertEquals(1100.00, (float) $payroll->net_pay);
    }

    public function test_clock_out_on_mixed_template_uses_the_logs_own_date_not_todays_schedule()
    {
        // I1: clockOut() must judge an overnight log against the day rule for
        // the LOG's date (Wednesday), not SystemClock::today() (Thursday) —
        // otherwise a mixed template spuriously rejects/flags the clock-out.
        // Built via the real admin store route (not the makeNightTemplate() test
        // helper) so work_start_time is derived from the first enabled day rule
        // (Monday, 06:00) — the realistic HR case where the template-level
        // fallback also mismatches the actual overnight shift.
        $admin = User::factory()->create(['role' => 'admin']);
        $this->actingAs($admin)->postJson('/api/admin/schedule-templates', [
            'name' => 'Mixed Week I1 Clock Out',
            'type' => 'night',
            'day_rules' => $this->buildMixedWeekDayRules(),
        ])->assertCreated();
        $template = ScheduleTemplate::where('name', 'Mixed Week I1 Clock Out')->firstOrFail();

        $employee = $this->makeEmployee('14');
        $this->assignSchedule($employee, $template);

        $this->travelTo(Carbon::parse('2026-01-07 22:00:00')); // Wednesday 22:00
        $this->actingAs($admin)->postJson('/api/attendance/clock-in', ['employee_id' => $employee->id])
            ->assertCreated();

        $this->travelTo(Carbon::parse('2026-01-08 06:00:00')); // Thursday 06:00
        $response = $this->actingAs($admin)->postJson('/api/attendance/clock-out', ['employee_id' => $employee->id]);
        $response->assertOk();
        $this->assertNotSame('late', $response->json('data.status'));

        $log = AttendanceLog::where('employee_id', $employee->id)->sole();
        $this->assertSame('2026-01-07', $log->date->toDateString());
        $this->assertSame('06:00:00', $log->clock_out_time);
        $this->assertNotSame('late', $log->status);
    }

    public function test_flexi_employee_earns_night_differential_with_no_schedule_gating()
    {
        $employee = $this->makePayEmployee('2');
        AttendanceLog::create([
            'employee_id' => $employee->id,
            'date' => '2026-01-05',
            'clock_in_time' => '20:00:00',
            'clock_out_time' => '04:00:00',
            'status' => 'completed',
            'schedule_type' => 'flexi',
        ]);
        $admin = User::factory()->create(['role' => 'admin']);

        $this->actingAs($admin)->postJson('/api/payroll/generate', [
            'cutoff_start' => '2026-01-05', 'cutoff_end' => '2026-01-05',
        ])->assertOk();

        $payroll = \App\Models\Payroll::where('employee_id', $employee->id)->sole();
        $ndLine = collect($payroll->allowances)->firstWhere('label', 'Night Differential (6 hrs)');
        $this->assertNotNull($ndLine);
        $this->assertEquals(75.00, (float) $ndLine['amount']);
    }

    public function test_fixed_day_shift_overtime_into_night_window_earns_partial_night_differential()
    {
        $employee = $this->makePayEmployee('3');
        AttendanceLog::create([
            'employee_id' => $employee->id,
            'date' => '2026-01-05',
            'clock_in_time' => '09:00:00',
            'clock_out_time' => '23:30:00',
            'status' => 'overtime',
        ]);
        $admin = User::factory()->create(['role' => 'admin']);

        $this->actingAs($admin)->postJson('/api/payroll/generate', [
            'cutoff_start' => '2026-01-05', 'cutoff_end' => '2026-01-05',
        ])->assertOk();

        $payroll = \App\Models\Payroll::where('employee_id', $employee->id)->sole();
        $ndLine = collect($payroll->allowances)->firstWhere('label', 'Night Differential (1.5 hrs)');
        $this->assertNotNull($ndLine);
        // No schedule assigned -> default work window 09:00-18:00, expectedHours = 9.
        // hours_worked = 14.5, so overtime_hours = 14.5 - 9 = 5.5. The OT tail is the
        // last 5.5h of the shift = 18:00->23:30, which contains ALL 1.5 night hours
        // (22:00-23:30) -> every night hour here is OT-rate, not base-rate.
        // 1.5h x 125 x 1.25 x 0.10 = 23.4375 -> 23.44
        $this->assertEquals(23.44, (float) $ndLine['amount']);
    }

    public function test_rest_day_night_shift_earns_night_differential_at_rest_day_rate()
    {
        $employee = $this->makePayEmployee('7');
        AttendanceLog::create([
            'employee_id' => $employee->id,
            'date' => '2026-01-05',
            'clock_in_time' => '22:00:00',
            'clock_out_time' => '06:00:00',
            'status' => 'rest_day',
        ]);
        $admin = User::factory()->create(['role' => 'admin']);

        $this->actingAs($admin)->postJson('/api/payroll/generate', [
            'cutoff_start' => '2026-01-05', 'cutoff_end' => '2026-01-05',
        ])->assertOk();

        $payroll = \App\Models\Payroll::where('employee_id', $employee->id)->sole();
        $ndLine = collect($payroll->allowances)->firstWhere('label', 'Night Differential (8 hrs)');
        $this->assertNotNull($ndLine);
        // All 8 night hours are rest-day regular hours (no OT approved: 8h worked <
        // default expected 9h). 8h x 125 x 1.30 x 0.10 = 130.00
        $this->assertEquals(130.00, (float) $ndLine['amount']);
    }

    public function test_night_overtime_hours_earn_night_differential_at_ot_rate_mixed_bucket()
    {
        $employee = $this->makePayEmployee('8');
        $template = ScheduleTemplate::create([
            'type' => 'night',
            'name' => 'Night OT Bucket Template',
            'work_days' => [1, 2, 3, 4, 5],
            'day_rules' => $this->buildWeekDayRules([1, 2, 3, 4, 5], '18:00:00', '02:00:00'),
            'start_time' => '18:00:00',
            'end_time' => '02:00:00',
            'work_start_time' => '18:00:00',
            'work_end_time' => '02:00:00',
            'required_hours_per_day' => 8,
        ]);
        $this->assignSchedule($employee, $template);

        AttendanceLog::create([
            'employee_id' => $employee->id,
            'date' => '2026-01-05',
            'clock_in_time' => '18:00:00',
            'clock_out_time' => '04:00:00',
            'status' => 'overtime',
            'schedule_type' => 'night',
        ]);
        $admin = User::factory()->create(['role' => 'admin']);

        $this->actingAs($admin)->postJson('/api/payroll/generate', [
            'cutoff_start' => '2026-01-05', 'cutoff_end' => '2026-01-05',
        ])->assertOk();

        $payroll = \App\Models\Payroll::where('employee_id', $employee->id)->sole();
        // hours_worked = 18:00->04:00 = 10h, overtime_hours = 10 - 8 = 2.
        // OT tail = shiftTimeBy('04:00:00', 2) = 02:00:00 -> tail is 02:00-04:00.
        // total night hours (22:00-06:00 overlap of 18:00-04:00) = 22:00-04:00 = 6h.
        // OT-tail night hours = overlap(02:00-04:00, 22:00-06:00) = 2h.
        // regular night hours = 6h - 2h = 4h (mixed bucket: both regular and OT).
        $ndLine = collect($payroll->allowances)->firstWhere('label', 'Night Differential (6 hrs)');
        $this->assertNotNull($ndLine);
        // 4h regular: 4 x 125 x 1.00 x 0.10 = 50.00
        // 2h OT:      2 x 125 x 1.25 x 0.10 = 31.25
        // total = 81.25
        $this->assertEquals(81.25, (float) $ndLine['amount']);
    }

    public function test_rest_day_overtime_night_hours_earn_night_differential_at_rest_day_ot_rate()
    {
        $employee = $this->makePayEmployee('9');
        AttendanceLog::create([
            'employee_id' => $employee->id,
            'date' => '2026-01-05',
            'clock_in_time' => '20:00:00',
            'clock_out_time' => '08:00:00',
            'status' => 'rest_day',
        ]);
        $admin = User::factory()->create(['role' => 'admin']);

        $this->actingAs($admin)->postJson('/api/payroll/generate', [
            'cutoff_start' => '2026-01-05', 'cutoff_end' => '2026-01-05',
        ])->assertOk();

        $payroll = \App\Models\Payroll::where('employee_id', $employee->id)->sole();
        // No schedule assigned -> default expected hours = 9. hours_worked = 20:00->08:00
        // = 12h, so overtime_hours = 12 - 9 = 3 (fixed rest day: excess hours count as OT
        // directly, no separate approval step). OT tail = shiftTimeBy('08:00:00', 3) =
        // 05:00:00 -> tail is 05:00-08:00. Total night hours (20:00-08:00 overlap with
        // 22:00-06:00) = 8h. OT-tail night hours = overlap(05:00-08:00, 22:00-06:00) = 1h.
        // Rest-day-regular night hours = 8h - 1h = 7h.
        $ndLine = collect($payroll->allowances)->firstWhere('label', 'Night Differential (8 hrs)');
        $this->assertNotNull($ndLine);
        // 7h rest-day-regular: 7 x 125 x 1.30 x 0.10 = 113.75
        // 1h rest-day-OT:      1 x 125 x 1.69 x 0.10 = 21.125
        // total = 134.875 -> rounds to 134.88
        $this->assertEquals(134.88, (float) $ndLine['amount']);
    }

    public function test_unapproved_overtime_night_hours_earn_night_differential_at_base_rate()
    {
        $employee = $this->makePayEmployee('10');
        $template = ScheduleTemplate::create([
            'type' => 'night',
            'name' => 'Unapproved OT Night Template',
            'work_days' => [1, 2, 3, 4, 5],
            'day_rules' => $this->buildWeekDayRules([1, 2, 3, 4, 5], '18:00:00', '02:00:00'),
            'start_time' => '18:00:00',
            'end_time' => '02:00:00',
            'work_start_time' => '18:00:00',
            'work_end_time' => '02:00:00',
            'required_hours_per_day' => 8,
        ]);
        $this->assignSchedule($employee, $template);

        // Same clock times as the mixed-bucket OT test above (18:00->04:00, 10h worked,
        // 2h beyond the 8h expected), but status is NOT 'overtime' -> $overtimeHours is
        // gated to 0, so none of the night hours may be treated as OT-rate, even though
        // 2h of the shift is technically beyond the expected hours.
        AttendanceLog::create([
            'employee_id' => $employee->id,
            'date' => '2026-01-05',
            'clock_in_time' => '18:00:00',
            'clock_out_time' => '04:00:00',
            'status' => 'completed',
            'schedule_type' => 'night',
        ]);
        $admin = User::factory()->create(['role' => 'admin']);

        $this->actingAs($admin)->postJson('/api/payroll/generate', [
            'cutoff_start' => '2026-01-05', 'cutoff_end' => '2026-01-05',
        ])->assertOk();

        $payroll = \App\Models\Payroll::where('employee_id', $employee->id)->sole();
        $ndLine = collect($payroll->allowances)->firstWhere('label', 'Night Differential (6 hrs)');
        $this->assertNotNull($ndLine);
        // All 6 night hours at base rate (no approved OT): 6 x 125 x 1.00 x 0.10 = 75.00
        // (contrast with the mixed-bucket test's 81.25 for the same clock times, where
        // status = 'overtime' pushed 2h of it into the OT bucket)
        $this->assertEquals(75.00, (float) $ndLine['amount']);
    }

    public function test_pure_day_shift_has_no_night_differential_line()
    {
        $employee = $this->makePayEmployee('4');
        AttendanceLog::create([
            'employee_id' => $employee->id,
            'date' => '2026-01-05',
            'clock_in_time' => '09:00:00',
            'clock_out_time' => '18:00:00',
            'status' => 'completed',
        ]);
        $admin = User::factory()->create(['role' => 'admin']);

        $this->actingAs($admin)->postJson('/api/payroll/generate', [
            'cutoff_start' => '2026-01-05', 'cutoff_end' => '2026-01-05',
        ])->assertOk();

        $payroll = \App\Models\Payroll::where('employee_id', $employee->id)->sole();
        $hasNdLine = collect($payroll->allowances)->contains(
            fn($a) => str_starts_with($a['label'], 'Night Differential')
        );
        $this->assertFalse($hasNdLine);
    }

    public function test_night_differential_is_included_in_taxable_gross_pay()
    {
        $nightEmployee = $this->makePayEmployee('5n');
        AttendanceLog::create([
            'employee_id' => $nightEmployee->id,
            'date' => '2026-01-05',
            'clock_in_time' => '22:00:00',
            'clock_out_time' => '06:00:00',
            'status' => 'completed',
            'schedule_type' => 'night',
        ]);

        $dayEmployee = $this->makePayEmployee('5d');
        AttendanceLog::create([
            'employee_id' => $dayEmployee->id,
            'date' => '2026-01-05',
            'clock_in_time' => '09:00:00',
            'clock_out_time' => '18:00:00',
            'status' => 'completed',
        ]);

        $admin = User::factory()->create(['role' => 'admin']);
        $this->actingAs($admin)->postJson('/api/payroll/generate', [
            'cutoff_start' => '2026-01-05', 'cutoff_end' => '2026-01-05',
        ])->assertOk();

        $nightPayroll = \App\Models\Payroll::where('employee_id', $nightEmployee->id)->sole();
        $dayPayroll = \App\Models\Payroll::where('employee_id', $dayEmployee->id)->sole();

        $this->assertEquals(
            100.00,
            round(((float) $nightPayroll->gross_pay) - ((float) $dayPayroll->gross_pay), 2)
        );
    }

    public function test_overnight_shift_counts_as_a_single_day_worked_not_two()
    {
        $employee = $this->makePayEmployee('6');
        AttendanceLog::create([
            'employee_id' => $employee->id,
            'date' => '2026-01-05',
            'clock_in_time' => '22:00:00',
            'clock_out_time' => '06:00:00',
            'status' => 'completed',
            'schedule_type' => 'night',
        ]);
        $admin = User::factory()->create(['role' => 'admin']);

        $this->actingAs($admin)->postJson('/api/payroll/generate', [
            'cutoff_start' => '2026-01-05', 'cutoff_end' => '2026-01-05',
        ])->assertOk();

        $payroll = \App\Models\Payroll::where('employee_id', $employee->id)->sole();
        $this->assertSame(1, $payroll->days_worked);
    }
}
