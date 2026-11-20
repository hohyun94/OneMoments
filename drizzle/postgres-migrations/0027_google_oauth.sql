CREATE TABLE "oauth_states" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'google' NOT NULL,
	"intent" text NOT NULL,
	"code_verifier" text NOT NULL,
	"user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_states_provider_chk" CHECK ("oauth_states"."provider" in ('google')),
	CONSTRAINT "oauth_states_intent_chk" CHECK ("oauth_states"."intent" in ('signup', 'login', 'link')),
	CONSTRAINT "oauth_states_link_chk" CHECK ("oauth_states"."intent" <> 'link' or "oauth_states"."user_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "oauth_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text DEFAULT 'google' NOT NULL,
	"subject" text NOT NULL,
	"email" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"intent" text NOT NULL,
	"user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_tickets_provider_chk" CHECK ("oauth_tickets"."provider" in ('google')),
	CONSTRAINT "oauth_tickets_intent_chk" CHECK ("oauth_tickets"."intent" in ('signup', 'login', 'link')),
	CONSTRAINT "oauth_tickets_link_chk" CHECK ("oauth_tickets"."intent" = 'signup' or "oauth_tickets"."user_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "oauth_provider" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "oauth_subject" text;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tickets" ADD CONSTRAINT "oauth_tickets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_states_expires_idx" ON "oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_tickets_expires_idx" ON "oauth_tickets" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_oauth_uq" ON "users" USING btree ("oauth_provider","oauth_subject") WHERE "users"."oauth_subject" is not null;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_credential_chk" CHECK ("users"."password_hash" is not null or "users"."oauth_subject" is not null);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_oauth_provider_chk" CHECK ("users"."oauth_provider" is null or "users"."oauth_provider" in ('google'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_oauth_subject_chk" CHECK (("users"."oauth_provider" is null) = ("users"."oauth_subject" is null));