## Learned User Preferences
- Prefer `/poteto-mode` for substantial planning and feature work
- Prefer database/schema changes via Laravel migration files rather than ad-hoc DB edits
- Prefer continuing work on the current branch; do not create a new branch unless explicitly asked
- Prefer brief client demo/showcase flows that hint at functionality without spending much time; demo attendance should mix currently working and absent people and include geotagging
- Prefer TINs auto-formatted as `###-###-###-####` (default branch `0000` when only nine digits are entered), including normalizing existing stored values
- Prefer `/hr/employees` to default to the Active filter
- Prefer Deactivate on `/hr/employees` to mark the employee inactive without soft-deleting, since status already tracks inactivity
- Prefer approving half-day or undertime to keep that status mark and dock pay from hours short—not rewrite the log to Completed or grant full scheduled-day pay

## Learned Workspace Facts
- Local development database name is `launchr`
- BIR Form 2316 UI and export helpers live under `frontend/src/pages/bir/`; reference material is under `docs/bir-alphalist`; Form 1604-C is planned similarly; DAT export is deferred
- Employee `tin_number` stores the full `###-###-###-####` value (branch code absorbed into TIN; no separate `branch_code` column)
- Form 2316 generation autofills from LAUNCHR data and supports last-minute edits, including saving employee details from the form screen
- When manually updating attendance status without involving times, clock logs should be nulled
- Blank attendance grid cells are meant to be clickable so a status can be set without an existing log
- Client showcase data comes from `DemoPeopleSeeder` and `DemoOpsSeeder`; the Today attendance list must honor `absent` instead of treating every open punch as working
- Laravel `date` casts JSON-serialize as UTC midnight; attendance UI must parse the full ISO timestamp (not a `yyyy-MM-dd` slice) so Asia/Manila calendar days match the grid
- Login OTP and password-reset emails are queued to the `jobs` table and only send while a queue worker is running
- Open punches stay `working`; Late, Half-day, Undertime, and Completed stamp at clock-out. Half-day is hours at or below half of expected; a shortfall within grace is Late and docks as late; undertime is a larger shortfall still over half. Completed payroll pays full scheduled hours, ignoring actual clocked time. Approving half-day or undertime must not promote the log to Completed; pay docks from hours short. Time after clock-out grace does not add regular hours and follows OT rules. Flexi has no scheduled start, so arrival-late does not apply the same way.
- Night-shift clock windows wrap past midnight; after a finished overnight shift, clock-in stays blocked until the next evening window even if adopt-yesterday would still look open
- Admin Date and Time settings seed System Date/Time from live `SystemClock` once on page load (not the static stored baseline), then freeze the fields
