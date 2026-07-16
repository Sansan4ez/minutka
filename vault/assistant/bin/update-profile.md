# /bin/update-profile

## Purpose

Save validated onboarding/profile fields.

## Mutating

Yes: writes participant/profile state.

## Input

- employee id
- role
- typical tasks
- persona
- AI level
- response length preference
- accepted consent version

## Output

Updated profile and participant/onboarding events.

## Rules

- Application schemas validate all fields before writing.
- Persona affects tone only.
- Profile storage is application state projected into `/proc/profile`; raw profile data should not be committed to vault git files.
