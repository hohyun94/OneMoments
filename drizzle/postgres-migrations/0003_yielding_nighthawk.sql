ALTER TABLE "conversations" DROP CONSTRAINT "conversations_kind_chk";--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_group_name_chk" CHECK ("conversations"."kind" = 'direct' or ("conversations"."name" is not null and char_length("conversations"."name") between 1 and 64));--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_kind_chk" CHECK ("conversations"."kind" in ('direct', 'group'));