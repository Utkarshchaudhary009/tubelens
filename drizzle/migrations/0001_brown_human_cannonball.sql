DROP INDEX "usage_ledger_principal_window_idx";--> statement-breakpoint
CREATE INDEX "usage_ledger_principal_window_idx" ON "usage_ledger" USING btree ("principal","window_id","outcome");