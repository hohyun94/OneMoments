CREATE TABLE "message_reads" (
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_reads_message_id_user_id_pk" PRIMARY KEY("message_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "auto_delete_after_read_seconds" integer;--> statement-breakpoint
ALTER TABLE "message_reads" ADD CONSTRAINT "message_reads_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reads" ADD CONSTRAINT "message_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_reads_user_idx" ON "message_reads" USING btree ("user_id","read_at");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_auto_delete_chk" CHECK ("conversations"."auto_delete_after_read_seconds" is null or ("conversations"."auto_delete_after_read_seconds" between 3600 and 2592000));