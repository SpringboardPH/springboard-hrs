<?php

namespace App\Services;

class PayrollService
{
    public const NIGHT_DIFF_START = '22:00';
    public const NIGHT_DIFF_END = '06:00';
    public const NIGHT_DIFF_RATE = 0.10;

    /**
     * Night differential pay: a 10% premium on the APPLICABLE hourly rate for hours
     * worked within the NIGHT_DIFF_START-NIGHT_DIFF_END window (DOLE Art. 86). When
     * night hours are also overtime or rest-day hours, pass the matching rate
     * multiplier (1.25 OT, 1.30 rest day, 1.69 rest day OT) so the premium compounds
     * on the already-inflated rate, not the base rate.
     * ponytail: overtime that exists only as an approved EmployeeRequest (no clocked
     * times) earns ₱0 ND — there is no recorded time range to prove it fell in the
     * night window, so it never reaches this method.
     */
    public static function calculateNightDifferential(float $nightHours, float $hourlyRate, float $rateMultiplier = 1.0): float
    {
        return $nightHours * $hourlyRate * $rateMultiplier * self::NIGHT_DIFF_RATE;
    }

    /**
     * Calculate SSS Employee Contribution (PH 2024/2025)
     * Fetches from system_settings table to allow HR updates
     */
    public static function calculateSSS(float $monthlySalary, int $periods = 2): float
    {
        if ($monthlySalary <= 0) return 0.0;

        $setting = \App\Models\SystemSettings::where('key', 'sss_contribution_table')->first();

        if ($setting && $setting->value) {
            $table = is_array($setting->value) ? $setting->value : json_decode($setting->value, true);

            if (is_array($table)) {
                foreach ($table as $bracket) {
                    $aboveMin = $monthlySalary >= $bracket['min'];
                    $belowMax = $bracket['max'] === null || $monthlySalary <= $bracket['max'];

                    if ($aboveMin && $belowMax) {
                        return (float) ($bracket['ee'] / $periods);
                    }
                }
            }
        }

        // Fallback if table missing: 5% of salary capped at MSC 35,000
        $msc = min(ceil($monthlySalary / 500) * 500, 35000);
        return round(($msc * 0.05) / $periods, 2);
    }

    /**
     * Calculate SSS Employer Contribution (ER) (PH 2024/2025)
     * For viewing only - no impact on employee's net pay
     * Fetches from system_settings table to allow HR updates
     */
    public static function calculateSSS_ER(float $monthlySalary, int $periods = 2): float
    {
        if ($monthlySalary <= 0) return 0.0;

        $setting = \App\Models\SystemSettings::where('key', 'sss_contribution_table')->first();

        if ($setting && $setting->value) {
            $table = is_array($setting->value) ? $setting->value : json_decode($setting->value, true);

            if (is_array($table)) {
                foreach ($table as $bracket) {
                    $aboveMin = $monthlySalary >= $bracket['min'];
                    $belowMax = $bracket['max'] === null || $monthlySalary <= $bracket['max'];

                    if ($aboveMin && $belowMax) {
                        return (float) (($bracket['er'] ?? 0) / $periods);
                    }
                }
            }
        }

        // Fallback if table missing: 5% of salary capped at MSC 35,000
        $msc = min(ceil($monthlySalary / 500) * 500, 35000);
        return round(($msc * 0.05) / $periods, 2);
    }

    /**
     * Calculate PhilHealth Employee Contribution (PH 2024)
     * 5% total, 2.5% EE share
     */
    public static function calculatePhilHealth(float $monthlySalary, int $periods = 2): float
    {
        if ($monthlySalary <= 0) return 0.0;
        if ($monthlySalary < 10000) return (500.00 * 0.5) / $periods;
        if ($monthlySalary > 100000) return (5000.00 * 0.5) / $periods;

        return (($monthlySalary * 0.05) * 0.5) / $periods;
    }

    /**
     * Calculate PhilHealth Employer Contribution (ER) (PH 2024)
     * For viewing only - no impact on employee's net pay
     * 5% total, 2.5% ER share
     */
    public static function calculatePhilHealth_ER(float $monthlySalary, int $periods = 2): float
    {
        if ($monthlySalary <= 0) return 0.0;
        if ($monthlySalary < 10000) return (500.00 * 0.5) / $periods;
        if ($monthlySalary > 100000) return (5000.00 * 0.5) / $periods;

        return (($monthlySalary * 0.05) * 0.5) / $periods;
    }

    /**
     * Calculate Pag-IBIG Employee Contribution (PH 2024)
     * 2% of salary, capped at 10k salary (200 pesos)
     */
    public static function calculatePagIBIG(float $monthlySalary, int $periods = 2): float
    {
        $base = min($monthlySalary, 10000);
        return ($base * 0.02) / $periods;
    }

    /**
     * Calculate Pag-IBIG Employer Contribution (ER) (PH 2024)
     * For viewing only - no impact on employee's net pay
     * 2% of salary, capped at 10k salary (200 pesos)
     */
    public static function calculatePagIBIG_ER(float $monthlySalary, int $periods = 2): float
    {
        $base = min($monthlySalary, 10000);
        return ($base * 0.02) / $periods;
    }

    /**
     * Calculate Withholding Tax (PH TRAIN Law RA 10963, RR 8-2018, effective Jan 1 2023)
     * taxableIncome is after SSS + PhilHealth + Pag-IBIG deductions.
     * frequency: 'monthly' | 'semi_monthly' (default)
     * Brackets are loaded from system_settings key 'withholding_tax_table'; hardcoded values are the fallback.
     */
    public static function calculateWithholdingTax(float $taxableIncome, string $frequency = 'semi_monthly'): float
    {
        if ($taxableIncome <= 0) return 0.0;

        $brackets = self::withholdingBrackets($frequency);

        // Match on 'from' only (brackets are ordered ascending, ignore 'to' entirely) — the
        // seeded/default table's 'to'/'from' pair between brackets doesn't always line up to
        // the cent (e.g. to: 16666, next from: 16667), which silently taxed anything landing
        // in that ~1-peso gap at ₱0. Taking the last bracket whose floor the income clears is
        // immune to that regardless of how the table's boundaries are entered.
        $bracket = null;
        foreach ($brackets as $candidate) {
            if ($taxableIncome >= $candidate['from']) {
                $bracket = $candidate;
            } else {
                break;
            }
        }

        if (!$bracket) return 0.0;

        return round($bracket['fixed'] + ($taxableIncome - $bracket['floor']) * $bracket['rate'], 2);
    }

    private static function withholdingBrackets(string $frequency): array
    {
        $setting = \App\Models\SystemSettings::where('key', 'withholding_tax_table')->first();
        if ($setting && $setting->value) {
            $table = is_array($setting->value) ? $setting->value : json_decode($setting->value, true);
            if (is_array($table) && isset($table[$frequency])) {
                return $table[$frequency];
            }
        }

        // ponytail: fallback — keeps working before the seeder runs or if the setting is missing
        $fallback = [
            'semi_monthly' => [
                ['from' => 0,          'to' => 10417,    'fixed' => 0,        'rate' => 0,    'floor' => 0],
                ['from' => 10417.01,   'to' => 16666,    'fixed' => 0,        'rate' => 0.15, 'floor' => 10417],
                ['from' => 16666.01,   'to' => 33332,    'fixed' => 937.50,   'rate' => 0.20, 'floor' => 16666.01],
                ['from' => 33332.01,   'to' => 83332,    'fixed' => 4270.70,  'rate' => 0.25, 'floor' => 33332.01],
                ['from' => 83332.01,   'to' => 333332,   'fixed' => 16770.70, 'rate' => 0.30, 'floor' => 83332.01],
                ['from' => 333332.01,  'to' => null,     'fixed' => 91770.70, 'rate' => 0.35, 'floor' => 333332.01],
            ],
            'monthly' => [
                ['from' => 0,          'to' => 20833,    'fixed' => 0,         'rate' => 0,    'floor' => 0],
                ['from' => 20833.01,   'to' => 33332,    'fixed' => 0,         'rate' => 0.15, 'floor' => 20833],
                ['from' => 33332.01,   'to' => 66666,    'fixed' => 1875.00,   'rate' => 0.20, 'floor' => 33332.01],
                ['from' => 66666.01,   'to' => 166666,   'fixed' => 8541.80,   'rate' => 0.25, 'floor' => 66666.01],
                ['from' => 166666.01,  'to' => 666666,   'fixed' => 33541.80,  'rate' => 0.30, 'floor' => 166666.01],
                ['from' => 666666.01,  'to' => null,     'fixed' => 183541.80, 'rate' => 0.35, 'floor' => 666666.01],
            ],
        ];
        return $fallback[$frequency] ?? $fallback['semi_monthly'];
    }

    public const SNWH_WEEKDAY_REGULAR_EXTRA = 1.30 - 1.00;
    public const SNWH_WEEKDAY_OT_EXTRA = 1.69 - 1.25;
    public const SNWH_REST_REGULAR_EXTRA = 1.50 - 1.30;
    public const SNWH_REST_OT_EXTRA = 1.95 - 1.69;

    public static function isSpecialNonWorkingHoliday(?string $typeName): bool
    {
        if ($typeName === null || $typeName === '') {
            return false;
        }

        $name = mb_strtolower(trim($typeName));

        return str_contains($name, 'special') && str_contains($name, 'non-working');
    }

    public static function specialHolidayPremium(
        float $dailyRate,
        float $weekdayRegularEquivalent,
        float $weekdayOtHours,
        float $restRegularEquivalent,
        float $restOtHours,
    ): float {
        $hourly = $dailyRate / 8;

        return round(
            $weekdayRegularEquivalent * self::SNWH_WEEKDAY_REGULAR_EXTRA
            + $weekdayOtHours * $hourly * self::SNWH_WEEKDAY_OT_EXTRA
            + $restRegularEquivalent * self::SNWH_REST_REGULAR_EXTRA
            + $restOtHours * $hourly * self::SNWH_REST_OT_EXTRA,
            2
        );
    }
}
