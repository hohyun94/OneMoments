ALTER TABLE "messages" ADD COLUMN "kind" text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "target_message_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_target_message_id_messages_id_fk" FOREIGN KEY ("target_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_target_idx" ON "messages" USING btree ("target_message_id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_kind_chk" CHECK ("messages"."kind" in ('text', 'reaction', 'edit'));