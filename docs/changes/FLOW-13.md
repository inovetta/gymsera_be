# FLOW-13: Trainer Session Bookings (NOT REPRODUCED)

- **Issue ID**: FLOW-13
- **Title**: Trainer session bookings: Prevent double-booking with a unique constraint on (trainerId, slotStart), or with a row lock on the slot. Handle cancellations and refunds via PAY-07.
- **Status**: NOT REPRODUCED
- **Investigation & Findings**:
  - Comprehensive codebase audit across `gymsera_be`, `gyms_era`, `gymsera_cms`, and `gymsera_web` confirmed that no trainer booking system, session scheduling model, or booking endpoints currently exist in the codebase.
  - The backend only possesses basic trainer profile management in `src/services/trainer.service.js` (creating profiles, updating bio/certifications, and assigning trainers to branches) and staff role assignments (`RoleKey.TRAINER`).
  - No database tables exist for trainer appointments, slots, or bookings (`trainer_bookings`, `trainer_sessions`, etc.).
  - Because no booking mechanism exists in code, the hypothesized double-booking race condition could not be reproduced.
  - Once trainer booking functionality is scheduled for implementation in a future milestone, slot concurrency locks and unique constraints on `(trainer_id, slot_start)` should be built directly into the booking engine.
