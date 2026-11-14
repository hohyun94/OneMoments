CREATE TABLE "device_one_time_pre_keys" (
	"device_id" uuid NOT NULL,
	"key_id" uuid NOT NULL,
	"public_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "device_one_time_pre_keys_device_id_key_id_pk" PRIMARY KEY("device_id","key_id")
);
--> statement-breakpoint
ALTER TABLE "device_one_time_pre_keys" ADD CONSTRAINT "device_one_time_pre_keys_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_one_time_pre_keys_device_idx" ON "device_one_time_pre_keys" USING btree ("device_id","used_at");