ALTER TABLE minutka_private.profiles
  DROP CONSTRAINT profiles_employee_id_fkey,
  DROP CONSTRAINT profiles_employee_role_fk,
  ADD CONSTRAINT profiles_employee_role_fk
    FOREIGN KEY (employee_id, role_id)
    REFERENCES minutka_private.participants(employee_id, role_id)
    ON UPDATE CASCADE
    ON DELETE CASCADE;
