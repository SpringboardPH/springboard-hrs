<?php

namespace Tests\Feature;

use App\Models\Employee;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class EmployeeDeactivateTest extends TestCase
{
    use RefreshDatabase;

    private function makeEmployee(array $overrides = []): Employee
    {
        return Employee::create(array_merge([
            'employee_id' => 'EMP-DEACT-1',
            'first_name'  => 'Deact',
            'last_name'   => 'Tester',
            'email'       => 'deact-tester@example.com',
            'position'    => 'Staff',
            'hire_date'   => '2026-01-01',
            'salary'      => 26000,
            'status'      => 'active',
            'rate_type'   => 'monthly',
        ], $overrides));
    }

    private function makeLinkedEmployee(array $userOverrides = [], array $employeeOverrides = []): array
    {
        $user = User::factory()->create(array_merge([
            'role' => 'employee',
        ], $userOverrides));

        $employee = $this->makeEmployee(array_merge([
            'user_id' => $user->id,
            'email' => $user->email,
        ], $employeeOverrides));

        return [$user, $employee];
    }

    public function test_deactivate_leaves_employee_row_inactive_and_trashes_linked_user()
    {
        [$user, $employee] = $this->makeLinkedEmployee();
        $admin = User::factory()->create(['role' => 'admin']);

        $this->actingAs($admin)
            ->patchJson("/api/employees/{$employee->id}/deactivate")
            ->assertOk()
            ->assertJson(['success' => true]);

        $fresh = Employee::find($employee->id);
        $this->assertNotNull($fresh);
        $this->assertSame('inactive', $fresh->status);
        $this->assertNull($fresh->deleted_at);

        $this->assertTrue(User::withTrashed()->find($user->id)->trashed());
        $this->assertNull(User::find($user->id));
    }

    public function test_cannot_deactivate_own_linked_account()
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $employee = $this->makeEmployee([
            'user_id' => $admin->id,
            'email' => $admin->email,
            'employee_id' => 'EMP-DEACT-SELF',
        ]);

        $this->actingAs($admin)
            ->patchJson("/api/employees/{$employee->id}/deactivate")
            ->assertForbidden()
            ->assertJson([
                'success' => false,
                'message' => 'You cannot deactivate your own account.',
            ]);

        $fresh = Employee::find($employee->id);
        $this->assertSame('active', $fresh->status);
        $this->assertNull($fresh->deleted_at);
        $this->assertFalse($admin->fresh()->trashed());
    }

    public function test_destroy_leaves_employee_row_inactive_and_trashes_linked_user()
    {
        [$user, $employee] = $this->makeLinkedEmployee(
            [],
            ['employee_id' => 'EMP-DEACT-DEL', 'email' => 'deact-del@example.com']
        );
        $admin = User::factory()->create(['role' => 'admin']);

        $this->actingAs($admin)
            ->deleteJson("/api/employees/{$employee->id}")
            ->assertOk()
            ->assertJson(['success' => true]);

        $fresh = Employee::find($employee->id);
        $this->assertNotNull($fresh);
        $this->assertSame('inactive', $fresh->status);
        $this->assertNull($fresh->deleted_at);

        $this->assertTrue(User::withTrashed()->find($user->id)->trashed());
        $this->assertNull(User::find($user->id));
    }
}
