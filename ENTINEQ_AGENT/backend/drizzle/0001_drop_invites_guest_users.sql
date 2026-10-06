ALTER TABLE "invites" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "invites" CASCADE;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "engine" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "is_free" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "free_used" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "subscribed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "signup_ip_hash" text;--> statement-breakpoint
CREATE INDEX "usage_events_free_idx" ON "usage_events" USING btree ("created_at") WHERE "usage_events"."is_free";--> statement-breakpoint
CREATE INDEX "users_signup_ip_idx" ON "users" USING btree ("signup_ip_hash","created_at");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_credentials_pair" CHECK (("users"."email" is null) = ("users"."password_hash" is null));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_guest_is_public" CHECK ("users"."email" is not null or "users"."role" = 'public');