# /bin/record-feedback

## Purpose

Record a quick employee reaction to a previous Minutka answer.

## Mutating

Yes: writes feedback state/event.

## Input

- employee id
- thread id
- target message id
- rating: `positive`, `neutral`, or `negative`
- optional comment

## Output

Feedback record or feedback event.

## Rules

- Feedback concerns answer quality, not employee performance.
- Feedback does not change insight extraction for the current turn.
- Future analytics must aggregate feedback safely.
