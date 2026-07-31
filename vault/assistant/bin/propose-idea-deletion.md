# proposeIdeaDeletion

## Purpose

Prepare deletion of one exact authenticated-owner idea id at an expected revision and return a safe pending-action receipt.

## Boundary

The tool does not delete the idea. Owner scope is request-bound, unknown and foreign ids are indistinguishable, and execution requires a separate authenticated application confirmation. Ambiguous references must be resolved before calling this tool.
