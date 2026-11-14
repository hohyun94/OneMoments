ALTER TABLE "message_keys" DROP CONSTRAINT "message_keys_version_chk";--> statement-breakpoint
ALTER TABLE "message_keys" ALTER COLUMN "ephemeral_public_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "message_keys" ADD COLUMN "ratchet_public_key" text;--> statement-breakpoint
ALTER TABLE "message_keys" ADD COLUMN "previous_chain_length" integer;--> statement-breakpoint
ALTER TABLE "message_keys" ADD COLUMN "message_number" integer;--> statement-breakpoint
ALTER TABLE "message_keys" ADD CONSTRAINT "message_keys_envelope_chk" CHECK (("message_keys"."version" = 1 and "message_keys"."ephemeral_public_key" is not null and "message_keys"."ratchet_public_key" is null) or ("message_keys"."version" = 2 and "message_keys"."ephemeral_public_key" is null and "message_keys"."ratchet_public_key" is not null and "message_keys"."previous_chain_length" is not null and "message_keys"."message_number" is not null));--> statement-breakpoint
ALTER TABLE "message_keys" ADD CONSTRAINT "message_keys_version_chk" CHECK ("message_keys"."version" in (1, 2));