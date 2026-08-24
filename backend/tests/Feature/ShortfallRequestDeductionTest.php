<?php

namespace Tests\Feature;

use App\Models\AttendanceLog;
use App\Models\Employee;
use App\Models\EmployeeRequest;
use App\Models\Payroll;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * Undertime is a pay-changing deviation whose request polarity is the inverse of
 * overtime: approving an auto-filed undertime EXCUSES it; rejecting applies the
 * deduction. Half-day is different — approving confirms the half day and docks
 * half a day's pay rather than rewriting the log to completed.
 */
class ShortfallRequestDeductionTest extends TestCase
{
    use RefreshDatabase;

    private const CUTOFF = '2026-01-05';

    /** No schedule assigned -> default work window 09:00-18:00, daily rate 1000, hourly 125. */
    private function makeEmployee(string $suffix): Employee
    {
        return Employee::create([
            'employee_id' => 'EMP-SHORT-' . $suffix,
            'first_name'  => 'Short',
            'last_name'   => 'Fall' . $suffix,
            'email'       => 'short-fall-' . strtolower($suffix) . '@example.com',
            'position'    => 'Tester',
            'hire_date'   => '2026-01-01',
            'salary'      => 1000,
            'rate_type'   => 'daily',
            'status'      => 'active',
        ]);
    }

    /** Clocked in on time, left at 13:00 — 5h short of the 18:00 scheduled end. */
    private function makeShortLog(Employee $employee, string $status = 'completed'): AttendanceLog
    {
        return AttendanceLog::create([
            'employee_id'    => $employee->id,
            'date'           => self::CUTOFF,
            'clock_in_time'  => '09:00:00',
            'clock_out_time' => '13:00:00',
            'status'         => $status,
        ]);
    }

    private function makeAutoFiledRequest(AttendanceLog $log, string $type = 'undertime'): EmployeeRequest
    {
        EmployeeRequest::autoFile($log, $type, 'Undertime on Jan 05, 2026', 'Short by 5h.', [
            'hours_worked'      => 4.0,
            'required_hours'    => 9,
            'undertime_minutes' => 300,
        ]);

        return EmployeeRequest::where('employee_id', $log->employee_id)->sole();
    }

    private function generatePayroll(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $this->actingAs($admin)->postJson('/api/payroll/generate', [
            'cutoff_start' => self::CUTOFF,
            'cutoff_end'   => self::CUTOFF,
        ])->assertOk();
    }

    public function test_approving_an_auto_filed_shortfall_excuses_the_deduction()
    {
        $employee = $this->makeEmployee('A');
        $log = $this->makeShortLog($employee);
        $request = $this->makeAutoFiledRequest($log);

        $hr = User::factory()->create(['role' => 'hr']);
        $this->actingAs($hr)
            ->patchJson("/api/requests/{$request->id}/approve", ['response_notes' => 'Excused.'])
            ->assertOk();

        // Approval must NOT stamp the shortfall onto the log.
        $this->assertEquals('completed', $log->fresh()->status);

        $this->generatePayroll();

        $payroll = Payroll::where('employee_id', $employee->id)->sole();
        $this->assertEquals(0.0, (float) ($payroll->deductions['Undertime'] ?? 0));
    }

    public function test_rejecting_an_auto_filed_shortfall_applies_the_deduction()
    {
        $employee = $this->makeEmployee('B');
        $log = $this->makeShortLog($employee);
        $request = $this->makeAutoFiledRequest($log);

        $hr = User::factory()->create(['role' => 'hr']);
        $this->actingAs($hr)
            ->patchJson("/api/requests/{$request->id}/reject", ['response_notes' => 'Not excused.'])
            ->assertOk();

        // Rejection is what stamps the shortfall onto the log.
        $this->assertEquals('undertime', $log->fresh()->status);

        $this->generatePayroll();

        $payroll = Payroll::where('employee_id', $employee->id)->sole();
        // Left 13:00 against an 18:00 scheduled end = 300 min x (1000/8)/60 = 625.00
        $this->assertEquals(625.00, (float) $payroll->deductions['Undertime']);
    }

    public function test_a_shortfall_still_pending_at_payroll_generation_is_not_excused()
    {
        $employee = $this->makeEmployee('C');
        $log = $this->makeShortLog($employee);
        $request = $this->makeAutoFiledRequest($log);

        // Nobody actions it — generating payroll is the deadline.
        $this->generatePayroll();

        $this->assertEquals('rejected', $request->fresh()->status);
        $this->assertEquals('undertime', $log->fresh()->status);

        $payroll = Payroll::where('employee_id', $employee->id)->sole();
        $this->assertEquals(625.00, (float) $payroll->deductions['Undertime']);
    }

    /**
     * The skip-list change: 'late' is a baseline status that docks late minutes only.
     * Without it, an employee who was late AND left early would eat the full
     * early-departure deduction with no request ever being actioned.
     */
    public function test_late_status_alone_does_not_trigger_the_early_departure_deduction()
    {
        $employee = $this->makeEmployee('D');
        AttendanceLog::create([
            'employee_id'    => $employee->id,
            'date'           => self::CUTOFF,
            'clock_in_time'  => '09:05:00',
            'clock_out_time' => '13:00:00',
            'status'         => 'late',
        ]);

        $this->generatePayroll();

        $payroll = Payroll::where('employee_id', $employee->id)->sole();
        $this->assertEquals(0.0, (float) ($payroll->deductions['Undertime'] ?? 0));
        // Lateness itself is still factual and still docked: 5 min x 125 / 60 = 10.42
        $this->assertEquals(10.42, (float) $payroll->deductions['Late']);
    }

    /**
     * Approving a half-day confirms it: the log stays (or becomes) half_day and
     * payroll docks half the daily rate. Auto-filed requests must still be skipped
     * in the employee-initiated adjustment block so that dock is not applied twice.
     */
    public function test_approved_auto_filed_half_day_docks_half_a_day()
    {
        $employee = $this->makeEmployee('E');
        $log = $this->makeShortLog($employee, 'half_day');
        $request = $this->makeAutoFiledRequest($log, 'half_day');

        $hr = User::factory()->create(['role' => 'hr']);
        $this->actingAs($hr)
            ->patchJson("/api/requests/{$request->id}/approve", ['response_notes' => 'Confirmed half day.'])
            ->assertOk();

        $this->assertEquals('half_day', $log->fresh()->status);

        $this->generatePayroll();

        $payroll = Payroll::where('employee_id', $employee->id)->sole();
        $this->assertEquals(500.00, (float) ($payroll->deductions['Half Day'] ?? 0));
        $this->assertEquals(0.0, (float) ($payroll->deductions['Undertime'] ?? 0));
    }

    public function test_approving_half_day_does_not_rewrite_completed()
    {
        $employee = $this->makeEmployee('G');
        $log = $this->makeShortLog($employee, 'completed');
        $request = $this->makeAutoFiledRequest($log, 'half_day');

        $hr = User::factory()->create(['role' => 'hr']);
        $this->actingAs($hr)
            ->patchJson("/api/requests/{$request->id}/approve", ['response_notes' => 'Confirmed half day.'])
            ->assertOk();

        $this->assertEquals('half_day', $log->fresh()->status);
    }

    public function test_auto_file_does_not_stack_duplicate_requests_for_the_same_log()
    {
        $employee = $this->makeEmployee('F');
        $log = $this->makeShortLog($employee);

        $this->makeAutoFiledRequest($log);
        EmployeeRequest::autoFile($log, 'undertime', 'Undertime again', 'Duplicate attempt.', []);

        $this->assertEquals(1, EmployeeRequest::where('employee_id', $employee->id)->count());
    }
}
