<?php

namespace Tests\Feature;

use App\Models\AttendanceLog;
use App\Models\CalendarEvent;
use App\Models\CalendarEventType;
use App\Models\Employee;
use App\Models\Payroll;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class SpecialHolidayPayrollTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;

    protected function setUp(): void
    {
        parent::setUp();
        $this->admin = User::factory()->create(['role' => 'admin']);
    }

    private function makeEmployee(string $suffix): Employee
    {
        return Employee::create([
            'employee_id' => "EMP-SNWH-$suffix",
            'first_name'  => 'Snwh',
            'last_name'   => $suffix,
            'email'       => "snwh-$suffix@example.com",
            'position'    => 'Tester',
            'hire_date'   => '2026-01-01',
            'salary'      => 1000,
            'rate_type'   => 'daily',
            'status'      => 'active',
        ]);
    }

    private function calendarDay(string $date, string $typeName, bool $countsAsAbsence = false): void
    {
        $type = CalendarEventType::firstOrCreate(
            ['name' => $typeName],
            [
                'description' => $typeName,
                'color' => '#f97316',
                'counts_as_absence' => $countsAsAbsence,
                'created_by' => $this->admin->id,
            ]
        );

        CalendarEvent::create([
            'calendar_event_type_id' => $type->id,
            'event_date' => $date,
            'title' => $typeName,
            'created_by' => $this->admin->id,
        ]);
    }

    private function generate(string $date): void
    {
        $this->actingAs($this->admin)->postJson('/api/payroll/generate', [
            'cutoff_start' => $date,
            'cutoff_end' => $date,
        ])->assertOk();
    }

    private function allowance(Payroll $payroll, string $label): ?float
    {
        $row = collect($payroll->allowances)->firstWhere('label', $label);
        return $row ? (float) $row['amount'] : null;
    }

    public function test_worked_weekday_snwh_adds_thirty_percent_only(): void
    {
        $employee = $this->makeEmployee('WEEKDAY');
        $this->calendarDay('2026-01-05', 'Special Non-Working Day');

        AttendanceLog::create([
            'employee_id' => $employee->id,
            'date' => '2026-01-05',
            'clock_in_time' => '09:00:00',
            'clock_out_time' => '18:00:00',
            'status' => 'completed',
        ]);

        $this->generate('2026-01-05');

        $payroll = Payroll::where('employee_id', $employee->id)->sole();
        $this->assertEquals(300.00, $this->allowance($payroll, 'Special Holiday'));
        $this->assertEquals(1, $payroll->days_worked);
        $this->assertEquals(1300.00, (float) $payroll->gross_pay);
    }

    public function test_worked_weekday_snwh_compounds_overtime(): void
    {
        $employee = $this->makeEmployee('WEEKDAY-OT');
        $this->calendarDay('2026-01-05', 'Special Non-Working Day');

        AttendanceLog::create([
            'employee_id' => $employee->id,
            'date' => '2026-01-05',
            'clock_in_time' => '09:00:00',
            'clock_out_time' => '19:00:00',
            'status' => 'overtime',
        ]);

        $this->generate('2026-01-05');

        $payroll = Payroll::where('employee_id', $employee->id)->sole();
        $this->assertEquals(156.25, $this->allowance($payroll, 'Overtime Pay'));
        $this->assertEquals(355.00, $this->allowance($payroll, 'Special Holiday'));
        $this->assertEquals(1511.25, (float) $payroll->gross_pay);
    }

    public function test_half_day_weekday_snwh_prorates_premium(): void
    {
        $employee = $this->makeEmployee('HALF');
        $this->calendarDay('2026-01-05', 'Special Non-Working Day');

        AttendanceLog::create([
            'employee_id' => $employee->id,
            'date' => '2026-01-05',
            'clock_in_time' => '09:00:00',
            'clock_out_time' => '13:30:00',
            'status' => 'half_day',
        ]);

        $this->generate('2026-01-05');

        $payroll = Payroll::where('employee_id', $employee->id)->sole();
        $this->assertEquals(150.00, $this->allowance($payroll, 'Special Holiday'));
    }

    public function test_worked_rest_day_snwh_keeps_rest_pay_and_adds_increment(): void
    {
        $employee = $this->makeEmployee('REST');
        $this->calendarDay('2026-01-10', 'Special Non-Working Day');

        AttendanceLog::create([
            'employee_id' => $employee->id,
            'date' => '2026-01-10',
            'clock_in_time' => '09:00:00',
            'clock_out_time' => '18:00:00',
            'status' => 'rest_day',
        ]);

        $this->generate('2026-01-10');

        $payroll = Payroll::where('employee_id', $employee->id)->sole();
        $this->assertEquals(1300.00, $this->allowance($payroll, 'Rest Day Pay'));
        $this->assertEquals(200.00, $this->allowance($payroll, 'Special Holiday'));
        $this->assertEquals(1500.00, (float) $payroll->gross_pay);
    }

    public function test_worked_rest_day_snwh_with_ot_uses_one_point_ninety_five(): void
    {
        $employee = $this->makeEmployee('REST-OT');
        $this->calendarDay('2026-01-10', 'Special Non-Working Day');

        AttendanceLog::create([
            'employee_id' => $employee->id,
            'date' => '2026-01-10',
            'clock_in_time' => '09:00:00',
            'clock_out_time' => '19:00:00',
            'status' => 'rest_day',
        ]);

        $this->generate('2026-01-10');

        $payroll = Payroll::where('employee_id', $employee->id)->sole();
        $this->assertEquals(1300.00, $this->allowance($payroll, 'Rest Day Pay'));
        $this->assertEquals(211.25, $this->allowance($payroll, 'Rest Day OT Pay'));
        $this->assertEquals(232.50, $this->allowance($payroll, 'Special Holiday'));
        $this->assertEquals(1743.75, (float) $payroll->gross_pay);
    }

    public function test_unworked_snwh_is_not_a_paid_day(): void
    {
        $employee = $this->makeEmployee('UNWORKED');
        $this->calendarDay('2026-01-05', 'Special Non-Working Day');

        $this->generate('2026-01-05');

        $payroll = Payroll::where('employee_id', $employee->id)->sole();
        $this->assertNull($this->allowance($payroll, 'Special Holiday'));
        $this->assertEquals(0, $payroll->days_worked);
        $this->assertEquals(0.00, (float) $payroll->gross_pay);
    }

    public function test_unworked_regular_holiday_is_still_credited(): void
    {
        $employee = $this->makeEmployee('LEGAL');
        $this->calendarDay('2026-01-05', 'Regular Holiday');

        $this->generate('2026-01-05');

        $payroll = Payroll::where('employee_id', $employee->id)->sole();
        $this->assertNull($this->allowance($payroll, 'Special Holiday'));
        $this->assertEquals(1, $payroll->days_worked);
        $this->assertEquals(1000.00, (float) $payroll->gross_pay);
    }
}
