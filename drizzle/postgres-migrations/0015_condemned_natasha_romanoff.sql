ALTER TABLE "attachments" ADD COLUMN "message_client_id" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "message_id" uuid;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "last_accessed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_message_client_idx" ON "attachments" USING btree ("message_client_id");