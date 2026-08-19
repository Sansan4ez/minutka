-- Onboarding completion now seeds the engagement clock. Participants who
-- completed onboarding before that write existed and never wrote themselves
-- would otherwise stay "active" forever, because an absent last touch is read
-- as "onboarding not completed". The completion timestamp is the best available
-- date for them; the profile timezone shifts it by at most one day.
UPDATE minutka_private.participants
SET last_touch_on = updated_at::date
WHERE status = 'profile_completed'
  AND last_touch_on IS NULL;
