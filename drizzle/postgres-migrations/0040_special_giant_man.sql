CREATE TABLE "diary_entry_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"ciphertext" text NOT NULL,
	"nonce" text NOT NULL,
	"signature" text NOT NULL,
	"key_epoch" integer NOT NULL,
	"keys" jsonb NOT NULL,
	"edited_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "diary_entry_versions" ADD CONSTRAINT "diary_entry_versions_entry_id_diary_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."diary_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_entry_versions" ADD CONSTRAINT "diary_entry_versions_edited_by_user_id_users_id_fk" FOREIGN KEY ("edited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "diary_entry_versions_uq" ON "diary_entry_versions" USING btree ("entry_id","version_no");--> statement-breakpoint
CREATE INDEX "diary_entry_versions_entry_idx" ON "diary_entry_versions" USING btree ("entry_id");