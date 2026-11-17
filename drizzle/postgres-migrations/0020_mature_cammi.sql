ALTER TABLE "users" ADD COLUMN "theme_mode" text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "theme_accent" text DEFAULT 'violet' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_theme_mode_chk" CHECK ("users"."theme_mode" in ('light', 'dark', 'system'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_theme_accent_chk" CHECK ("users"."theme_accent" ~ '^(violet|blue|emerald|rose|amber|#[0-9a-f]{6})$');