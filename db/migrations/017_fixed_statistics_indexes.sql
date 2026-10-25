-- Fixed business statistics use submitted time and the application department.
CREATE INDEX applications_fixed_department_submitted_idx
  ON applications(department_id,submitted_at,type,status)
  WHERE submitted_at IS NOT NULL AND type IN ('travel','purchase','reimbursement');
CREATE INDEX applications_fixed_applicant_submitted_idx
  ON applications(applicant_id,submitted_at,type,status)
  WHERE submitted_at IS NOT NULL AND type IN ('travel','purchase','reimbursement');
