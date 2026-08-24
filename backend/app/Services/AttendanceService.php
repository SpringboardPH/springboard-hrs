<?php

namespace App\Services;

class AttendanceService
{
    /**
     * @return array{
     *   hours_worked: float,
     *   overtime_hours: float,
     *   late_minutes: int,
     *   undertime_minutes: int,
     *   status: string
     * }
     */
    public static function evaluateFixed(
        ?string $clockIn,
        ?string $clockOut,
        int|float $expectedHours,
        string $workStart,
        ?array $dayRule = null,
        ?string $workEnd = null
    ): array {
        $empty = [
            'hours_worked' => 0.0,
            'overtime_hours' => 0.0,
            'late_minutes' => 0,
            'undertime_minutes' => 0,
        ];

        if (!$clockIn) {
            return $empty + ['status' => 'absent'];
        }
        if (!$clockOut) {
            return $empty + ['status' => 'working'];
        }

        $inMin = self::parseTimeToMinutes($clockIn);
        $outMin = self::parseTimeToMinutes($clockOut);
        $startMin = self::parseTimeToMinutes($workStart);

        if ($startMin - $inMin > 720) {
            $inMin += 1440;
        }

        $effectiveInMin = $inMin;
        if ($inMin < $startMin && $inMin >= ($startMin - 60)) {
            $effectiveInMin = $startMin;
        }

        if ($outMin < $inMin) {
            $outMin += 1440;
        }

        $endMin = $workEnd
            ? self::parseTimeToMinutes($workEnd)
            : $startMin + (int) round($expectedHours * 60);
        if ($endMin <= $startMin) {
            $endMin += 1440;
        }

        $grace = self::graceParts($dayRule);
        $regularCap = $endMin + $grace['plus'];
        $regularOut = min($outMin, $regularCap);
        $overtimeHours = round(max(0, $outMin - $regularCap) / 60, 1);

        $regularMinutes = max(0, $regularOut - $effectiveInMin);
        $hoursWorked = $regularMinutes / 60;
        $expectedMinutes = (int) round($expectedHours * 60);
        $shortfallMinutes = max(0, $expectedMinutes - $regularMinutes);

        $lateArrival = max(0, $inMin - $startMin);
        $arrivalPastGrace = $lateArrival > $grace['plus'];
        $arrivalDock = $arrivalPastGrace ? $lateArrival : 0;

        if (!$arrivalPastGrace) {
            $shortfallMinutes = max(0, $expectedMinutes - max(0, $regularOut - $startMin));
        }

        if ($hoursWorked <= ($expectedHours / 2) && $expectedHours > 0) {
            $status = 'half_day';
        } elseif ($shortfallMinutes > 0) {
            if ($grace['minus'] > 0 && $shortfallMinutes <= $grace['minus']) {
                $status = 'late';
            } else {
                $status = 'undertime';
            }
        } elseif ($arrivalPastGrace) {
            $status = 'late';
        } else {
            $status = 'completed';
        }

        $lateMinutes = $arrivalDock;
        if ($status === 'late' && $shortfallMinutes > 0 && $lateMinutes === 0) {
            $lateMinutes = $shortfallMinutes;
        }

        $undertimeMinutes = $status === 'undertime'
            ? max(0, $shortfallMinutes - $arrivalDock)
            : 0;

        return [
            'hours_worked' => $hoursWorked,
            'overtime_hours' => $overtimeHours,
            'late_minutes' => $lateMinutes,
            'undertime_minutes' => $undertimeMinutes,
            'status' => $status,
        ];
    }

    /**
     * @return array{
     *   hours_worked: float,
     *   overtime_hours: float,
     *   late_minutes: int,
     *   undertime_minutes: int,
     *   status: string
     * }
     */
    public static function evaluateFlexi(?string $clockIn, ?string $clockOut, int $requiredHours): array
    {
        $empty = [
            'hours_worked' => 0.0,
            'overtime_hours' => 0.0,
            'late_minutes' => 0,
            'undertime_minutes' => 0,
        ];

        if (!$clockIn) {
            return $empty + ['status' => 'absent'];
        }
        if (!$clockOut) {
            return $empty + ['status' => 'working'];
        }

        $inMin = self::parseTimeToMinutes($clockIn);
        $outMin = self::parseTimeToMinutes($clockOut);
        if ($outMin < $inMin) {
            $outMin += 1440;
        }

        $minutesWorked = $outMin - $inMin;
        $hoursWorked = $minutesWorked / 60;
        $overtimeHours = round(max(0, $hoursWorked - $requiredHours), 1);
        $undertimeMin = max(0, ($requiredHours * 60) - $minutesWorked);

        if ($requiredHours > 0 && $hoursWorked <= ($requiredHours / 2)) {
            $status = 'half_day';
        } elseif ($hoursWorked < $requiredHours) {
            $status = 'undertime';
        } else {
            $status = 'completed';
        }

        return [
            'hours_worked' => $hoursWorked,
            'overtime_hours' => $overtimeHours,
            'late_minutes' => 0,
            'undertime_minutes' => $status === 'undertime' ? $undertimeMin : 0,
            'status' => $status,
        ];
    }

    public static function calculateStatus(
        ?string $clockIn,
        ?string $clockOut,
        int|float $expectedHours,
        string $workStart,
        ?array $dayRule = null,
        ?string $workEnd = null
    ): string {
        return self::evaluateFixed($clockIn, $clockOut, $expectedHours, $workStart, $dayRule, $workEnd)['status'];
    }

    public static function classifyDeviation(
        float $hoursWorked,
        int|float $expectedHours,
        float $overtimeHours = 0.0,
        ?string $status = null
    ): ?string {
        if ($overtimeHours > 0) {
            return 'overtime';
        }
        if ($status === 'half_day' || $status === 'undertime') {
            return $status;
        }
        if ($expectedHours <= 0) {
            return null;
        }
        if ($hoursWorked > $expectedHours) {
            return 'overtime';
        }
        if ($hoursWorked <= ($expectedHours / 2)) {
            return 'half_day';
        }
        if ($hoursWorked < $expectedHours) {
            return 'undertime';
        }

        return null;
    }

    public static function calculateNightHours(?string $clockIn, ?string $clockOut): float
    {
        if (!$clockIn || !$clockOut) {
            return 0.0;
        }

        $inMin = self::parseTimeToMinutes($clockIn);
        $outMin = self::parseTimeToMinutes($clockOut);
        if ($outMin < $inMin) {
            $outMin += 1440;
        }

        $overlap = function (int $a, int $b, int $c, int $d): float {
            return max(0, min($b, $d) - max($a, $c));
        };

        $startMin = self::parseTimeToMinutes(\App\Services\PayrollService::NIGHT_DIFF_START);
        $endMin = self::parseTimeToMinutes(\App\Services\PayrollService::NIGHT_DIFF_END);

        $minutes = $overlap($inMin, $outMin, $startMin, $endMin + 1440) + $overlap($inMin, $outMin, $startMin - 1440, $endMin);

        return $minutes / 60;
    }

    public static function shiftTimeBy(string $time, float $hoursBefore): string
    {
        $minutes = self::parseTimeToMinutes($time) - ($hoursBefore * 60);
        $normalized = ((int) round($minutes) % 1440 + 1440) % 1440;

        return sprintf('%02d:%02d:00', intdiv($normalized, 60), $normalized % 60);
    }

    public static function parseTimeToMinutes(string $time): int
    {
        [$hour, $minute] = array_map('intval', explode(':', substr($time, 0, 5)));
        return $hour * 60 + $minute;
    }

    public static function calculateFlexiStatus(?string $clockIn, ?string $clockOut, int $requiredHours): string
    {
        return self::evaluateFlexi($clockIn, $clockOut, $requiredHours)['status'];
    }

    public static function calculateFlexiDetails(?string $clockIn, ?string $clockOut, int $requiredHours): array
    {
        return self::evaluateFlexi($clockIn, $clockOut, $requiredHours);
    }

    public static function calculateDetails(
        ?string $clockIn,
        ?string $clockOut,
        int|float $expectedHours,
        string $workStart,
        ?array $dayRule = null,
        ?string $workEnd = null
    ): array {
        return self::evaluateFixed($clockIn, $clockOut, $expectedHours, $workStart, $dayRule, $workEnd);
    }

    /**
     * @return array{plus: int, minus: int}
     */
    private static function graceParts(?array $dayRule): array
    {
        if (!$dayRule || empty($dayRule['grace_enabled'])) {
            return ['plus' => 0, 'minus' => 0];
        }

        $minutes = (int) ($dayRule['grace_minutes'] ?? 0);
        $type = $dayRule['grace_type'] ?? '-/+';
        $plus = ($type === '+' || $type === '-/+') ? $minutes : 0;
        $minus = ($type === '-' || $type === '-/+') ? $minutes : 0;

        return ['plus' => $plus, 'minus' => $minus];
    }
}
