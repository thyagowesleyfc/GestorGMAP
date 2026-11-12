CREATE UNIQUE INDEX "contract_balance_movement_glosa_os_line_key"
  ON "contract_balance_movement"("maintenance_service_order_service_id")
  WHERE "type" = 'GLOSA_OS';
