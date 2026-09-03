<?php

namespace App\Services;

use App\Models\AttendanceLog;
use App\Models\CalendarEventType;
use Illuminate\Support\Carbon;

final class HolidayRewriteRow
{
    public function __construct(
        public int $log_id,
        public int $employee_id,
        public string $employee_name,
        public string $date,
    ) {}

    public function toArray(): array
    {
        return [
            'log_id' => $this->log_id,
            'employee_id' => $this->employee_id,
            'employee_name' => $this->employee_name,
            'date' => $this->date,
        ];
    }
}

final class HolidayRewritePlan
{
    /** @var string[] */
    public array $dates = [];

    /** @var HolidayRewriteRow[] */
    public array $convert = [];

    /** @var HolidayRewriteRow[] */
    public array $skipped_sandwich = [];

    public function hasImpact(): bool
    {
        return $this->convert !== [] || $this->skipped_sandwich !== [];
    }

    public function toArray(): array
    {
        return [
            'dates' => $this->dates,
            'convert' => array_map(fn (HolidayRewriteRow $row) => $row->toArray(), $this->convert),
            'skipped_sandwich' => array_map(fn (HolidayRewriteRow $row) => $row->toArray(), $this->skipped_sandwich),
        ];
    }
}

class HolidayAttendanceService
{
    public function datesCovered(string $eventDate, ?string $endDate, bool $recurringAnnual = false): array
    {
        $start = Carbon::parse($eventDate)->startOfDay();
        $end = $endDate ? Carbon::parse($endDate)->startOfDay() : $start->copy();
        if ($end->lt($start)) {
            $end = $start->copy();
        }

        $dates = $this->inclusiveDates($start, $end);

        if ($recurringAnnual) {
            for ($i = 1; $i <= 10; $i++) {
                $dates = array_merge(
                    $dates,
                    $this->inclusiveDates($start->copy()->addYears($i), $end->copy()->addYears($i))
                );
            }
        }

        return array_values(array_unique($dates));
    }

    public function preview(array $dates): HolidayRewritePlan
    {
        $dates = array_values(array_unique($dates));
        sort($dates);

        $plan = new HolidayRewritePlan();
        $plan->dates = $dates;
        if ($dates === []) {
            return $plan;
        }

        $loadDates = $dates;
        foreach ($dates as $date) {
            $day = Carbon::parse($date);
            $loadDates[] = $day->copy()->subDay()->format('Y-m-d');
            $loadDates[] = $day->copy()->addDay()->format('Y-m-d');
        }
        $loadDates = array_values(array_unique($loadDates));

        $logs = AttendanceLog::with('employee')
            ->whereIn('date', $loadDates)
            ->get();

        $statusByEmployeeDate = [];
        foreach ($logs as $log) {
            $dateStr = Carbon::parse($log->date)->format('Y-m-d');
            $statusByEmployeeDate[$log->employee_id][$dateStr] = $log->status;
        }

        $targetDates = array_flip($dates);
        foreach ($logs as $log) {
            $dateStr = Carbon::parse($log->date)->format('Y-m-d');
            if (!isset($targetDates[$dateStr]) || $log->status !== 'absent') {
                continue;
            }

            $row = new HolidayRewriteRow(
                $log->id,
                $log->employee_id,
                $log->employee?->full_name ?? '',
                $dateStr,
            );

            if ($this->isSandwiched($log->employee_id, $dateStr, $statusByEmployeeDate)) {
                $plan->skipped_sandwich[] = $row;
            } else {
                $plan->convert[] = $row;
            }
        }

        return $plan;
    }

    public function apply(HolidayRewritePlan $plan): int
    {
        if ($plan->convert === []) {
            return 0;
        }

        $ids = array_map(fn (HolidayRewriteRow $row) => $row->log_id, $plan->convert);
        $logs = AttendanceLog::whereIn('id', $ids)
            ->where('status', 'absent')
            ->get();

        $updated = 0;
        foreach ($logs as $log) {
            $log->update([
                'status' => 'holiday',
                'clock_in_time' => null,
                'clock_out_time' => null,
            ]);
            $updated++;
        }

        return $updated;
    }

    /**
     * Adjacent calendar day (yesterday or tomorrow) has status=absent for this employee.
     * $statusByEmployeeDate is [employeeId][Y-m-d] => status string.
     */
    public function isSandwiched(int $employeeId, string $date, array $statusByEmployeeDate): bool
    {
        $day = Carbon::parse($date);
        $prev = $day->copy()->subDay()->format('Y-m-d');
        $next = $day->copy()->addDay()->format('Y-m-d');
        $map = $statusByEmployeeDate[$employeeId] ?? [];

        return ($map[$prev] ?? null) === 'absent' || ($map[$next] ?? null) === 'absent';
    }

    public function planForType(?CalendarEventType $type, array $dates): HolidayRewritePlan
    {
        if (!$type || $type->counts_as_absence) {
            return new HolidayRewritePlan();
        }

        return $this->preview($dates);
    }

    /**
     * @param  list<array<string, mixed>>  $rows
     * @return string[]
     */
    public function nonWorkingImportDates(array $rows): array
    {
        $dates = [];
        foreach ($rows as $row) {
            if (empty($row['date']) || empty($row['title'])) {
                continue;
            }

            try {
                $parsed = Carbon::createFromFormat('Y-m-d', $row['date']);
                if (!$parsed) {
                    continue;
                }
            } catch (\Exception $e) {
                continue;
            }

            $typeName = $row['type_name'] ?? 'Holiday';
            $type = CalendarEventType::where('name', $typeName)->first();
            if ($type && $type->counts_as_absence) {
                continue;
            }

            $recurring = (bool) ($row['is_recurring'] ?? false) || (bool) ($type?->is_recurring_annual);
            $dateStr = $parsed->format('Y-m-d');
            foreach ($this->datesCovered($dateStr, $dateStr, $recurring) as $date) {
                $dates[$date] = true;
            }
        }

        return array_keys($dates);
    }

    /** @return string[] */
    private function inclusiveDates(Carbon $start, Carbon $end): array
    {
        $dates = [];
        for ($day = $start->copy(); $day->lte($end); $day->addDay()) {
            $dates[] = $day->format('Y-m-d');
        }

        return $dates;
    }
}
