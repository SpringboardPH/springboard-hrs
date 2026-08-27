<?php

namespace Database\Seeders;

use App\Models\User;
use Illuminate\Database\Console\Seeds\WithoutModelEvents;
use Illuminate\Database\Seeder;

class DatabaseSeeder extends Seeder
{
    use WithoutModelEvents;

    /**
     * Seed the application's database.
     */
    public function run(): void
    {
        User::updateOrCreate(
            ['email' => 'dev@springboardph.com'],
            [
                'name' => 'Administrator',
                'password' => bcrypt('password'),
                'role' => 'admin',
            ]
        );

        $this->call([
            DepartmentSeeder::class,
            SystemSettingsSeeder::class,
            LeaveTypeSeeder::class,
            ScheduleTemplateSeeder::class,
            CalendarEventTypeSeeder::class,
            DemoPeopleSeeder::class,
            DemoOpsSeeder::class,
        ]);
    }
}
