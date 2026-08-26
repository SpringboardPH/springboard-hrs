<?php

namespace Tests\Unit;

use App\Services\PayrollService;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

class SpecialHolidayPremiumTest extends TestCase
{
    #[DataProvider('typeNameProvider')]
    public function test_snwh_type_matcher(?string $name, bool $expected): void
    {
        $this->assertSame($expected, PayrollService::isSpecialNonWorkingHoliday($name));
    }

    public static function typeNameProvider(): array
    {
        return [
            'seeded name' => ['Special Non-Working Day', true],
            'holiday wording' => ['Special Non-Working Holiday', true],
            'regular holiday' => ['Regular Holiday', false],
            'payslip label' => ['Special Holiday', false],
            'empty' => ['', false],
            'null' => [null, false],
        ];
    }

    public function test_premium_table_at_one_thousand_daily(): void
    {
        $daily = 1000.0;

        $this->assertEquals(300.00, PayrollService::specialHolidayPremium($daily, 1000, 0, 0, 0));
        $this->assertEquals(355.00, PayrollService::specialHolidayPremium($daily, 1000, 1, 0, 0));
        $this->assertEquals(150.00, PayrollService::specialHolidayPremium($daily, 500, 0, 0, 0));
        $this->assertEquals(200.00, PayrollService::specialHolidayPremium($daily, 0, 0, 1000, 0));
        $this->assertEquals(232.50, PayrollService::specialHolidayPremium($daily, 0, 0, 1000, 1));
        $this->assertEquals(0.00, PayrollService::specialHolidayPremium($daily, 0, 0, 0, 0));
    }
}
