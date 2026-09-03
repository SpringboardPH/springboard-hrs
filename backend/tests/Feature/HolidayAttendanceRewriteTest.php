<?php

namespace Tests\Feature;

use App\Models\AttendanceLog;
use App\Models\CalendarEvent;
use App\Models\CalendarEventType;
use App\Models\Employee;
use App\Models\EmployeeSchedule;
use App\Models\Payroll;
use App\Models\ScheduleTemplate;
use App\Models\User;
use App\Services\HolidayAttendanceService;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class HolidayAttendanceRewriteTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;
    private HolidayAttendanceService $service;

    protected function setUp(): void
    {
        parent::setUp();
        $this->admin = User::factory()->create(['role' => 'admin']);
        $this->service = app(HolidayAttendanceService::class);
    }

    private function makeEmployee(string $suffix, string $rateType = 'daily'): Employee
    {
        return Employee::create([
            'employee_id' => "EMP-HOL-$suffix",
            'first_name'  => 'Holiday',
            'last_name'   => $suffix,
            'email'       => "hol-$suffix@example.com",
            'position'    => 'Tester',
            'hire_date'   => '2026-01-01',
            'salary'      => 1000,
            'rate_type'   => $rateType,
            'status'      => 'active',
        ]);
    }

    private function makeType(string $name, bool $countsAsAbsence = false): CalendarEventType
    {
        return CalendarEventType::firstOrCreate(
            ['name' => $name],
            [
                'description' => $name,
                'color' => '#ef4444',
                'counts_as_absence' => $countsAsAbsence,
                'created_by' => $this->admin->id,
            ]
        );
    }

    private function calendarDay(string $date, string $typeName, bool $countsAsAbsence = false): CalendarEvent
    {
        $type = $this->makeType($typeName, $countsAsAbsence);

        return CalendarEvent::create([
            'calendar_event_type_id' => $type->id,
            'event_date' => $date,
            'title' => $typeName,
            'created_by' => $this->admin->id,
        ]);
    }

    private function absentLog(Employee $employee, string $date, string $status = 'absent'): AttendanceLog
    {
        return AttendanceLog::create([
            'employee_id' => $employee->id,
            'date' => $date,
            'status' => $status,
            'clock_in_time' => $status === 'completed' ? '09:00:00' : null,
            'clock_out_time' => $status === 'completed' ? '18:00:00' : null,
        ]);
    }

    private function weekdayTemplate(): ScheduleTemplate
    {
        $rules = [];
        for ($day = 0; $day <= 6; $day++) {
            $enabled = $day >= 1 && $day <= 5;
            $rules[] = [
                'day' => $day,
                'enabled' => $enabled,
                'clock_in' => $enabled ? '09:00:00' : null,
                'clock_out' => $enabled ? '18:00:00' : null,
                'grace_enabled' => $enabled,
                'grace_type' => '-/+',
                'grace_minutes' => 15,
            ];
        }

        return ScheduleTemplate::create([
            'type' => 'fixed',
            'name' => 'Weekday 9-6',
            'work_days' => [1, 2, 3, 4, 5],
            'day_rules' => $rules,
            'start_time' => '09:00:00',
            'end_time' => '18:00:00',
            'work_start_time' => '09:00:00',
            'work_end_time' => '18:00:00',
            'required_hours_per_day' => 8,
        ]);
    }

    private function assignSchedule(
        Employee $employee,
        ScheduleTemplate $template,
        string $start = '2026-01-01',
        string $end = '2026-01-31',
    ): void {
        EmployeeSchedule::create([
            'employee_id' => $employee->id,
            'schedule_template_id' => $template->id,
            'start_date' => $start,
            'end_date' => $end,
            'status' => 'active',
        ]);
    }

    private function generate(string $start, ?string $end = null): void
    {
        $end ??= $start;
        $this->actingAs($this->admin)->postJson('/api/payroll/generate', [
            'cutoff_start' => $start,
            'cutoff_end' => $end,
        ])->assertOk();
    }

    public function test_preview_lists_absents_to_convert(): void
    {
        $employee = $this->makeEmployee('CONVERT');
        $log = $this->absentLog($employee, '2026-01-05');

        $plan = $this->service->preview(['2026-01-05']);

        $this->assertCount(1, $plan->convert);
        $this->assertSame($log->id, $plan->convert[0]->log_id);
        $this->assertSame($employee->id, $plan->convert[0]->employee_id);
        $this->assertSame('Holiday CONVERT', $plan->convert[0]->employee_name);
        $this->assertSame('2026-01-05', $plan->convert[0]->date);
        $this->assertSame([], $plan->skipped_sandwich);
    }

    public function test_sandwich_absent_yesterday_or_tomorrow_is_skipped(): void
    {
        $yesterday = $this->makeEmployee('YDAY');
        $this->absentLog($yesterday, '2026-01-04');
        $this->absentLog($yesterday, '2026-01-05');

        $tomorrow = $this->makeEmployee('TMRW');
        $this->absentLog($tomorrow, '2026-01-05');
        $this->absentLog($tomorrow, '2026-01-06');

        $plan = $this->service->preview(['2026-01-05']);

        $this->assertCount(0, $plan->convert);
        $this->assertCount(2, $plan->skipped_sandwich);
        $skippedIds = collect($plan->skipped_sandwich)->pluck('employee_id')->sort()->values()->all();
        $this->assertSame([$yesterday->id, $tomorrow->id], $skippedIds);
    }

    public function test_on_leave_and_completed_logs_are_not_converted(): void
    {
        $leave = $this->makeEmployee('LEAVE');
        $this->absentLog($leave, '2026-01-05', 'on_leave');
        $done = $this->makeEmployee('DONE');
        $this->absentLog($done, '2026-01-05', 'completed');

        $plan = $this->service->preview(['2026-01-05']);

        $this->assertCount(0, $plan->convert);
        $this->assertCount(0, $plan->skipped_sandwich);
    }

    public function test_apply_converts_only_absent_and_second_apply_is_zero(): void
    {
        $employee = $this->makeEmployee('APPLY');
        $log = $this->absentLog($employee, '2026-01-05');
        $plan = $this->service->preview(['2026-01-05']);

        $this->assertSame(1, $this->service->apply($plan));
        $log->refresh();
        $this->assertSame('holiday', $log->status);
        $this->assertNull($log->clock_in_time);
        $this->assertNull($log->clock_out_time);

        $this->assertSame(0, $this->service->apply($plan));
    }

    public function test_store_regular_holiday_without_flag_returns_409_and_creates_nothing(): void
    {
        $employee = $this->makeEmployee('GATE');
        $this->absentLog($employee, '2026-01-05');
        $type = $this->makeType('Regular Holiday');

        $this->actingAs($this->admin)->postJson('/api/admin/calendar-events', [
            'calendar_event_type_id' => $type->id,
            'event_date' => '2026-01-05',
            'title' => 'New Year',
        ])->assertStatus(409)
            ->assertJsonPath('success', false)
            ->assertJsonPath('data.requires_confirmation', true);

        $this->assertSame(0, CalendarEvent::count());
        $this->assertSame('absent', AttendanceLog::where('employee_id', $employee->id)->sole()->status);
    }

    public function test_store_with_apply_flag_creates_event_and_sets_holiday_clocks_null(): void
    {
        $employee = $this->makeEmployee('REWRITE');
        $log = $this->absentLog($employee, '2026-01-05', 'absent');
        $log->update(['clock_in_time' => '09:00:00', 'clock_out_time' => '10:00:00']);
        $type = $this->makeType('Regular Holiday');

        $this->actingAs($this->admin)->postJson('/api/admin/calendar-events', [
            'calendar_event_type_id' => $type->id,
            'event_date' => '2026-01-05',
            'title' => 'New Year',
            'apply_holiday_rewrite' => true,
        ])->assertCreated();

        $this->assertSame(1, CalendarEvent::count());
        $log->refresh();
        $this->assertSame('holiday', $log->status);
        $this->assertNull($log->clock_in_time);
        $this->assertNull($log->clock_out_time);
    }

    public function test_company_event_creates_without_409_and_does_not_change_absents(): void
    {
        $employee = $this->makeEmployee('COMPANY');
        $log = $this->absentLog($employee, '2026-01-05');
        $type = $this->makeType('Company Event', true);

        $this->actingAs($this->admin)->postJson('/api/admin/calendar-events', [
            'calendar_event_type_id' => $type->id,
            'event_date' => '2026-01-05',
            'title' => 'Town Hall',
        ])->assertCreated();

        $this->assertSame(1, CalendarEvent::count());
        $this->assertSame('absent', $log->fresh()->status);
    }

    public function test_mark_absent_on_holiday_with_no_log_inserts_holiday(): void
    {
        $employee = $this->makeEmployee('MARK');
        $this->assignSchedule($employee, $this->weekdayTemplate());
        $this->calendarDay('2026-01-05', 'Regular Holiday');

        $this->artisan('attendance:mark-absent', ['date' => '2026-01-05'])->assertSuccessful();

        $log = AttendanceLog::where('employee_id', $employee->id)->whereDate('date', '2026-01-05')->sole();
        $this->assertSame('holiday', $log->status);
        $this->assertSame('[System] Automatically marked holiday.', $log->clock_in_notes);
    }

    public function test_mark_absent_holiday_with_prev_day_absent_inserts_absent(): void
    {
        $employee = $this->makeEmployee('SANDWICH');
        $this->assignSchedule($employee, $this->weekdayTemplate());
        $this->calendarDay('2026-01-05', 'Regular Holiday');
        $this->absentLog($employee, '2026-01-04');

        $this->artisan('attendance:mark-absent', ['date' => '2026-01-05'])->assertSuccessful();

        $log = AttendanceLog::where('employee_id', $employee->id)->whereDate('date', '2026-01-05')->sole();
        $this->assertSame('absent', $log->status);
    }

    public function test_stored_holiday_regular_holiday_credits_days_worked(): void
    {
        $employee = $this->makeEmployee('CREDIT');
        $this->calendarDay('2026-01-05', 'Regular Holiday');
        AttendanceLog::create([
            'employee_id' => $employee->id,
            'date' => '2026-01-05',
            'status' => 'holiday',
        ]);

        $this->generate('2026-01-05');

        $payroll = Payroll::where('employee_id', $employee->id)->sole();
        $this->assertEquals(1, $payroll->days_worked);
        $this->assertEquals(1000.00, (float) $payroll->gross_pay);
    }

    public function test_stored_holiday_snwh_stays_unpaid(): void
    {
        $employee = $this->makeEmployee('SNWH');
        $this->calendarDay('2026-01-05', 'Special Non-Working Day');
        AttendanceLog::create([
            'employee_id' => $employee->id,
            'date' => '2026-01-05',
            'status' => 'holiday',
        ]);

        $this->generate('2026-01-05');

        $payroll = Payroll::where('employee_id', $employee->id)->sole();
        $this->assertEquals(0, $payroll->days_worked);
        $this->assertEquals(0.00, (float) $payroll->gross_pay);
    }

    public function test_sandwiched_absent_on_regular_holiday_is_docked_not_credited(): void
    {
        $employee = $this->makeEmployee('DOCK');
        $this->calendarDay('2026-01-05', 'Regular Holiday');
        $this->absentLog($employee, '2026-01-04');
        $this->absentLog($employee, '2026-01-05');

        $this->generate('2026-01-05');

        $payroll = Payroll::where('employee_id', $employee->id)->sole();
        $this->assertEquals(0, $payroll->days_worked);
        $deductions = is_array($payroll->deductions) ? $payroll->deductions : [];
        $this->assertEquals(1000.00, (float) ($deductions['Absent'] ?? 0));
    }

    public function test_include_absentees_does_not_fabricate_absent_or_sandwich_stored_holiday(): void
    {
        $employee = $this->makeEmployee('GRID');
        $this->assignSchedule($employee, $this->weekdayTemplate(), '2026-08-01', '2026-09-30');
        $this->calendarDay('2026-08-31', 'Regular Holiday');
        $this->absentLog($employee, '2026-08-31', 'holiday');

        $rows = $this->actingAs($this->admin)->getJson(
            '/api/attendance?start_date=2026-08-26&end_date=2026-09-10&include_absentees=true&employee_id='.$employee->id
        )->assertOk()->json('data');

        $byDate = collect($rows)->mapWithKeys(function ($row) {
            $dateStr = Carbon::parse(data_get($row, 'date'))->timezone('Asia/Manila')->toDateString();

            return [$dateStr => data_get($row, 'status')];
        });

        $this->assertSame('holiday', $byDate->get('2026-08-31'));
        $this->assertNull($byDate->get('2026-09-01'));
        $this->assertSame(0, AttendanceLog::query()
            ->where('employee_id', $employee->id)
            ->whereDate('date', '2026-09-01')
            ->count());
    }
}
