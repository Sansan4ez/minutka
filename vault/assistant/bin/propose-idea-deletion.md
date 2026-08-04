# proposeIdeaDeletion

## Purpose

Prepare deletion of one exact authenticated-owner idea id at an expected revision and return a safe pending-action receipt.

## Confirmation level

Level 1: deleting one idea is destructive but recoverable. Ask once in normal prose and explicitly say the owner can answer «да» or press the button; both paths resolve the same authenticated confirmation outside the agent loop.

## Boundary

The tool does not delete the idea. Owner scope is request-bound, unknown and foreign ids are indistinguishable, and execution requires the authenticated application confirmation. Ambiguous references must be resolved before calling this tool. The transport, not the model, deterministically resolves short verbal confirmation.
