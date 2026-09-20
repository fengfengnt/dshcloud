CREATE TABLE "workspace_grant" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"state_hash" text NOT NULL,
	"instance_id" text NOT NULL,
	"session_id" text NOT NULL,
	"callback_url" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_session" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"session_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_grant" ADD CONSTRAINT "workspace_grant_instance_id_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_grant" ADD CONSTRAINT "workspace_grant_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_session" ADD CONSTRAINT "workspace_session_instance_id_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_session" ADD CONSTRAINT "workspace_session_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_grant_expiry_idx" ON "workspace_grant" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "workspace_session_expiry_idx" ON "workspace_session" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "workspace_session_parent_idx" ON "workspace_session" USING btree ("session_id");