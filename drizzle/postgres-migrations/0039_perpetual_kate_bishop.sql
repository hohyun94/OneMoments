CREATE TABLE "diary_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uploader_user_id" uuid NOT NULL,
	"client_entry_id" uuid,
	"entry_id" uuid,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "diary_attachments" ADD CONSTRAINT "diary_attachments_uploader_user_id_users_id_fk" FOREIGN KEY ("uploader_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_attachments" ADD CONSTRAINT "diary_attachments_entry_id_diary_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."diary_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "diary_attachments_entry_idx" ON "diary_attachments" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "diary_attachments_client_idx" ON "diary_attachments" USING btree ("uploader_user_id","client_entry_id");