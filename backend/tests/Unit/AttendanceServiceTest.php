<?php

namespace Tests\Unit;

use Tests\TestCase;
use App\Services\AttendanceService;
use PHPUnit\Framework\Attributes\DataProvider;

class AttendanceServiceTest extends TestCase
{
    public function test_calculate_status_absent()
    {
        $this->assertEquals('absent', AttendanceService::calculateStatus(null, null, 8, '09:00:00'));
    }

    public function test_open_punch_is_working_even_when_late()
    {
        $this->assertEquals('working', AttendanceService::calculateStatus('09:30:00', null, 8, '09:00:00'));
    }

    public function test_calculate_status_completed()
    {
        $this->assertEquals('completed', AttendanceService::calculateStatus('09:00:00', '17:00:00', 8, '09:00:00'));
    }

    public function test_late_only_past_arrival_grace()
    {
        $grace = ['grace_enabled' => true, 'grace_type' => '-/+', 'grace_minutes' => 15];
        $this->assertEquals('completed', AttendanceService::calculateStatus('09:10:00', '17:00:00', 8, '09:00:00', $grace));
        $this->assertEquals('late', AttendanceService::calculateStatus('09:20:00', '17:20:00', 8, '09:00:00', $grace));
    }

    public function test_four_hours_of_eight_is_half_day()
    {
        $this->assertEquals('half_day', AttendanceService::calculateStatus('09:00:00', '13:00:00', 8, '09:00:00'));
    }

    public function test_five_hours_of_eight_is_undertime()
    {
        $this->assertEquals('undertime', AttendanceService::calculateStatus('09:00:00', '14:00:00', 8, '09:00:00'));
    }

    public function test_grace_sized_shortfall_is_late_and_docks_late_minutes()
    {
        $grace = ['grace_enabled' => true, 'grace_type' => '-/+', 'grace_minutes' => 15];
        $details = AttendanceService::calculateDetails('09:00:00', '16:50:00', 8, '09:00:00', $grace, '17:00:00');
        $this->assertEquals('late', $details['status']);
        $this->assertEquals(10, $details['late_minutes']);
        $this->assertEquals(0, $details['undertime_minutes']);
        $this->assertEquals(0.0, $details['overtime_hours']);
    }

    public function test_clock_out_inside_out_grace_is_completed_with_no_ot()
    {
        $grace = ['grace_enabled' => true, 'grace_type' => '-/+', 'grace_minutes' => 15];
        $details = AttendanceService::calculateDetails('09:00:00', '17:10:00', 8, '09:00:00', $grace, '17:00:00');
        $this->assertEquals('completed', $details['status']);
        $this->assertEquals(0.0, $details['overtime_hours']);
    }

    public function test_clock_out_past_out_grace_caps_regular_hours_and_keeps_ot_tail()
    {
        $grace = ['grace_enabled' => true, 'grace_type' => '-/+', 'grace_minutes' => 15];
        $details = AttendanceService::calculateDetails('09:00:00', '18:00:00', 8, '09:00:00', $grace, '17:00:00');
        $this->assertEquals('completed', $details['status']);
        $this->assertEquals(8.25, $details['hours_worked']);
        $this->assertEquals(0.8, $details['overtime_hours']);
    }

    #[DataProvider('deviationProvider')]
    public function test_classify_deviation(float $hoursWorked, ?string $expected)
    {
        $this->assertSame($expected, AttendanceService::classifyDeviation($hoursWorked, 8));
    }

    public static function deviationProvider(): array
    {
        return [
            'over the full shift'      => [9.0, 'overtime'],
            'a minute over'            => [8.02, 'overtime'],
            'exactly the full shift'   => [8.0, null],
            'short but past half'      => [5.0, 'undertime'],
            'exactly half'             => [4.0, 'half_day'],
            'under half'               => [3.99, 'half_day'],
            'barely worked'            => [0.5, 'half_day'],
        ];
    }

    public function test_classify_deviation_ignores_shifts_with_no_expected_hours()
    {
        $this->assertNull(AttendanceService::classifyDeviation(8.0, 0));
    }

    public function test_flexi_never_late_and_hours_gap_is_undertime_or_half_day()
    {
        $this->assertEquals('absent', AttendanceService::calculateFlexiStatus(null, null, 8));
        $this->assertEquals('working', AttendanceService::calculateFlexiStatus('09:00:00', null, 8));
        $this->assertEquals('half_day', AttendanceService::calculateFlexiStatus('09:00:00', '13:00:00', 8));
        $this->assertEquals('undertime', AttendanceService::calculateFlexiStatus('09:00:00', '16:50:00', 8));
        $this->assertEquals('completed', AttendanceService::calculateFlexiStatus('09:00:00', '17:00:00', 8));
        $flexi = AttendanceService::calculateFlexiDetails('09:00:00', '16:50:00', 8);
        $this->assertEquals(0, $flexi['late_minutes']);
        $this->assertGreaterThan(0, $flexi['undertime_minutes']);
    }

    public function test_overtime_hours_rounded_to_one_decimal()
    {
        $fixed = AttendanceService::calculateDetails('09:00:00', '18:32:00', 8, '09:00:00', null, '17:00:00');
        $this->assertSame(1.5, $fixed['overtime_hours']);

        $flexi = AttendanceService::calculateFlexiDetails('09:00:00', '18:37:00', 8);
        $this->assertSame(1.6, $flexi['overtime_hours']);
    }
}
