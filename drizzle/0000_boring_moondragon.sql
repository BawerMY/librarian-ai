CREATE TABLE "account" (
	"userId" text NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"providerAccountId" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "account_provider_providerAccountId_pk" PRIMARY KEY("provider","providerAccountId")
);
--> statement-breakpoint
CREATE TABLE "books" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"author" text NOT NULL,
	"year_written" text,
	"category" text,
	"color" text,
	"openlibrary_key" text,
	"cover_url" text,
	"is_pd" boolean DEFAULT false NOT NULL,
	"ol_data" jsonb,
	"ol_fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"citations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"edition_id" text NOT NULL,
	"idx" integer NOT NULL,
	"text" text NOT NULL,
	"chapter" text,
	"section" text,
	"page" integer,
	"pos_pct" real NOT NULL,
	"lang" text DEFAULT 'en' NOT NULL,
	"token_count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "edition_text" (
	"edition_id" text PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"structure" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "editions" (
	"id" text PRIMARY KEY NOT NULL,
	"book_id" text NOT NULL,
	"kind" text NOT NULL,
	"owner_user_id" text,
	"lang" text DEFAULT 'en' NOT NULL,
	"translator" text,
	"year" text,
	"source" text,
	"source_ref" text,
	"content_hash" text,
	"file_format" text,
	"has_pages" boolean DEFAULT false NOT NULL,
	"embed_model" text,
	"embed_dim" integer,
	"index_status" text DEFAULT 'pending' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"error" text,
	"chunk_count" integer,
	"indexed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_iff_private" CHECK (("editions"."kind" = 'private') = ("editions"."owner_user_id" IS NOT NULL)),
	CONSTRAINT "kind_values" CHECK ("editions"."kind" IN ('public','private')),
	CONSTRAINT "index_status_values" CHECK ("editions"."index_status" IN ('pending','parsing','embedding','ready','failed'))
);
--> statement-breakpoint
CREATE TABLE "reveal_log" (
	"user_id" text NOT NULL,
	"edition_id" text NOT NULL,
	"chunk_idx" integer NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reveal_log_user_id_edition_id_chunk_idx_pk" PRIMARY KEY("user_id","edition_id","chunk_idx")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"sessionToken" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"expires" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_library" (
	"user_id" text NOT NULL,
	"edition_id" text NOT NULL,
	"status" text NOT NULL,
	"selected" boolean DEFAULT true NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_library_user_id_edition_id_pk" PRIMARY KEY("user_id","edition_id"),
	CONSTRAINT "library_status_values" CHECK ("user_library"."status" IN ('ready','needs_file'))
);
--> statement-breakpoint
CREATE TABLE "user_prefs" (
	"user_id" text PRIMARY KEY NOT NULL,
	"quote_exact" boolean DEFAULT true NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"email" text,
	"emailVerified" timestamp,
	"image" text,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verificationToken" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp NOT NULL,
	CONSTRAINT "verificationToken_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_edition_id_editions_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."editions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edition_text" ADD CONSTRAINT "edition_text_edition_id_editions_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."editions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "editions" ADD CONSTRAINT "editions_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "editions" ADD CONSTRAINT "editions_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reveal_log" ADD CONSTRAINT "reveal_log_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reveal_log" ADD CONSTRAINT "reveal_log_edition_id_editions_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."editions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_library" ADD CONSTRAINT "user_library_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_library" ADD CONSTRAINT "user_library_edition_id_editions_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."editions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_prefs" ADD CONSTRAINT "user_prefs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "books_title_idx" ON "books" USING btree ("title");--> statement-breakpoint
CREATE INDEX "books_author_idx" ON "books" USING btree ("author");--> statement-breakpoint
CREATE INDEX "chat_messages_session_idx" ON "chat_messages" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_sessions_user_idx" ON "chat_sessions" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chunks_edition_idx" ON "chunks" USING btree ("edition_id","idx");--> statement-breakpoint
CREATE UNIQUE INDEX "editions_one_public_per_book" ON "editions" USING btree ("book_id") WHERE "editions"."kind" = 'public';--> statement-breakpoint
CREATE UNIQUE INDEX "editions_private_hash_per_owner" ON "editions" USING btree ("owner_user_id","content_hash") WHERE "editions"."kind" = 'private';--> statement-breakpoint
CREATE INDEX "editions_pending_idx" ON "editions" USING btree ("index_status") WHERE "editions"."index_status" = 'pending';--> statement-breakpoint
CREATE INDEX "editions_owner_idx" ON "editions" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "user_library_selected_idx" ON "user_library" USING btree ("user_id") WHERE "user_library"."selected";