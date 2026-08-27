<?php

namespace Database\Seeders;

use App\Helpers\SystemClock;
use App\Models\Employee;
use App\Models\EmployeeLeaveBalance;
use App\Models\EmployeeSchedule;
use App\Models\LeaveType;
use App\Models\ScheduleTemplate;
use App\Models\User;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Schema;

class DemoPeopleSeeder extends Seeder
{
    private function personas(): array
    {
        return [
            ['employee_id' => 'EMP001', 'first_name' => 'Maria', 'last_name' => 'Santos', 'email' => 'hr@springboardph.com', 'phone' => '+639171000001', 'position' => 'Manager', 'department' => 'Human Resources', 'hire_date' => '2021-03-15', 'salary' => 45000, 'undeclared_salary' => 40000, 'rate_type' => 'monthly', 'role' => 'hr', 'schedule_name' => 'Standard 9-6 (Mon-Fri)'],
            ['employee_id' => 'EMP002', 'first_name' => 'Ana', 'last_name' => 'Garcia', 'email' => 'accounting@springboardph.com', 'phone' => '+639171000002', 'position' => 'Senior Accountant', 'department' => 'Finance', 'hire_date' => '2021-06-10', 'salary' => 35000, 'undeclared_salary' => null, 'rate_type' => 'monthly', 'role' => 'accounting', 'schedule_name' => 'Standard 9-6 (Mon-Fri)'],
            ['employee_id' => 'EMP003', 'first_name' => 'Juan', 'last_name' => 'Cruz', 'email' => 'juan@springboardph.com', 'phone' => '+639171000003', 'position' => 'Full Stack Developer', 'department' => 'Technology', 'hire_date' => '2023-03-20', 'salary' => 38000, 'undeclared_salary' => null, 'rate_type' => 'monthly', 'role' => 'employee', 'schedule_name' => 'Standard 9-6 (Mon-Fri)'],
            ['employee_id' => 'EMP004', 'first_name' => 'Pedro', 'last_name' => 'Reyes', 'email' => 'pedro.reyes@springboardph.com', 'phone' => '+639171000004', 'position' => 'Sales Manager', 'department' => 'Sales', 'hire_date' => '2020-11-02', 'salary' => 52000, 'undeclared_salary' => 48000, 'rate_type' => 'monthly', 'role' => null, 'schedule_name' => 'Standard 9-6 (Mon-Fri)'],
            ['employee_id' => 'EMP005', 'first_name' => 'Rosa', 'last_name' => 'Dela Cruz', 'email' => 'rosa.delacruz@springboardph.com', 'phone' => '+639171000005', 'position' => 'Office Manager', 'department' => 'Administration', 'hire_date' => '2022-01-18', 'salary' => 42000, 'undeclared_salary' => 38000, 'rate_type' => 'monthly', 'role' => null, 'schedule_name' => 'Standard 9-6 (Mon-Fri)'],
            ['employee_id' => 'EMP006', 'first_name' => 'Carlos', 'last_name' => 'Mendoza', 'email' => 'carlos.mendoza@springboardph.com', 'phone' => '+639171000006', 'position' => 'Backend Developer', 'department' => 'Technology', 'hire_date' => '2023-07-01', 'salary' => 36000, 'undeclared_salary' => null, 'rate_type' => 'monthly', 'role' => 'employee', 'schedule_name' => 'Standard 9-6 (Mon-Fri)'],
            ['employee_id' => 'EMP007', 'first_name' => 'Liza', 'last_name' => 'Torres', 'email' => 'liza.torres@springboardph.com', 'phone' => '+639171000007', 'position' => 'HR Specialist', 'department' => 'Human Resources', 'hire_date' => '2022-08-22', 'salary' => 28000, 'undeclared_salary' => null, 'rate_type' => 'monthly', 'role' => 'employee', 'schedule_name' => 'Standard 9-6 (Mon-Fri)'],
            ['employee_id' => 'EMP008', 'first_name' => 'Miguel', 'last_name' => 'Ramos', 'email' => 'miguel.ramos@springboardph.com', 'phone' => '+639171000008', 'position' => 'Accountant', 'department' => 'Finance', 'hire_date' => '2022-04-11', 'salary' => 30000, 'undeclared_salary' => null, 'rate_type' => 'monthly', 'role' => null, 'schedule_name' => 'Standard 9-6 (Mon-Fri)'],
            ['employee_id' => 'EMP009', 'first_name' => 'Sofia', 'last_name' => 'Villanueva', 'email' => 'sofia.villanueva@springboardph.com', 'phone' => '+639171000009', 'position' => 'Sales Executive', 'department' => 'Sales', 'hire_date' => '2023-01-09', 'salary' => 27000, 'undeclared_salary' => null, 'rate_type' => 'monthly', 'role' => null, 'schedule_name' => 'Flexible Hours 8-8'],
            ['employee_id' => 'EMP010', 'first_name' => 'Diego', 'last_name' => 'Bautista', 'email' => 'diego.bautista@springboardph.com', 'phone' => '+639171000010', 'position' => 'QA Engineer', 'department' => 'Technology', 'hire_date' => '2024-02-14', 'salary' => 32000, 'undeclared_salary' => null, 'rate_type' => 'monthly', 'role' => null, 'schedule_name' => 'Standard 9-6 (Mon-Fri)'],
            ['employee_id' => 'EMP011', 'first_name' => 'Elena', 'last_name' => 'Navarro', 'email' => 'elena.navarro@springboardph.com', 'phone' => '+639171000011', 'position' => 'Payroll Officer', 'department' => 'Finance', 'hire_date' => '2021-09-05', 'salary' => 31000, 'undeclared_salary' => null, 'rate_type' => 'monthly', 'role' => null, 'schedule_name' => 'Standard 9-6 (Mon-Fri)'],
            ['employee_id' => 'EMP012', 'first_name' => 'Rico', 'last_name' => 'Salazar', 'email' => 'rico.salazar@springboardph.com', 'phone' => '+639171000012', 'position' => 'Admin Assistant', 'department' => 'Administration', 'hire_date' => '2023-05-16', 'salary' => 22000, 'undeclared_salary' => null, 'rate_type' => 'monthly', 'role' => null, 'schedule_name' => 'Half Days 9-2'],
            ['employee_id' => 'EMP013', 'first_name' => 'Paula', 'last_name' => 'Gutierrez', 'email' => 'paula.gutierrez@springboardph.com', 'phone' => '+639171000013', 'position' => 'Recruitment Officer', 'department' => 'Human Resources', 'hire_date' => '2023-10-02', 'salary' => 26000, 'undeclared_salary' => null, 'rate_type' => 'monthly', 'role' => null, 'schedule_name' => 'Standard 9-6 (Mon-Fri)'],
            ['employee_id' => 'EMP014', 'first_name' => 'Andre', 'last_name' => 'Castillo', 'email' => 'andre.castillo@springboardph.com', 'phone' => '+639171000014', 'position' => 'Frontend Developer', 'department' => 'Technology', 'hire_date' => '2024-01-08', 'salary' => 34000, 'undeclared_salary' => null, 'rate_type' => 'monthly', 'role' => 'employee', 'schedule_name' => 'Flexible Hours 8-8'],
            ['employee_id' => 'EMP015', 'first_name' => 'Nina', 'last_name' => 'Aquino', 'email' => 'nina.aquino@springboardph.com', 'phone' => '+639171000015', 'position' => 'Account Executive', 'department' => 'Sales', 'hire_date' => '2022-12-01', 'salary' => 29000, 'undeclared_salary' => null, 'rate_type' => 'monthly', 'role' => null, 'schedule_name' => 'Standard 9-6 (Mon-Fri)'],
            ['employee_id' => 'EMP016', 'first_name' => 'Gabriel', 'last_name' => 'Flores', 'email' => 'gabriel.flores@springboardph.com', 'phone' => '+639171000016', 'position' => 'Bookkeeper', 'department' => 'Finance', 'hire_date' => '2024-03-18', 'salary' => 24000, 'undeclared_salary' => null, 'rate_type' => 'monthly', 'role' => null, 'schedule_name' => 'Morning Shift 6-3'],
            ['employee_id' => 'EMP017', 'first_name' => 'Katrina', 'last_name' => 'Lim', 'email' => 'katrina.lim@springboardph.com', 'phone' => '+639171000017', 'position' => 'Receptionist', 'department' => 'Administration', 'hire_date' => '2023-08-07', 'salary' => 20000, 'undeclared_salary' => null, 'rate_type' => 'monthly', 'role' => null, 'schedule_name' => 'Standard 9-6 (Mon-Fri)'],
            ['employee_id' => 'EMP018', 'first_name' => 'Julius', 'last_name' => 'Pascual', 'email' => 'julius.pascual@springboardph.com', 'phone' => '+639171000018', 'position' => 'DevOps Engineer', 'department' => 'Technology', 'hire_date' => '2022-06-27', 'salary' => 45000, 'undeclared_salary' => null, 'rate_type' => 'monthly', 'role' => null, 'schedule_name' => 'Standard 9-6 (Mon-Fri)'],
            ['employee_id' => 'EMP019', 'first_name' => 'Bea', 'last_name' => 'Ocampo', 'email' => 'bea.ocampo@springboardph.com', 'phone' => '+639171000019', 'position' => 'Benefits Coordinator', 'department' => 'Human Resources', 'hire_date' => '2021-12-13', 'salary' => 27000, 'undeclared_salary' => null, 'rate_type' => 'monthly', 'role' => null, 'schedule_name' => 'Standard 9-6 (Mon-Fri)'],
            ['employee_id' => 'EMP020', 'first_name' => 'Francis', 'last_name' => 'Tan', 'email' => 'francis.tan@springboardph.com', 'phone' => '+639171000020', 'position' => 'Business Development', 'department' => 'Sales', 'hire_date' => '2023-04-24', 'salary' => 33000, 'undeclared_salary' => null, 'rate_type' => 'monthly', 'role' => null, 'schedule_name' => 'Flexible Hours 8-8'],
            ['employee_id' => 'EMP021', 'first_name' => 'Ivy', 'last_name' => 'Chua', 'email' => 'ivy.chua@springboardph.com', 'phone' => '+639171000021', 'position' => 'Financial Analyst', 'department' => 'Finance', 'hire_date' => '2022-02-28', 'salary' => 37000, 'undeclared_salary' => null, 'rate_type' => 'monthly', 'role' => null, 'schedule_name' => 'Standard 9-6 (Mon-Fri)'],
            ['employee_id' => 'EMP022', 'first_name' => 'Mark', 'last_name' => 'Santiago', 'email' => 'mark.santiago@springboardph.com', 'phone' => '+639171000022', 'position' => 'Warehouse Clerk', 'department' => 'Administration', 'hire_date' => '2024-05-06', 'salary' => 950, 'undeclared_salary' => null, 'rate_type' => 'daily', 'role' => null, 'schedule_name' => 'Morning Shift 6-3'],
            ['employee_id' => 'EMP023', 'first_name' => 'Joy', 'last_name' => 'Mercado', 'email' => 'joy.mercado@springboardph.com', 'phone' => '+639171000023', 'position' => 'UI Designer', 'department' => 'Technology', 'hire_date' => '2023-09-11', 'salary' => 35000, 'undeclared_salary' => null, 'rate_type' => 'monthly', 'role' => null, 'schedule_name' => 'Standard 9-6 (Mon-Fri)'],
            ['employee_id' => 'EMP024', 'first_name' => 'Noel', 'last_name' => 'Domingo', 'email' => 'noel.domingo@springboardph.com', 'phone' => '+639171000024', 'position' => 'IT Support', 'department' => 'Technology', 'hire_date' => '2024-06-03', 'salary' => 1100, 'undeclared_salary' => null, 'rate_type' => 'daily', 'role' => null, 'schedule_name' => 'Standard 9-6 (Mon-Fri)'],
            ['employee_id' => 'EMP025', 'first_name' => 'Camille', 'last_name' => 'Estrada', 'email' => 'camille.estrada@springboardph.com', 'phone' => '+639171000025', 'position' => 'Sales Associate', 'department' => 'Sales', 'hire_date' => '2024-07-15', 'salary' => 23000, 'undeclared_salary' => null, 'rate_type' => 'monthly', 'role' => null, 'schedule_name' => 'Standard 9-6 (Mon-Fri)'],
            ['employee_id' => 'EMP026', 'first_name' => 'Ryan', 'last_name' => 'Gonzales', 'email' => 'ryan.gonzales@springboardph.com', 'phone' => '+639171000026', 'position' => 'Collections Specialist', 'department' => 'Finance', 'hire_date' => '2023-11-20', 'salary' => 25000, 'undeclared_salary' => null, 'rate_type' => 'monthly', 'role' => null, 'schedule_name' => 'Standard 9-6 (Mon-Fri)'],
            ['employee_id' => 'EMP027', 'first_name' => 'Tina', 'last_name' => 'Padilla', 'email' => 'tina.padilla@springboardph.com', 'phone' => '+639171000027', 'position' => 'Facilities Aide', 'department' => 'Administration', 'hire_date' => '2022-10-17', 'salary' => 850, 'undeclared_salary' => null, 'rate_type' => 'daily', 'role' => null, 'schedule_name' => 'Morning Shift 6-3'],
            ['employee_id' => 'EMP028', 'first_name' => 'Owen', 'last_name' => 'Miranda', 'email' => 'owen.miranda@springboardph.com', 'phone' => '+639171000028', 'position' => 'Training Officer', 'department' => 'Human Resources', 'hire_date' => '2024-04-01', 'salary' => 28000, 'undeclared_salary' => null, 'rate_type' => 'monthly', 'role' => null, 'schedule_name' => 'Standard 9-6 (Mon-Fri)'],
        ];
    }

    public function run(): void
    {
        if (Schema::hasColumn('leave_types', 'is_paid')) {
            LeaveType::where('code', 'unpaid')->update(['is_paid' => false]);
        }

        $templates = ScheduleTemplate::query()->get()->keyBy('name');
        $leaveTypes = LeaveType::query()->whereIn('code', ['vacation', 'sick'])->get()->keyBy('code');
        $scheduleEnd = SystemClock::today()->copy()->addYears(2)->toDateString();
        $oneYearAgo = SystemClock::today()->copy()->subYear()->toDateString();

        foreach ($this->personas() as $i => $p) {
            $userId = null;
            if (!empty($p['role'])) {
                $user = User::updateOrCreate(
                    ['email' => $p['email']],
                    [
                        'name' => trim($p['first_name'].' '.$p['last_name']),
                        'password' => bcrypt('password'),
                        'role' => $p['role'],
                    ]
                );
                $userId = $user->id;
            }

            $seq = $i + 1;
            $employee = Employee::updateOrCreate(
                ['employee_id' => $p['employee_id']],
                [
                    'user_id' => $userId,
                    'first_name' => $p['first_name'],
                    'last_name' => $p['last_name'],
                    'email' => $p['email'],
                    'phone' => $p['phone'],
                    'position' => $p['position'],
                    'department' => $p['department'],
                    'hire_date' => $p['hire_date'],
                    'salary' => $p['salary'],
                    'undeclared_salary' => $p['undeclared_salary'] ?? 0,
                    'rate_type' => $p['rate_type'],
                    'status' => 'active',
                    'tin_number' => sprintf('%03d-%03d-%03d-0000', 100 + $seq, 200 + $seq, 300 + $seq),
                    'sss_number' => sprintf('%02d-%07d-%d', 10 + ($seq % 90), 1000000 + $seq, $seq % 10),
                    'philhealth_number' => sprintf('%02d-%09d-%d', 12, 100000000 + $seq, $seq % 10),
                    'pagibig_number' => sprintf('%04d-%04d-%04d', 1200 + $seq, 3400 + $seq, 5600 + $seq),
                    'bank_account_number' => sprintf('%012d', 100000000000 + $seq),
                    'geo_tracking_enabled' => true,
                ]
            );

            $template = $templates->get($p['schedule_name']);
            if ($template) {
                $start = max($p['hire_date'], $oneYearAgo);
                EmployeeSchedule::updateOrCreate(
                    [
                        'employee_id' => $employee->id,
                        'start_date' => $start,
                        'end_date' => $scheduleEnd,
                    ],
                    [
                        'schedule_template_id' => $template->id,
                        'status' => 'active',
                    ]
                );
            }

            foreach (['vacation', 'sick'] as $code) {
                $type = $leaveTypes->get($code);
                if (!$type) {
                    continue;
                }
                EmployeeLeaveBalance::updateOrCreate(
                    [
                        'employee_id' => $employee->id,
                        'leave_type_id' => $type->id,
                    ],
                    [
                        'allocated_days' => (int) $type->default_days,
                        'carryover_days' => $seq % 4,
                        'is_active' => true,
                    ]
                );
            }
        }
    }
}
