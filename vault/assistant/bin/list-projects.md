# `listProjects`

## Purpose

List bounded project labels already used by the authenticated owner across ideas and tasks, with idea, task, and total record counts.

## Inputs

An optional bounded result limit. There is no owner id input.

## Output

A bounded array of canonical project labels with `ideaCount`, `taskCount`, and `totalCount`, plus a `truncated` flag when the result or bounded source scan was capped.

## Boundary

Read-only. `AssistantService` binds the authenticated owner. A project remains a string label on ideas and tasks; this tool does not create a project entity.

The source scan intentionally considers only the first 500 ideas and first 500 tasks in `created_asc` order. This preserves deterministic canonical spelling but means labels introduced only in newer records beyond that boundary are not discovered.
