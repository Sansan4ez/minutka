ALTER TABLE minutka_private.ideas
  ADD CONSTRAINT ideas_project_nonblank_check
  CHECK (length(btrim(project)) > 0);
