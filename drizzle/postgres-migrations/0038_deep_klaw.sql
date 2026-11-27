CREATE TABLE "diaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"label" text,
	"key_epoch" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "diaries_key_epoch_chk" CHECK ("diaries"."key_epoch" >= 1)
);
--> statement-breakpoint
CREATE TABLE "diary_audience" (
	"diary_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_epoch" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "diary_audience_diary_id_user_id_pk" PRIMARY KEY("diary_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "diary_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"diary_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"author_device_id" uuid NOT NULL,
	"author_signing_public_key" text NOT NULL,
	"key_epoch" integer NOT NULL,
	"client_entry_id" uuid NOT NULL,
	"ciphertext" text NOT NULL,
	"nonce" text NOT NULL,
	"signature" text NOT NULL,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diary_entry_keys" (
	"entry_id" uuid NOT NULL,
	"recipient_device_id" uuid NOT NULL,
	"ephemeral_public_key" text,
	"ratchet_public_key" text,
	"previous_chain_length" integer,
	"message_number" integer,
	"sender_identity_public_key" text,
	"signed_pre_key_id" text,
	"one_time_pre_key_id" text,
	"wrapped_key" text,
	"wrap_nonce" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "diary_entry_keys_entry_id_recipient_device_id_pk" PRIMARY KEY("entry_id","recipient_device_id")
);
--> statement-breakpoint
ALTER TABLE "diaries" ADD CONSTRAINT "diaries_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_audience" ADD CONSTRAINT "diary_audience_diary_id_diaries_id_fk" FOREIGN KEY ("diary_id") REFERENCES "public"."diaries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_audience" ADD CONSTRAINT "diary_audience_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_entries" ADD CONSTRAINT "diary_entries_diary_id_diaries_id_fk" FOREIGN KEY ("diary_id") REFERENCES "public"."diaries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_entries" ADD CONSTRAINT "diary_entries_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_entries" ADD CONSTRAINT "diary_entries_author_device_id_devices_id_fk" FOREIGN KEY ("author_device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_entry_keys" ADD CONSTRAINT "diary_entry_keys_entry_id_diary_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."diary_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_entry_keys" ADD CONSTRAINT "diary_entry_keys_recipient_device_id_devices_id_fk" FOREIGN KEY ("recipient_device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "diaries_owner_idx" ON "diaries" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "diary_audience_user_idx" ON "diary_audience" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "diary_entries_client_uq" ON "diary_entries" USING btree ("author_user_id","client_entry_id");--> statement-breakpoint
CREATE INDEX "diary_entries_diary_created_idx" ON "diary_entries" USING btree ("diary_id","created_at");--> statement-breakpoint
CREATE INDEX "diary_entry_keys_device_idx" ON "diary_entry_keys" USING btree ("recipient_device_id");