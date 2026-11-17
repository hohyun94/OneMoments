ALTER TABLE "devices" ADD COLUMN "idle_timeout_seconds" integer DEFAULT 300 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "idle_timeout_seconds" integer;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_idle_timeout_chk" CHECK ("devices"."idle_timeout_seconds" between 60 and 1800);--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_idle_timeout_chk" CHECK ("sessions"."idle_timeout_seconds" is null or ("sessions"."idle_timeout_seconds" between 60 and 1800));