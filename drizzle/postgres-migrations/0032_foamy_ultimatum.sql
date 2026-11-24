ALTER TABLE "users" ADD COLUMN "avatar_mime" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_data" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_avatar_mime_chk" CHECK ("users"."avatar_mime" is null or "users"."avatar_mime" in ('image/png', 'image/jpeg', 'image/webp'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_avatar_pair_chk" CHECK (("users"."avatar_mime" is null) = ("users"."avatar_data" is null));