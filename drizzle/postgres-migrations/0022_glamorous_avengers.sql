CREATE TABLE "moment_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uploader_user_id" uuid NOT NULL,
	"client_moment_id" uuid,
	"moment_id" uuid,
	"size" integer NOT NULL,
	"last_accessed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moment_audience" (
	"moment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "moment_audience_moment_id_user_id_pk" PRIMARY KEY("moment_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "moment_keys" (
	"moment_id" uuid NOT NULL,
	"recipient_device_id" uuid NOT NULL,
	"ephemeral_public_key" text,
	"ratchet_public_key" text,
	"previous_chain_length" integer,
	"message_number" integer,
	"sender_identity_public_key" text,
	"signed_pre_key_id" text,
	"one_time_pre_key_id" text,
	"wrapped_key" text NOT NULL,
	"wrap_nonce" text NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moment_keys_moment_id_recipient_device_id_pk" PRIMARY KEY("moment_id","recipient_device_id")
);
--> statement-breakpoint
CREATE TABLE "moment_views" (
	"moment_id" uuid NOT NULL,
	"viewer_user_id" uuid NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moment_views_moment_id_viewer_user_id_pk" PRIMARY KEY("moment_id","viewer_user_id")
);
--> statement-breakpoint
CREATE TABLE "moments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"author_user_id" uuid NOT NULL,
	"author_device_id" uuid NOT NULL,
	"author_signing_public_key" text NOT NULL,
	"ciphertext" text NOT NULL,
	"nonce" text NOT NULL,
	"signature" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "moment_attachments" ADD CONSTRAINT "moment_attachments_uploader_user_id_users_id_fk" FOREIGN KEY ("uploader_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moment_attachments" ADD CONSTRAINT "moment_attachments_moment_id_moments_id_fk" FOREIGN KEY ("moment_id") REFERENCES "public"."moments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moment_audience" ADD CONSTRAINT "moment_audience_moment_id_moments_id_fk" FOREIGN KEY ("moment_id") REFERENCES "public"."moments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moment_audience" ADD CONSTRAINT "moment_audience_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moment_keys" ADD CONSTRAINT "moment_keys_moment_id_moments_id_fk" FOREIGN KEY ("moment_id") REFERENCES "public"."moments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moment_keys" ADD CONSTRAINT "moment_keys_recipient_device_id_devices_id_fk" FOREIGN KEY ("recipient_device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moment_views" ADD CONSTRAINT "moment_views_moment_id_moments_id_fk" FOREIGN KEY ("moment_id") REFERENCES "public"."moments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moment_views" ADD CONSTRAINT "moment_views_viewer_user_id_users_id_fk" FOREIGN KEY ("viewer_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moments" ADD CONSTRAINT "moments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moments" ADD CONSTRAINT "moments_author_device_id_devices_id_fk" FOREIGN KEY ("author_device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "moment_attachments_uploader_idx" ON "moment_attachments" USING btree ("uploader_user_id");--> statement-breakpoint
CREATE INDEX "moment_attachments_client_idx" ON "moment_attachments" USING btree ("client_moment_id");--> statement-breakpoint
CREATE INDEX "moment_audience_user_idx" ON "moment_audience" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "moment_keys_device_idx" ON "moment_keys" USING btree ("recipient_device_id");--> statement-breakpoint
CREATE INDEX "moment_views_viewer_idx" ON "moment_views" USING btree ("viewer_user_id");--> statement-breakpoint
CREATE INDEX "moments_author_idx" ON "moments" USING btree ("author_user_id");--> statement-breakpoint
CREATE INDEX "moments_expires_idx" ON "moments" USING btree ("expires_at");