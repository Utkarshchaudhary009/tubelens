CREATE TABLE "usage_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"principal" text NOT NULL,
	"tier" text NOT NULL,
	"operation" text NOT NULL,
	"cost" integer NOT NULL,
	"policy_version" text NOT NULL,
	"window_id" text NOT NULL,
	"outcome" text NOT NULL,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_ledger_request_id_uid" UNIQUE("request_id"),
	CONSTRAINT "usage_ledger_cost_nonnegative" CHECK ("usage_ledger"."cost" >= 0),
	CONSTRAINT "usage_ledger_outcome_values" CHECK ("usage_ledger"."outcome" IN ('accepted', 'rejected', 'partial'))
);
--> statement-breakpoint
CREATE INDEX "usage_ledger_principal_window_idx" ON "usage_ledger" USING btree ("principal","window_id");