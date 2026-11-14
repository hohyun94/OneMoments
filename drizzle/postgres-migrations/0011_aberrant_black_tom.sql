ALTER TABLE "devices" ADD COLUMN "signed_pre_key_id" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "signed_pre_key_public_key" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "signed_pre_key_signature" text;--> statement-breakpoint
ALTER TABLE "message_keys" ADD COLUMN "sender_identity_public_key" text;--> statement-breakpoint
ALTER TABLE "message_keys" ADD COLUMN "signed_pre_key_id" text;--> statement-breakpoint
ALTER TABLE "message_keys" ADD CONSTRAINT "message_keys_x3dh_chk" CHECK (("message_keys"."sender_identity_public_key" is null and "message_keys"."signed_pre_key_id" is null) or ("message_keys"."sender_identity_public_key" is not null and "message_keys"."signed_pre_key_id" is not null));