# /bin/update-profile

## Purpose

Save validated onboarding/profile fields.

## Mutating

Yes: writes participant/profile state.

## Input

- employee id
- role and delivery preferences
- optional bounded typical tasks
- optional closed AI level
- optional bounded personal program goal
- accepted consent version

## Output

Updated profile and participant/onboarding events.

## Rules

- Application schemas validate all fields before writing.
- Persona affects tone only.
- Direct HTTP/CLI onboarding may supply the optional personal fields, but the four-question Telegram form does not ask for them.
- Later conversational updates use the narrower `updatePersonalContext` action.
- Profile storage is application state projected into `/proc/profile`; raw profile data should not be committed to vault git files or copied into company reporting.
