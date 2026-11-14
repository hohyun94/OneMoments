ALTER TABLE "messages" ADD COLUMN "sender_signing_public_key" text;
--> statement-breakpoint
UPDATE "messages"
SET "sender_signing_public_key" = "devices"."signing_public_key"
FROM "devices"
WHERE "devices"."id" = "messages"."sender_device_id"
  AND "messages"."sender_signing_public_key" IS NULL;
--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "sender_signing_public_key" SET NOT NULL;
