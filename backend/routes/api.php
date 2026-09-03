<?php

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;
use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\Api\EmployeeController;
use App\Http\Controllers\Api\AttendanceController;
use App\Http\Controllers\Api\LeaveController;
use App\Http\Controllers\Api\PayrollController;
use App\Http\Controllers\Api\DashboardController;
use App\Http\Controllers\Api\AdminSettingsController;
use App\Http\Controllers\Api\DepartmentController;
use App\Http\Controllers\Api\ScheduleTemplateController;
use App\Http\Controllers\Api\EmployeeScheduleController;
use App\Http\Controllers\Api\UserController;
use App\Http\Controllers\Api\LeaveTypeController;
use App\Http\Controllers\Api\EmployeeLeaveBalanceController;
use App\Http\Controllers\Api\CalendarEventController;
use App\Http\Controllers\Api\CalendarEventTypeController;
use App\Http\Controllers\Api\AuditLogController;
use App\Http\Controllers\Api\ThirteenthMonthController;
use App\Http\Controllers\Api\EmployeeRequestController;
use App\Http\Controllers\Api\DtrController;
use App\Http\Controllers\Api\LoanController;

// Public routes
Route::post('/login', [AuthController::class, 'login'])->middleware('throttle:10,1');
Route::post('/auth/request-otp', [AuthController::class, 'requestOtp'])->middleware('throttle:10,1');
Route::post('/auth/verify-otp', [AuthController::class, 'verifyOtp'])->middleware('throttle:5,1');
Route::post('/auth/forgot-password', [AuthController::class, 'forgotPassword'])->middleware('throttle:5,1');
Route::post('/auth/reset-password', [AuthController::class, 'resetPassword'])->middleware('throttle:5,1');
Route::get('/theme-color', [AdminSettingsController::class, 'getThemeColor']);
Route::get('/system-config', [AdminSettingsController::class, 'getSystemConfig']);
Route::get('/logo/{filename}', [AdminSettingsController::class, 'getLogo']);

// Protected routes (require authentication)
Route::middleware('auth:sanctum')->group(function () {
    // Auth
    Route::post('/logout', [AuthController::class, 'logout']);
    Route::get('/user', [AuthController::class, 'user']);
    Route::put('/user/password', [UserController::class, 'updatePassword']);
    
    // Employees
    Route::put('/profile', [EmployeeController::class, 'updateProfile']);
    Route::get('/employees/groups', [EmployeeController::class, 'groups'])->middleware('role:admin,hr,accounting');
    Route::apiResource('employees', EmployeeController::class)->middleware('role:admin,hr,accounting');
    Route::patch('/employees/{id}/deactivate', [EmployeeController::class, 'deactivate'])->middleware('role:admin,hr');
    
    // Attendance
    Route::prefix('attendance')->group(function () {
        Route::post('/clock-in', [AttendanceController::class, 'clockIn']);
        Route::post('/clock-out', [AttendanceController::class, 'clockOut']);
        Route::get('/today', [AttendanceController::class, 'today']);
        Route::get('/{employeeId}/monthly', [AttendanceController::class, 'monthly']);
        Route::post('/', [AttendanceController::class, 'store'])->middleware('role:admin,hr,accounting');
        Route::get('/', [AttendanceController::class, 'index']);
        Route::get('/{id}', [AttendanceController::class, 'show']);
        Route::put('/{id}', [AttendanceController::class, 'update'])->middleware('role:admin,hr,accounting');
        Route::delete('/{id}', [AttendanceController::class, 'destroy'])->middleware('role:admin');
        Route::post('/bulk-mark-absent', [AttendanceController::class, 'bulkMarkAbsent'])->middleware('role:admin,hr,accounting');
    });
    
    // Leave
    Route::prefix('leaves')->group(function () {
        Route::post('/', [LeaveController::class, 'store']);
        Route::get('/balance', [LeaveController::class, 'balance']);
        Route::get('/', [LeaveController::class, 'index']);
        Route::get('/{id}', [LeaveController::class, 'show']);
        Route::patch('/{id}/approve', [LeaveController::class, 'approve'])->middleware('role:admin,hr');
        Route::patch('/{id}/reject', [LeaveController::class, 'reject'])->middleware('role:admin,hr');
    });

    // Employee Requests
    Route::prefix('requests')->group(function () {
        Route::post('/', [EmployeeRequestController::class, 'store']);
        Route::get('/', [EmployeeRequestController::class, 'index']);
        Route::get('/{id}', [EmployeeRequestController::class, 'show']);
        Route::patch('/{id}/approve', [EmployeeRequestController::class, 'approve'])->middleware('role:admin,hr');
        Route::patch('/{id}/reject', [EmployeeRequestController::class, 'reject'])->middleware('role:admin,hr');
    });

    // Loans & Cash Advances
    Route::prefix('loans')->group(function () {
        Route::get('/', [LoanController::class, 'index']);
        Route::get('/{id}', [LoanController::class, 'show']);
        Route::post('/', [LoanController::class, 'store'])->middleware('role:admin,hr,accounting');
        Route::put('/{id}', [LoanController::class, 'update'])->middleware('role:admin,hr,accounting');
        Route::delete('/{id}', [LoanController::class, 'destroy'])->middleware('role:admin,hr,accounting');
    });

    Route::get('/leave-types', [LeaveTypeController::class, 'index']);
    Route::get('/calendar-event-types', [CalendarEventTypeController::class, 'index']);

    // Calendar
    Route::get('/calendar-events', [CalendarEventController::class, 'index']);
    Route::get('/calendar-events/{calendarEvent}', [CalendarEventController::class, 'show']);
    
    // Payroll
    Route::prefix('payroll')->group(function () {
        Route::get('/', [PayrollController::class, 'index'])->middleware('role:admin,hr,accounting');
        Route::post('/generate', [PayrollController::class, 'generate'])->middleware('role:admin,hr,accounting');
        Route::post('/send-paystubs', [PayrollController::class, 'sendPaystubs'])->middleware('role:admin,hr,accounting');
        Route::post('/{id}/revert-to-draft', [PayrollController::class, 'revertToDraft'])->middleware('role:admin,hr,accounting');
        Route::post('/{id}/toggle-undertime-calc', [PayrollController::class, 'toggleUndertimeCalculation'])->middleware('role:admin,hr,accounting');
        Route::get('/{id}', [PayrollController::class, 'show'])->middleware('role:admin,hr,accounting');
        Route::put('/{id}', [PayrollController::class, 'update'])->middleware('role:admin,hr,accounting');
        Route::get('/{id}/export', [PayrollController::class, 'export'])->middleware('role:admin,hr,accounting');
    });
    
    // 13th Month
    Route::prefix('thirteenth-month')->middleware('role:admin,hr,accounting')->group(function () {
        Route::get('/', [ThirteenthMonthController::class, 'index']);
        Route::post('/save', [ThirteenthMonthController::class, 'save']);
        Route::post('/set-mode', [ThirteenthMonthController::class, 'setMode']);
        Route::post('/set-excluded-months', [ThirteenthMonthController::class, 'setExcludedMonths']);
        Route::get('/payroll-periods', [ThirteenthMonthController::class, 'payrollPeriods']);
        Route::post('/push-to-payroll', [ThirteenthMonthController::class, 'pushToPayroll']);
    });

    // Dashboard
    Route::get('/dashboard/summary', [DashboardController::class, 'summary']);

    // Shared lookup data for admin + HR forms
    Route::middleware('role:admin,hr,accounting')->group(function () {
        Route::get('/departments', [DepartmentController::class, 'index']);
    });

    // Settings — reads are shared with HR/accounting (payroll needs
    // sss_contribution_table, payroll_frequency, etc.); writes stay admin-only.
    Route::prefix('admin/settings')->group(function () {
        Route::get('/', [AdminSettingsController::class, 'index'])->middleware('role:admin,hr,accounting');
        Route::get('/defaults', [AdminSettingsController::class, 'getDefaults'])->middleware('role:admin');
        Route::post('/initialize', [AdminSettingsController::class, 'initializeDefaults'])->middleware('role:admin');
        Route::post('/logo', [AdminSettingsController::class, 'uploadLogo'])->middleware('role:admin');
        Route::delete('/logo/{filename}', [AdminSettingsController::class, 'deleteLogo'])->middleware('role:admin');
        Route::post('/payroll-template', [AdminSettingsController::class, 'uploadPayrollTemplate'])->middleware('role:admin');
        Route::get('/logos', [AdminSettingsController::class, 'listLogos'])->middleware('role:admin');
        Route::get('/{key}', [AdminSettingsController::class, 'show'])->middleware('role:admin,hr,accounting');
        Route::put('/{key}', [AdminSettingsController::class, 'update'])->middleware('role:admin');
    });

    // Payroll template
    Route::get('/payroll-template', [AdminSettingsController::class, 'getTemplate']);

    // System clock (virtual time used by attendance) - available to all authenticated users
    Route::get('/system-clock', [AdminSettingsController::class, 'systemClock']);
    // Payroll cutoff config — needed by employee attendance page, not admin-restricted
    Route::get('/payroll-config', [AdminSettingsController::class, 'getPayrollConfig']);
    // Geofence config — needed by employee clock-in page, not admin-restricted
    Route::get('/geofence-config', [AdminSettingsController::class, 'getGeofenceConfig']);
    
    // DTR Uploads
    Route::prefix('dtr')->group(function () {
        Route::get('/config', [DtrController::class, 'config']);
        Route::get('/employee-access', [DtrController::class, 'employeeAccess'])->middleware('role:admin,hr');
        Route::patch('/employee-access/{employeeId}', [DtrController::class, 'toggleEmployeeAccess'])->middleware('role:admin,hr');
        Route::get('/', [DtrController::class, 'index']);
        Route::post('/', [DtrController::class, 'store']);
        Route::get('/{id}/download', [DtrController::class, 'download'])->middleware('role:admin,hr');
        Route::delete('/{id}', [DtrController::class, 'destroy']);
    });

    // Employee Schedules (Self-service)
    Route::get('/my-schedules', [EmployeeScheduleController::class, 'mySchedules']);
    Route::post('/my-schedules', [EmployeeScheduleController::class, 'setMySchedule']);
    Route::get('/schedule-templates', [ScheduleTemplateController::class, 'index']);

    // Admin Routes (Admin Only)
    Route::middleware('role:admin')->group(function () {
        Route::prefix('admin/leave-types')->group(function () {
            Route::get('/', [LeaveTypeController::class, 'index']);
            Route::post('/', [LeaveTypeController::class, 'store']);
            Route::get('/{leaveType}', [LeaveTypeController::class, 'show']);
            Route::put('/{leaveType}', [LeaveTypeController::class, 'update']);
            Route::delete('/{leaveType}', [LeaveTypeController::class, 'destroy']);
        });

        Route::prefix('admin/employee-leave-balances')->group(function () {
            Route::get('/{employee}', [EmployeeLeaveBalanceController::class, 'show']);
            Route::put('/{employee}/{leaveType}', [EmployeeLeaveBalanceController::class, 'upsert']);
            Route::delete('/{employee}/{leaveType}', [EmployeeLeaveBalanceController::class, 'destroy']);
        });

        Route::prefix('admin/calendar-event-types')->group(function () {
            Route::get('/', [CalendarEventTypeController::class, 'index']);
            Route::post('/', [CalendarEventTypeController::class, 'store']);
            Route::get('/{calendarEventType}', [CalendarEventTypeController::class, 'show']);
            Route::put('/{calendarEventType}', [CalendarEventTypeController::class, 'update']);
            Route::delete('/{calendarEventType}', [CalendarEventTypeController::class, 'destroy']);
        });
        
        // Departments
        Route::apiResource('admin/departments', DepartmentController::class);
        Route::patch('/admin/departments/{id}/restore', [DepartmentController::class, 'restore']);
        Route::delete('/admin/departments/{id}/hard-delete', [DepartmentController::class, 'hardDelete']);
        
        // Employee Management (Admin)
        Route::delete('/admin/employees/{id}/hard-delete', [EmployeeController::class, 'hardDelete']);
        Route::patch('/admin/employees/{id}/restore', [EmployeeController::class, 'restore']);
        
        // User Management (Admin)
        Route::delete('/admin/users/{id}/hard-delete', [UserController::class, 'hardDelete']);
        Route::get('/admin/users/trashed', [UserController::class, 'trashed']);
        Route::patch('/admin/users/{id}/restore', [UserController::class, 'restore']);
        Route::apiResource('admin/users', UserController::class);
        Route::get('/admin/audit-logs', [AuditLogController::class, 'index']);
        Route::post('/register', [AuthController::class, 'register']);
    });
    
    // Employee Schedules & Templates (Admin + HR)
    Route::middleware('role:admin,hr,accounting')->group(function () {
        Route::apiResource('admin/employee-schedules', EmployeeScheduleController::class);
        Route::apiResource('admin/schedule-templates', ScheduleTemplateController::class);
        Route::post('/admin/calendar-events/holiday-impact', [CalendarEventController::class, 'holidayImpact']);
        Route::apiResource('admin/calendar-events', CalendarEventController::class)->except(['index', 'show']);
        Route::post('/admin/calendar-events/import', [CalendarEventController::class, 'import']);
        Route::get('/admin/calendar-events/export', [CalendarEventController::class, 'export']);
    });
    Route::get('/admin/employee-schedules/employee/{employeeId}/current', [EmployeeScheduleController::class, 'getCurrentForEmployee']);
});
