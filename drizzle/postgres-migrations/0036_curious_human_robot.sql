CREATE TABLE "signup_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"token_hash" text NOT NULL,
	"invite_id" uuid,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signup_requests_status_chk" CHECK ("signup_requests"."status" in ('pending', 'approved', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "signup_requests" ADD CONSTRAINT "signup_requests_invite_id_signup_invites_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."signup_invites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signup_requests" ADD CONSTRAINT "signup_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "signup_requests_token_uq" ON "signup_requests" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "signup_requests_status_created_idx" ON "signup_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "signup_requests_username_idx" ON "signup_requests" USING btree ("username");