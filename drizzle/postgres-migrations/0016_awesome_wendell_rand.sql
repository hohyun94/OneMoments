CREATE TABLE "login_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alias" text NOT NULL,
	"user_id" uuid NOT NULL,
	"password_hash" text NOT NULL,
	"kind" text DEFAULT 'decoy' NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "login_profiles_kind_chk" CHECK ("login_profiles"."kind" in ('decoy'))
);
--> statement-breakpoint
ALTER TABLE "login_profiles" ADD CONSTRAINT "login_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "login_profiles_alias_uq" ON "login_profiles" USING btree ("alias");--> statement-breakpoint
CREATE INDEX "login_profiles_user_idx" ON "login_profiles" USING btree ("user_id");