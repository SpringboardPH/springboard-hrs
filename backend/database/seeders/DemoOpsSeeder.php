<?php

namespace Database\Seeders;

use App\Helpers\SystemClock;
use App\Models\AttendanceLog;
use App\Models\CalendarEvent;
use App\Models\CalendarEventType;
use App\Models\Employee;
use App\Models\EmployeeRequest;
use App\Models\EmployeeSchedule;
use App\Models\LeaveRequest;
use App\Models\Loan;
use App\Models\LoanPayment;
use App\Models\Payroll;
use App\Models\SystemSettings;
use App\Models\User;
use Carbon\Carbon;
use Carbon\CarbonPeriod;
use Illuminate\Database\Seeder;

class DemoOpsSeeder extends Seeder
{
    public function run(): void
    {
        $today = SystemClock::today();
        [$priorStart, $priorEnd, $currentStart] = $this->cutoffWindows($today);
        $employees = Employee::query()->where('status', 'active')->with('user')->get();
        $byEmail = $employees->keyBy('email');
        $juan = $byEmail->get('juan@springboardph.com');
        $hrUser = User::where('email', 'hr@springboardph.com')->first();
        $adminUser = User::where('email', 'dev@springboardph.com')->first();

        $approvedLeaves = $this->seedLeaveRequests($byEmail, $hrUser, $adminUser, $today);
        $this->seedGeoSettings();
        $this->seedAttendance($employees, $juan, $priorStart, $today, $approvedLeaves);
        $this->seedEmployeeRequests($byEmail, $hrUser, $today);
        $this->seedCalendarEvents($adminUser, $today);
        $loans = $this->seedLoans($byEmail, $hrUser, $priorStart);
        $this->seedPayrolls($employees, $priorStart, $priorEnd, $loans);
    }

    private function cutoffWindows(Carbon $today): array
    {
        $day = (int) $today->day;
        if ($day <= 10) {
            $priorStart = $today->copy()->subMonthNoOverflow()->day(11);
            $priorEnd = $today->copy()->subMonthNoOverflow()->day(25);
            $currentStart = $today->copy()->subMonthNoOverflow()->day(26);
        } elseif ($day <= 25) {
            $priorStart = $today->copy()->subMonthNoOverflow()->day(26);
            $priorEnd = $today->copy()->day(10);
            $currentStart = $today->copy()->day(11);
        } else {
            $priorStart = $today->copy()->day(11);
            $priorEnd = $today->copy()->day(25);
            $currentStart = $today->copy()->day(26);
        }

        return [$priorStart->startOfDay(), $priorEnd->startOfDay(), $currentStart->startOfDay()];
    }

    private function seedGeoSettings(): void
    {
        SystemSettings::set(
            'office_locations',
            [
                [
                    'name' => 'Springboard BGC',
                    'lat' => 14.5547290,
                    'lng' => 121.0244450,
                    'radius_m' => 200,
                ],
            ],
            'Allowed clock-in zones: [{name, lat, lng, radius_m}]',
            'json'
        );
        SystemSettings::set('geo_capture_enabled', true, 'Master switch: whether clock-in captures employee location at all', 'boolean');
        SystemSettings::set('geofence_enabled', true, 'Whether clock-in is restricted to configured office locations', 'boolean');
        SystemSettings::set('geofence_mode', 'warn', 'Geofence behavior: enforce (block) or warn (allow but record)', 'string');
    }

    private function officeCoords(string $seed): array
    {
        $n = crc32($seed);
        $latJitter = (($n % 900) - 450) / 1_000_000;
        $lngJitter = ((($n >> 9) % 900) - 450) / 1_000_000;

        return [
            'clock_in_lat' => round(14.5547290 + $latJitter, 7),
            'clock_in_lng' => round(121.0244450 + $lngJitter, 7),
        ];
    }

    private function seedLeaveRequests($byEmail, ?User $hrUser, ?User $adminUser, Carbon $today): array
    {
        $hrId = $hrUser?->id;
        $rows = [
            [$byEmail->get('juan@springboardph.com'), 'vacation', $today->copy()->addWeekdays(5)->toDateString(), $today->copy()->addWeekdays(7)->toDateString(), 'Family trip to Bohol', 'pending', null, null],
            [$byEmail->get('liza.torres@springboardph.com'), 'sick', $today->copy()->addWeekdays(2)->toDateString(), $today->copy()->addWeekdays(2)->toDateString(), 'Medical appointment', 'pending', null, null],
            [$byEmail->get('carlos.mendoza@springboardph.com'), 'vacation', $today->copy()->subDays(20)->toDateString(), $today->copy()->subDays(18)->toDateString(), 'Personal errands', 'approved', $hrId, null],
            [$byEmail->get('sofia.villanueva@springboardph.com'), 'sick', $today->copy()->subDays(12)->toDateString(), $today->copy()->subDays(12)->toDateString(), 'Flu recovery', 'approved', $hrId, null],
            [$byEmail->get('accounting@springboardph.com'), 'vacation', $today->copy()->subDays(35)->toDateString(), $today->copy()->subDays(33)->toDateString(), 'Provincial visit', 'approved', $hrId, null],
            [$byEmail->get('diego.bautista@springboardph.com'), 'vacation', $today->copy()->subDays(8)->toDateString(), $today->copy()->subDays(8)->toDateString(), 'Long weekend plans', 'rejected', $hrId, 'Insufficient coverage that week'],
            [$byEmail->get('hr@springboardph.com'), 'sick', $today->copy()->subDays(5)->toDateString(), $today->copy()->subDays(5)->toDateString(), 'Clinic checkup', 'approved', $adminUser?->id, null],
        ];

        $approvedByDate = [];
        foreach ($rows as [$employee, $type, $start, $end, $reason, $status, $approverId, $rejection]) {
            if (!$employee) {
                continue;
            }
            LeaveRequest::updateOrCreate(
                ['employee_id' => $employee->id, 'start_date' => $start, 'end_date' => $end, 'leave_type' => $type],
                ['days_requested' => 1, 'reason' => $reason, 'status' => $status, 'approver_id' => $approverId, 'rejection_reason' => $rejection]
            );
            if ($status !== 'approved') {
                continue;
            }
            foreach (CarbonPeriod::create($start, $end) as $d) {
                if (!$d->isWeekend()) {
                    $approvedByDate[$employee->id.'|'.$d->toDateString()] = true;
                }
            }
        }

        return $approvedByDate;
    }

    private function seedAttendance($employees, ?Employee $juan, Carbon $rangeStart, Carbon $rangeEnd, array $approvedLeaves): void
    {
        if ($rangeEnd->lt($rangeStart)) {
            return;
        }

        $todayStr = SystemClock::today()->toDateString();
        $scheduleCache = [];
        foreach ($employees as $employee) {
            $scheduleCache[$employee->id] = EmployeeSchedule::getCurrentForEmployee($employee->id);
        }

        foreach (CarbonPeriod::create($rangeStart, $rangeEnd) as $date) {
            if ($date->isWeekend()) {
                continue;
            }
            $dateStr = $date->toDateString();
            foreach ($employees as $employee) {
                if ($juan && $employee->id === $juan->id && $dateStr === $todayStr) {
                    continue;
                }

                $template = $scheduleCache[$employee->id]?->template;
                $attrs = [
                    'schedule_template_id' => $template?->id,
                    'schedule_template_name' => $template?->name,
                    'schedule_type' => $template?->type ?: 'fixed',
                ];
                $leaveKey = $employee->id.'|'.$dateStr;
                $bucket = crc32($employee->employee_id.$dateStr) % 100;

                if (isset($approvedLeaves[$leaveKey])) {
                    $payload = ['clock_in_time' => null, 'clock_out_time' => null, 'status' => 'on_leave', 'clock_in_lat' => null, 'clock_in_lng' => null];
                } elseif ($dateStr === $todayStr) {
                    if ($bucket < 28) {
                        $payload = ['clock_in_time' => null, 'clock_out_time' => null, 'status' => 'absent', 'clock_in_lat' => null, 'clock_in_lng' => null];
                    } else {
                        $payload = array_merge([
                            'clock_in_time' => $dateStr.' 09:0'.($bucket % 5).':00',
                            'clock_out_time' => null,
                            'status' => 'working',
                        ], $this->officeCoords($employee->employee_id.$dateStr));
                    }
                } elseif ($bucket < 8) {
                    $payload = ['clock_in_time' => null, 'clock_out_time' => null, 'status' => 'absent', 'clock_in_lat' => null, 'clock_in_lng' => null];
                } elseif ($bucket < 18) {
                    $payload = array_merge([
                        'clock_in_time' => $dateStr.' 09:25:00',
                        'clock_out_time' => $dateStr.' 18:05:00',
                        'status' => 'late',
                    ], $this->officeCoords($employee->employee_id.$dateStr));
                } else {
                    $payload = array_merge([
                        'clock_in_time' => $dateStr.' 09:02:00',
                        'clock_out_time' => $dateStr.' 18:05:00',
                        'status' => 'completed',
                    ], $this->officeCoords($employee->employee_id.$dateStr));
                }

                AttendanceLog::updateOrCreate(
                    ['employee_id' => $employee->id, 'date' => $dateStr],
                    array_merge($attrs, $payload)
                );
            }
        }
    }

    private function seedEmployeeRequests($byEmail, ?User $hrUser, Carbon $today): void
    {
        $rows = [
            [$byEmail->get('juan@springboardph.com'), 'overtime', 'OT for release cutover', 'Need 3 hours OT to finish payroll UI cutover.', 'pending', null, ['hours' => 3, 'date' => $today->copy()->subDays(1)->toDateString()]],
            [$byEmail->get('carlos.mendoza@springboardph.com'), 'concern', 'Wrong clock-out time', 'Biometrics logged 17:10 but I left at 18:00.', 'pending', null, ['date' => $today->copy()->subDays(2)->toDateString()]],
            [$byEmail->get('andre.castillo@springboardph.com'), 'overtime', 'Sprint demo prep OT', 'Approved OT for sprint demo prep.', 'approved', $hrUser?->id, ['hours' => 2, 'date' => $today->copy()->subDays(10)->toDateString()]],
        ];

        foreach ($rows as [$employee, $type, $subject, $details, $status, $approverId, $meta]) {
            if (!$employee) {
                continue;
            }
            EmployeeRequest::updateOrCreate(
                ['employee_id' => $employee->id, 'request_type' => $type, 'subject' => $subject],
                [
                    'details' => $details,
                    'meta' => $meta,
                    'status' => $status,
                    'approver_id' => $approverId,
                    'response_notes' => $status === 'approved' ? 'Approved for demo' : null,
                ]
            );
        }
    }

    private function seedCalendarEvents(?User $admin, Carbon $today): void
    {
        $types = CalendarEventType::query()->get()->keyBy('name');
        $year = (int) $today->year;
        $events = [
            ['Regular Holiday', sprintf('%d-06-12', $year), null, 'Independence Day', 'National holiday', false],
            ['Regular Holiday', sprintf('%d-12-25', $year), null, 'Christmas Day', 'National holiday', false],
            ['Special Non-Working Day', sprintf('%d-11-01', $year), null, 'All Saints Day', 'Special non-working day', false],
            ['Company Event', $today->copy()->addDays(14)->toDateString(), $today->copy()->addDays(14)->toDateString(), 'Q-Townhall', 'Company all-hands', true],
        ];

        foreach ($events as [$typeName, $eventDate, $endDate, $title, $description, $counts]) {
            $type = $types->get($typeName);
            if (!$type) {
                continue;
            }
            CalendarEvent::updateOrCreate(
                ['title' => $title, 'event_date' => $eventDate],
                [
                    'calendar_event_type_id' => $type->id,
                    'end_date' => $endDate ?? $eventDate,
                    'description' => $description,
                    'color' => $type->color,
                    'counts_as_absence' => $counts,
                    'created_by' => $admin?->id,
                ]
            );
        }
    }

    private function seedLoans($byEmail, ?User $hrUser, Carbon $priorStart): array
    {
        $defs = [
            [$byEmail->get('pedro.reyes@springboardph.com'), 'sss_salary', 24000, 0, 24000, 2000, 12, 22000],
            [$byEmail->get('miguel.ramos@springboardph.com'), 'pagibig_mpl', 18000, 0, 18000, 1500, 12, 16500],
            [$byEmail->get('joy.mercado@springboardph.com'), 'cash_advance', 10000, 0.05, 10500, 2625, 4, 7875],
        ];

        $loans = [];
        foreach ($defs as [$employee, $loanType, $principal, $rate, $payable, $installment, $terms, $balance]) {
            if (!$employee) {
                continue;
            }
            $loans[] = Loan::updateOrCreate(
                ['employee_id' => $employee->id, 'loan_type' => $loanType, 'start_cutoff' => $priorStart->toDateString()],
                [
                    'principal' => $principal,
                    'interest_rate' => $rate,
                    'total_payable' => $payable,
                    'installment_amount' => $installment,
                    'term_count' => $terms,
                    'balance' => $balance,
                    'status' => 'active',
                    'approver_id' => $hrUser?->id,
                    'notes' => 'Demo seed loan',
                ]
            );
        }

        return $loans;
    }

    private function seedPayrolls($employees, Carbon $priorStart, Carbon $priorEnd, array $loans): void
    {
        foreach ($employees as $employee) {
            if ($employee->user && $employee->user->role === 'admin') {
                continue;
            }

            $salary = (float) $employee->salary;
            $dailyRate = $employee->rate_type === 'daily' ? $salary : round(($salary * 12) / 261, 2);
            $daysWorked = 10 + (crc32($employee->employee_id) % 2);
            $gross = round($dailyRate * $daysWorked, 2);
            $sss = 675;
            $philhealth = round(($salary * 0.05 * 0.5) / 2, 2);
            $pagibig = round((min($salary, 10000) * 0.02) / 2, 2);
            $tax = 500;
            $net = round($gross - ($sss + $philhealth + $pagibig + $tax), 2);

            $payroll = Payroll::updateOrCreate(
                [
                    'employee_id' => $employee->id,
                    'cutoff_start' => $priorStart->toDateString(),
                    'cutoff_end' => $priorEnd->toDateString(),
                ],
                [
                    'base_salary' => $salary,
                    'undeclared_salary' => $employee->undeclared_salary,
                    'daily_rate' => $dailyRate,
                    'total_hours' => $daysWorked * 9,
                    'days_worked' => $daysWorked,
                    'overtime_hours' => 0,
                    'late_minutes' => crc32($employee->employee_id) % 20,
                    'undertime_minutes' => 0,
                    'gross_pay' => $gross,
                    'deductions' => [
                        'SSS EE Contribution' => $sss,
                        'PhilHealth EE' => $philhealth,
                        'Pag-IBIG EE' => $pagibig,
                        'Withholding Tax' => $tax,
                    ],
                    'allowances' => [],
                    'net_pay' => $net,
                    'status' => 'finalized',
                    'use_undeclared' => false,
                    'processed_at' => $priorEnd->copy()->addDay()->setTime(10, 0),
                ]
            );

            $loan = collect($loans)->first(fn ($l) => $l->employee_id === $employee->id && $l->loan_type === 'sss_salary');
            if ($loan) {
                LoanPayment::updateOrCreate(
                    ['loan_id' => $loan->id, 'payroll_id' => $payroll->id],
                    [
                        'amount' => $loan->installment_amount,
                        'cutoff_start' => $priorStart->toDateString(),
                        'cutoff_end' => $priorEnd->toDateString(),
                    ]
                );
            }
        }
    }
}
