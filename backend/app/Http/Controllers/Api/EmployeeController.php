<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\StoreEmployeeRequest;
use App\Http\Requests\UpdateEmployeeRequest;
use App\Http\Resources\EmployeeResource;
use App\Models\AuditLog;
use App\Models\Employee;
use App\Models\EmployeeSchedule;
use App\Models\Payroll;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

class EmployeeController extends Controller
{
    public function index(Request $request)
    {
        $query = Employee::query()->where(function ($q) {
            $q->whereDoesntHave('user')
              ->orWhereHas('user', fn($u) => $u->where('role', '!=', 'admin'));
        });

        // Search by name, ID, or email
        if ($search = $request->query('search')) {
            $query->where(function ($q) use ($search) {
                $q->whereRaw('CONCAT(first_name, " ", last_name) LIKE ?', ["%{$search}%"])
                  ->orWhere('employee_id', 'LIKE', "%{$search}%")
                  ->orWhere('email', 'LIKE', "%{$search}%");
            });
        }

        // Filter by status
        if ($status = $request->query('status')) {
            $query->where('status', $status);
        }

        // Filter by department
        if ($department = $request->query('department')) {
            $query->where('department', $department);
        }

        // Filter by group
        if ($group = $request->query('group')) {
            $query->where('group', $group);
        }

        $perPage = min((int) $request->query('per_page', 15), 1000);
        $employees = $query->orderBy('created_at', 'desc')->paginate($perPage);

        return response()->json([
            'success' => true,
            'data' => EmployeeResource::collection($employees->items()),
            'pagination' => [
                'total' => $employees->total(),
                'count' => $employees->count(),
                'per_page' => $employees->perPage(),
                'current_page' => $employees->currentPage(),
                'last_page' => $employees->lastPage(),
            ],
            'message' => 'Employees retrieved successfully',
        ]);
    }

    public function groups()
    {
        $groups = Employee::whereNotNull('group')
            ->where('group', '!=', '')
            ->distinct()
            ->pluck('group')
            ->sort()
            ->values();

        return response()->json(['success' => true, 'data' => $groups]);
    }

    public function store(StoreEmployeeRequest $request)
    {
        $data = $request->validated();

        $needsGeneratedEmployeeId = empty($data['employee_id']);
        if ($needsGeneratedEmployeeId) {
            $data['employee_id'] = 'TEMP-' . Str::uuid();
        }

        // Map basic_salary to salary if provided
        if (isset($data['basic_salary']) && !isset($data['salary'])) {
            $data['salary'] = $data['basic_salary'];
            unset($data['basic_salary']);
        }

        $employee = DB::transaction(function () use ($data, $request, $needsGeneratedEmployeeId) {
            $currentUser = $request->user();
            $isAdmin = $currentUser && $currentUser->role === 'admin';

            // 1. Create the system user first
            $user = User::create([
                'name' => $data['first_name'] . ' ' . $data['last_name'],
                'email' => $data['email'],
                'password' => Hash::make($isAdmin && !empty($data['password']) ? $data['password'] : 'password123'),
                'role' => ($isAdmin && !empty($data['role'])) ? $data['role'] : 'employee',
            ]);

            // 2. Link the user to the employee data
            $data['user_id'] = $user->id;
            $employee = Employee::create($data);

            if ($needsGeneratedEmployeeId) {
                $employee->update([
                    'employee_id' => 'EMP' . str_pad((string) $employee->id, 3, '0', STR_PAD_LEFT),
                ]);
            }

            return $employee;
        });

        $message = 'Employee and user account created successfully.';
        if (!($request->user() && $request->user()->role === 'admin' && !empty($data['password']))) {
            $message .= ' Temporary password: password123';
        }

        // Log audit event for employee creation
        \App\Models\AuditLog::log(
            'EMPLOYEE_CREATED',
            "Employee {$employee->first_name} {$employee->last_name} (ID: {$employee->employee_id}) created",
            $employee,
            null,
            [
                'employee_id' => (string) ($employee->employee_id ?? ''),
                'first_name' => (string) ($employee->first_name ?? ''),
                'last_name' => (string) ($employee->last_name ?? ''),
                'email' => (string) ($employee->email ?? ''),
                'position' => (string) ($employee->position ?? 'N/A'),
                'department' => (string) ($employee->department ?? 'N/A'),
                'status' => (string) ($employee->status ?? 'active'),
            ]
        );

        return response()->json([
            'success' => true,
            'data' => new EmployeeResource($employee),
            'message' => $message,
        ], 201);
    }

    public function show(int $id)
    {
        $employee = Employee::findOrFail($id);

        return response()->json([
            'success' => true,
            'data' => new EmployeeResource($employee),
            'message' => 'Employee retrieved successfully',
        ]);
    }

    public function update(UpdateEmployeeRequest $request, int $id)
    {
        $employee = Employee::findOrFail($id);
        $oldValues = $employee->toArray();
        $data = $request->validated();

        // Map basic_salary to salary if provided
        if (isset($data['basic_salary']) && !isset($data['salary'])) {
            $data['salary'] = $data['basic_salary'];
            unset($data['basic_salary']);
        }

        $employee->update($data);

        // Update linked user if exists
        if ($employee->user) {
            $currentUser = $request->user();
            $isAdmin = $currentUser && $currentUser->role === 'admin';

            $userUpdateData = [
                'name' => $employee->first_name . ' ' . $employee->last_name,
                'email' => $employee->email,
            ];

            // Only admin can change role or password
            if ($isAdmin) {
                if (!empty($data['role'])) {
                    $userUpdateData['role'] = $data['role'];
                }
                if (!empty($data['password'])) {
                    $userUpdateData['password'] = Hash::make($data['password']);
                }
            }

            $employee->user->update($userUpdateData);
        }

        // Log audit event for employee update
        \App\Models\AuditLog::log(
            'EMPLOYEE_UPDATED',
            "Employee {$employee->first_name} {$employee->last_name} (ID: {$employee->employee_id}) updated",
            $employee,
            array_intersect_key($oldValues, array_flip(array_keys($data))),
            $data
        );

        return response()->json([
            'success' => true,
            'data' => new EmployeeResource($employee),
            'message' => 'Employee updated successfully',
        ]);
    }

    public function destroy(int $id)
    {
        $employee = Employee::findOrFail($id);
        $employeeName = $employee->first_name . ' ' . $employee->last_name;
        $employeeId = $employee->employee_id;

        $currentUser = request()->user();
        if ($currentUser && $employee->user_id && $currentUser->id === $employee->user_id) {
            return response()->json([
                'success' => false,
                'message' => 'You cannot deactivate your own account.',
            ], 403);
        }

        DB::transaction(function () use ($employee) {
            EmployeeSchedule::where('employee_id', $employee->id)
                ->where('status', 'active')
                ->update(['status' => 'archived']);

            $employee->update(['status' => 'inactive']);

            if ($employee->user_id) {
                $user = User::find($employee->user_id);
                if ($user) {
                    $user->delete();
                }
            }
        });

        \App\Models\AuditLog::log(
            'EMPLOYEE_DEACTIVATED',
            "Employee {$employeeName} (ID: {$employeeId}) deactivated",
            $employee,
            ['status' => 'active'],
            ['status' => 'inactive']
        );

        return response()->json([
            'success' => true,
            'message' => 'Employee deactivated successfully',
        ]);
    }

    public function deactivate(int $id)
    {
        $employee = Employee::findOrFail($id);

        $currentUser = request()->user();
        if ($currentUser && $employee->user_id && $currentUser->id === $employee->user_id) {
            return response()->json([
                'success' => false,
                'message' => 'You cannot deactivate your own account.',
            ], 403);
        }

        DB::transaction(function () use ($employee) {
            EmployeeSchedule::where('employee_id', $employee->id)
                ->where('status', 'active')
                ->update(['status' => 'archived']);

            // Archive payrolls instead of deleting for audit trail
            Payroll::where('employee_id', $employee->id)
                ->whereNotIn('status', ['archived', 'paid'])
                ->update(['status' => 'archived']);

            $employee->update(['status' => 'inactive']);

            if ($employee->user_id) {
                $user = User::find($employee->user_id);
                if ($user) {
                    $user->delete();
                }
            }
        });

        return response()->json([
            'success' => true,
            'data' => new EmployeeResource($employee),
            'message' => 'Employee deactivated successfully',
        ]);
    }

    public function hardDelete(int $id)
    {
        $employee = Employee::withTrashed()->findOrFail($id);

        DB::transaction(function () use ($employee) {
            // Archive all payrolls when employee is permanently deleted (keep for audit)
            Payroll::withTrashed()->where('employee_id', $employee->id)
                ->where('status', '!=', 'paid')
                ->update(['status' => 'archived']);

            if ($employee->user_id) {
                $user = User::withTrashed()->find($employee->user_id);
                if ($user) {
                    $user->forceDelete();
                }
            }

            $employee->forceDelete();
        });

        return response()->json([
            'success' => true,
            'message' => 'Employee permanently deleted',
        ]);
    }

    public function restore(int $id)
    {
        $employee = Employee::withTrashed()->findOrFail($id);
        DB::transaction(function () use ($employee) {
            $employee->restore();
            $employee->update(['status' => 'active']);

            // Restore archived payrolls (except paid ones stay archived)
            Payroll::where('employee_id', $employee->id)
                ->where('status', 'archived')
                ->where('paid_at', null)
                ->update(['status' => 'draft']);

            if ($employee->user_id) {
                $user = User::withTrashed()->find($employee->user_id);
                if ($user && $user->trashed()) {
                    $user->restore();
                }
            }
        });
        return response()->json([
            'success' => true,
            'data' => new EmployeeResource($employee),
            'message' => 'Employee restored successfully',
        ]);
    }

    public function updateProfile(Request $request)
    {
        $user = $request->user();
        $validated = $request->validate([
            // User profile fields
            'name' => 'nullable|string|max:255',
            'email' => 'nullable|string|email|max:255|unique:users,email,' . $user->id,
            'password' => 'nullable|string|min:8|confirmed',
            // Employee profile fields (if user has an employee record)
            'phone' => 'nullable|string|max:20',
            'bank_account_number' => 'nullable|string|min:10|max:12',
            'sss_number' => 'nullable|string|max:20',
            'philhealth_number' => 'nullable|string|max:20',
            'pagibig_number' => 'nullable|string|max:20',
            'tin_number' => 'nullable|string|max:20',
        ]);

        $oldUserValues = [];
        $newUserValues = [];

        // Update user profile fields
        $userUpdates = [];
        if (isset($validated['name'])) {
            $oldUserValues['name'] = $user->name;
            $newUserValues['name'] = (string)$validated['name'];
            $userUpdates['name'] = $validated['name'];
        }
        if (isset($validated['email'])) {
            $oldUserValues['email'] = $user->email;
            $newUserValues['email'] = (string)$validated['email'];
            $userUpdates['email'] = $validated['email'];
        }
        if (isset($validated['password'])) {
            $oldUserValues['password'] = '***';
            $newUserValues['password'] = '***';
            $userUpdates['password'] = $validated['password'];
        }

        if (!empty($userUpdates)) {
            $user->update($userUpdates);
            
            // Log user profile update
            AuditLog::log(
                'PROFILE_UPDATED',
                'User updated their profile',
                $user,
                !empty($oldUserValues) ? $oldUserValues : null,
                !empty($newUserValues) ? $newUserValues : null
            );
        }

        // Update employee profile fields if user has an employee record
        $employee = $user->employee;
        if ($employee) {
            $employeeUpdates = [];
            $oldEmpValues = [];
            $newEmpValues = [];

            if (isset($validated['name'])) {
                $names = explode(' ', trim($validated['name']));
                $employeeUpdates['first_name'] = $names[0];
                $employeeUpdates['last_name'] = isset($names[1]) ? implode(' ', array_slice($names, 1)) : '';
                $oldEmpValues['first_name'] = $employee->first_name;
                $oldEmpValues['last_name'] = $employee->last_name;
                $newEmpValues['first_name'] = $employeeUpdates['first_name'];
                $newEmpValues['last_name'] = $employeeUpdates['last_name'];
            }
            if (isset($validated['email'])) {
                $oldEmpValues['email'] = $employee->email;
                $newEmpValues['email'] = (string)$validated['email'];
                $employeeUpdates['email'] = $validated['email'];
            }
            if (isset($validated['phone'])) {
                $oldEmpValues['phone'] = $employee->phone;
                $newEmpValues['phone'] = (string)$validated['phone'];
                $employeeUpdates['phone'] = $validated['phone'];
            }
            // ... (rest of field updates)
            if (isset($validated['bank_account_number'])) {
                $oldEmpValues['bank_account_number'] = $employee->bank_account_number;
                $newEmpValues['bank_account_number'] = (string)$validated['bank_account_number'];
                $employeeUpdates['bank_account_number'] = $validated['bank_account_number'];
            }
            if (isset($validated['sss_number'])) {
                $oldEmpValues['sss_number'] = $employee->sss_number;
                $newEmpValues['sss_number'] = (string)$validated['sss_number'];
                $employeeUpdates['sss_number'] = $validated['sss_number'];
            }
            if (isset($validated['philhealth_number'])) {
                $oldEmpValues['philhealth_number'] = $employee->philhealth_number;
                $newEmpValues['philhealth_number'] = (string)$validated['philhealth_number'];
                $employeeUpdates['philhealth_number'] = $validated['philhealth_number'];
            }
            if (isset($validated['pagibig_number'])) {
                $oldEmpValues['pagibig_number'] = $employee->pagibig_number;
                $newEmpValues['pagibig_number'] = (string)$validated['pagibig_number'];
                $employeeUpdates['pagibig_number'] = $validated['pagibig_number'];
            }
            if (isset($validated['tin_number'])) {
                $oldEmpValues['tin_number'] = $employee->tin_number;
                $newEmpValues['tin_number'] = (string)$validated['tin_number'];
                $employeeUpdates['tin_number'] = $validated['tin_number'];
            }

            if (!empty($employeeUpdates)) {
                $employee->update($employeeUpdates);
                
                // Log employee profile update
                AuditLog::log(
                    'EMPLOYEE_PROFILE_UPDATED',
                    'Employee updated their profile',
                    $employee,
                    !empty($oldEmpValues) ? $oldEmpValues : null,
                    !empty($newEmpValues) ? $newEmpValues : null
                );
            }

            return response()->json([
                'success' => true,
                'data' => new EmployeeResource($employee),
                'message' => 'Profile updated successfully',
            ]);
        } else {
            // Return user profile if no employee record
            return response()->json([
                'success' => true,
                'data' => [
                    'id' => $user->id,
                    'name' => $user->name,
                    'email' => $user->email,
                    'role' => $user->role,
                ],
                'message' => 'Profile updated successfully',
            ]);
        }
    }
}

