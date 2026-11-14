ALTER TABLE "message_keys" ADD COLUMN "distribution_ciphertext" text;--> statement-breakpoint
ALTER TABLE "message_keys" ADD COLUMN "distribution_nonce" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sender_key_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sender_key_iteration" integer;--> statement-breakpoint
ALTER TABLE "message_keys" ADD CONSTRAINT "message_keys_distribution_chk" CHECK (("message_keys"."distribution_ciphertext" is null and "message_keys"."distribution_nonce" is null) or ("message_keys"."distribution_ciphertext" is not null and "message_keys"."distribution_nonce" is not null));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_key_chk" CHECK (("messages"."sender_key_id" is null and "messages"."sender_key_iteration" is null) or ("messages"."sender_key_id" is not null and "messages"."sender_key_iteration" is not null));