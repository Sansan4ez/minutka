# `confirmTaskMutation`

## Purpose

Execute a previously prepared task proposal after the current owner explicitly confirms that exact action.

## Inputs

The pending confirmation id and the exact normalized proposal returned by a proposal tool. Never reconstruct or alter the proposal.

## Output

A stable confirmed/already-confirmed task outcome, or a fail-closed status for unknown, foreign, expired, or changed confirmations.

## Boundary

This is the only agent-facing task mutation tool. The application binds the authenticated owner and the durable confirmation store serializes execution. Replayed confirmation returns the stored outcome and does not repeat the effect.
