<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\EmployeeRequest;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class EmployeeRequestController extends Controller
{
    /**
     * Create a new employee request (any authenticated user).
     */
    public function store(Request $request)
    {
        $request->validate([
            'request_type' => 'required|in:overtime,half_day,undertime,concern,schedule_change,coe,other,cash_advance',
            'subject'      => 'required|string|max:255',
            'details'      => 'nullable|string',
            'meta'         => 'nullable|array',
            'employee_id'  => 'nullable|exists:employees,id',
        ]);

        if ($request->request_type === 'cash_advance') {
            $request->validate([
                'meta.principal'      => 'required|numeric|min:1',
                'meta.term_count'     => 'required|integer|min:1',
                'meta.interest_rate'  => 'nullable|numeric|min:0|max:1',
            ]);
        }

        $user     = $request->user();
        $employee = $user?->employee;

        if ($user->isAdminOrHr() && $request->filled('employee_id')) {
            $employee = \App\Models\Employee::findOrFail($request->employee_id);
        }

        if (!$employee) {
            return response()->json([
                'success' => false,
                'data'    => null,
                'message' => 'Employee record not found.',
            ], 404);
        }

        $employeeRequest = EmployeeRequest::create([
            'employee_id'  => $employee->id,
            'request_type' => $request->request_type,
            'subject'      => $request->subject,
            'details'      => $request->details,
            'meta'         => $request->meta,
            'status'       => 'pending',
        ]);

        \App\Models\AuditLog::log(
            'REQUEST_CREATED',
            "Employee request created by {$employee->first_name} {$employee->last_name} ({$request->request_type}): {$request->subject}",
            $employeeRequest,
            null,
            [
                'employee_id'  => (int) $employee->id,
                'employee_name' => (string) ($employee->first_name . ' ' . $employee->last_name),
                'request_type' => (string) $request->request_type,
                'subject'      => (string) $request->subject,
                'status'       => 'pending',
            ]
        );

        return response()->json([
            'success' => true,
            'data'    => $employeeRequest,
            'message' => 'Request submitted successfully',
        ], 201);
    }

    /**
     * List employee requests with optional filters.
     */
    public function index(Request $request)
    {
        $query = EmployeeRequest::query();

        $isPersonal = $request->query('personal') === 'true';
        if (!$request->user()->isAdminOrHr() || $isPersonal) {
            $employee = $request->user()->employee;
            if ($employee) {
                $query->where('employee_id', $employee->id);
            } elseif ($isPersonal) {
                $query->whereRaw('1 = 0');
            }
        }

        // HR/Admin can filter by employee
        if ($employeeId = $request->query('employee_id')) {
            if ($request->user()->isAdminOrHr()) {
                $query->where('employee_id', $employeeId);
            }
        }

        // Filter by status
        if ($status = $request->query('status')) {
            $query->where('status', $status);
        }

        // Filter by request_type
        if ($requestType = $request->query('request_type')) {
            $query->where('request_type', $requestType);
        }

        $requests = $query->with('employee', 'approver')
            ->orderBy('created_at', 'desc')
            ->paginate(15);

        return response()->json([
            'success'    => true,
            'data'       => $requests->items(),
            'pagination' => [
                'total'        => $requests->total(),
                'count'        => $requests->count(),
                'per_page'     => $requests->perPage(),
                'current_page' => $requests->currentPage(),
                'last_page'    => $requests->lastPage(),
            ],
            'message' => 'Requests retrieved',
        ]);
    }

    /**
     * Get a single employee request.
     */
    public function show(int $id)
    {
        $employeeRequest = EmployeeRequest::with('employee', 'approver')->findOrFail($id);

        if (!request()->user()->isAdminOrHr()) {
            $employee = request()->user()->employee;
            if (!$employee || $employeeRequest->employee_id !== $employee->id) {
                return response()->json([
                    'success' => false,
                    'data'    => null,
                    'message' => 'Unauthorized',
                ], 403);
            }
        }

        return response()->json([
            'success' => true,
            'data'    => $employeeRequest,
            'message' => 'Request retrieved',
        ]);
    }

    /**
     * Approve an employee request (HR/Admin only).
     */
    public function approve(Request $request, int $id)
    {
        $request->validate([
            'response_notes' => 'nullable|string|max:1000',
        ]);

        $employeeRequest = EmployeeRequest::with('employee')->findOrFail($id);

        if ($employeeRequest->status !== 'pending') {
            return response()->json([
                'success' => false,
                'data'    => null,
                'message' => 'Only pending requests can be approved',
            ], 422);
        }

        DB::transaction(function () use ($employeeRequest, $request) {
            $employeeRequest->update([
                'status'         => 'approved',
                'approver_id'    => $request->user()->id,
                'response_notes' => $request->response_notes,
            ]);

            // If this is a flexi OT request, promote the attendance log to 'overtime'
            if ($employeeRequest->request_type === 'overtime') {
                $logId = $employeeRequest->meta['attendance_log_id'] ?? null;
                if ($logId) {
                    $log = \App\Models\AttendanceLog::where('id', $logId)
                        ->where('employee_id', $employeeRequest->employee_id)
                        ->whereNotIn('status', ['absent', 'on_leave'])
                        ->first();
                    if ($log) {
                        // Store original status so rejection can revert correctly (D5)
                        $meta = $employeeRequest->meta ?? [];
                        $meta['original_status'] = $log->status;
                        $employeeRequest->update(['meta' => $meta]);
                        $log->update(['status' => 'overtime']);
                    }
                }
            }

            // Undertime approval excuses the stamped shortfall (full day).
            // Half-day approval only marks the log; payroll still docks hours.
            $logId = $employeeRequest->meta['attendance_log_id'] ?? null;
            if ($logId && $employeeRequest->request_type === 'undertime') {
                \App\Models\AttendanceLog::where('id', $logId)
                    ->where('employee_id', $employeeRequest->employee_id)
                    ->whereIn('status', ['half_day', 'undertime'])
                    ->update(['status' => 'completed']);
            }
            if ($logId && $employeeRequest->request_type === 'half_day') {
                \App\Models\AttendanceLog::where('id', $logId)
                    ->where('employee_id', $employeeRequest->employee_id)
                    ->whereNotIn('status', ['absent', 'on_leave', 'rest_day'])
                    ->update(['status' => 'half_day']);
            }

            // Loan approval: create the loan for employee-initiated cash advances
            if ($employeeRequest->request_type === 'cash_advance') {
                $principal = (float) ($employeeRequest->meta['principal'] ?? 0);
                $termCount = (int) ($employeeRequest->meta['term_count'] ?? 1);
                $interestRate = (float) ($employeeRequest->meta['interest_rate'] ?? 0);

                [$totalPayable, $installmentAmount] = \App\Services\LoanService::computeSchedule($principal, $interestRate, $termCount);

                \App\Models\Loan::create([
                    'employee_id' => $employeeRequest->employee_id,
                    'loan_type' => $employeeRequest->request_type,
                    'principal' => $principal,
                    'interest_rate' => $interestRate,
                    'total_payable' => $totalPayable,
                    'installment_amount' => $installmentAmount,
                    'term_count' => $termCount,
                    'balance' => $totalPayable,
                    'status' => 'active',
                    'request_id' => $employeeRequest->id,
                    'start_cutoff' => \App\Helpers\SystemClock::today(),
                    'approver_id' => $request->user()->id,
                ]);
            }
        });

        \App\Models\AuditLog::log(
            'REQUEST_APPROVED',
            "Employee request approved for {$employeeRequest->employee->first_name} {$employeeRequest->employee->last_name} ({$employeeRequest->request_type}): {$employeeRequest->subject}",
            $employeeRequest,
            ['status' => 'pending', 'approver_id' => null, 'response_notes' => null],
            [
                'status'         => 'approved',
                'approver_id'    => (int) $request->user()->id,
                'approver_name'  => (string) $request->user()->name,
                'employee_id'    => (int) $employeeRequest->employee_id,
                'employee_name'  => $employeeRequest->employee->first_name . ' ' . $employeeRequest->employee->last_name,
                'request_type'   => (string) $employeeRequest->request_type,
                'response_notes' => (string) ($request->response_notes ?? ''),
            ]
        );

        return response()->json([
            'success' => true,
            'data'    => $employeeRequest,
            'message' => 'Request approved',
        ]);
    }

    /**
     * Reject an employee request (HR/Admin only).
     */
    public function reject(Request $request, int $id)
    {
        $request->validate([
            'response_notes' => 'required|string|max:1000',
        ]);

        $employeeRequest = EmployeeRequest::with('employee')->findOrFail($id);

        if ($employeeRequest->status !== 'pending') {
            return response()->json([
                'success' => false,
                'data'    => null,
                'message' => 'Only pending requests can be rejected',
            ], 422);
        }

        $employeeRequest->update([
            'status'         => 'rejected',
            'approver_id'    => $request->user()->id,
            'response_notes' => $request->response_notes,
        ]);

        // Revert the attendance log when OT is rejected
        if ($employeeRequest->request_type === 'overtime') {
            $logId = $employeeRequest->meta['attendance_log_id'] ?? null;
            if ($logId) {
                $revertTo = $employeeRequest->meta['original_status'] ?? 'completed';
                \App\Models\AttendanceLog::where('id', $logId)
                    ->where('employee_id', $employeeRequest->employee_id)
                    ->where('status', 'overtime')
                    ->update(['status' => $revertTo]);
            }
        }

        // Rejecting a half-day / undertime request means the shortfall is NOT excused:
        // stamp it onto the log, which is what turns on the early-departure deduction
        // in PayrollController. Absences and leave already have their own deduction
        // path, so never overwrite those.
        if (in_array($employeeRequest->request_type, ['half_day', 'undertime'], true)) {
            $logId = $employeeRequest->meta['attendance_log_id'] ?? null;
            if ($logId) {
                \App\Models\AttendanceLog::where('id', $logId)
                    ->where('employee_id', $employeeRequest->employee_id)
                    ->whereNotIn('status', ['absent', 'on_leave', 'rest_day'])
                    ->update(['status' => $employeeRequest->request_type]);
            }
        }

        \App\Models\AuditLog::log(
            'REQUEST_REJECTED',
            "Employee request rejected for {$employeeRequest->employee->first_name} {$employeeRequest->employee->last_name} ({$employeeRequest->request_type}): {$employeeRequest->subject}",
            $employeeRequest,
            ['status' => 'pending', 'approver_id' => null, 'response_notes' => null],
            [
                'status'         => 'rejected',
                'approver_id'    => (int) $request->user()->id,
                'approver_name'  => (string) $request->user()->name,
                'response_notes' => (string) $request->response_notes,
                'employee_id'    => (int) $employeeRequest->employee_id,
                'employee_name'  => $employeeRequest->employee->first_name . ' ' . $employeeRequest->employee->last_name,
                'request_type'   => (string) $employeeRequest->request_type,
            ]
        );

        return response()->json([
            'success' => true,
            'data'    => $employeeRequest,
            'message' => 'Request rejected',
        ]);
    }
}
