import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

/* ------------------------------------------------------------------ *
 * Auth.js (Drizzle adapter schema)
 * ------------------------------------------------------------------ */

export const users = pgTable('user', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text('name'),
  email: text('email').unique(),
  emailVerified: timestamp('emailVerified', { mode: 'date' }),
  image: text('image'),
  /**
   * scrypt hash, "scrypt:N:r:p:salt:derived" — see lib/password.ts.
   * NULL for accounts created through an OAuth provider, which have no
   * password to verify.
   */
  passwordHash: text('password_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const accounts = pgTable(
  'account',
  {
    userId: text('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').$type<'oauth' | 'oidc' | 'email' | 'webauthn'>().notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('providerAccountId').notNull(),
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })],
)

export const sessions = pgTable('session', {
  sessionToken: text('sessionToken').primaryKey(),
  userId: text('userId')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires', { mode: 'date' }).notNull(),
})

export const verificationTokens = pgTable(
  'verificationToken',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: timestamp('expires', { mode: 'date' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
)

/* ------------------------------------------------------------------ *
 * Catalog — shared by every user. METADATA ONLY.
 *
 * A `books` row exists for copyrighted titles too (cover, author, year),
 * with is_pd = false and no public edition. That is what lets the
 * catalog look complete without hosting a single copyrighted word.
 * ------------------------------------------------------------------ */

export const books = pgTable(
  'books',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    author: text('author').notNull(),
    /** Display string, not a date: "c. 65", "1776". */
    yearWritten: text('year_written'),
    category: text('category'),
    /** Per-book accent colour, from the design. */
    color: text('color'),
    openlibraryKey: text('openlibrary_key'),
    /** Hotlinked from Open Library's CDN — never copied into local storage. */
    coverUrl: text('cover_url'),
    /**
     * Drives the UI fork: one-click add vs "needs your EPUB or PDF".
     *
     * Means "we can supply the text", not "is out of copyright". Seneca's
     * Letters are public domain but absent from Gutenberg, so they sit on the
     * upload-your-own path — availability is what the user can act on.
     */
    isPd: boolean('is_pd').notNull().default(false),
    /**
     * Gutenberg text id, present iff we can supply the text.
     *
     * Lives on the BOOK rather than only on an edition so the public edition
     * can be created lazily, when the first user adds the book. Seeding 15
     * editions up front would queue hours of CPU for books nobody asked for.
     */
    gutenbergId: integer('gutenberg_id'),
    olData: jsonb('ol_data'),
    olFetchedAt: timestamp('ol_fetched_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('books_title_idx').on(t.title),
    index('books_author_idx').on(t.author),
    uniqueIndex('books_gutenberg_id').on(t.gutenbergId).where(sql`${t.gutenbergId} IS NOT NULL`),
  ],
)

/* ------------------------------------------------------------------ *
 * Editions — the unit of vectors, and the unit of access control.
 *
 *   public   one per book, shared by everyone, PD text from Gutenberg
 *   private  one per USER, their own upload, never shared or deduped
 * ------------------------------------------------------------------ */

export const editions = pgTable(
  'editions',
  {
    id: text('id').primaryKey(),
    bookId: text('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'public' | 'private'>().notNull(),
    /** NULL iff public. Enforced by the owner_iff_private check below. */
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),

    lang: text('lang').notNull().default('en'),
    translator: text('translator'),
    year: text('year'),
    /** 'gutenberg' | 'upload' */
    source: text('source'),
    /** Gutenberg id, URL, or original filename. */
    sourceRef: text('source_ref'),

    /** sha256 of the NORMALIZED text. Scoped per owner — see unique index. */
    contentHash: text('content_hash'),
    fileFormat: text('file_format').$type<'epub' | 'pdf' | 'txt'>(),
    /** True only when the source has real pagination (PDF, paginated scans). */
    hasPages: boolean('has_pages').notNull().default(false),

    /** Which model produced this edition's vectors. Migration bookkeeping. */
    embedModel: text('embed_model'),
    embedDim: integer('embed_dim'),

    /**
     * 'awaiting_file' is the state a copyrighted book sits in after the user
     * adds it but before they upload their copy — the design's "Needs file".
     * The worker only claims 'pending', so these are never picked up.
     *
     * 'deleting' is a tombstone, not a phase: the owner removed the book while
     * the worker held it. The worker is the only writer of this edition's
     * vectors, so it must be the one to stop and erase them — a deleter that
     * cleaned up underneath it would race the next upsert and leave points
     * behind that nothing could attribute or remove.
     */
    indexStatus: text('index_status')
      .$type<
        'awaiting_file' | 'pending' | 'parsing' | 'embedding' | 'ready' | 'failed' | 'deleting'
      >()
      .notNull()
      .default('pending'),
    /** 0-100, written per embed batch. Feeds the Processing screen. */
    progress: integer('progress').notNull().default(0),
    error: text('error'),
    chunkCount: integer('chunk_count'),
    indexedAt: timestamp('indexed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('owner_iff_private', sql`(${t.kind} = 'private') = (${t.ownerUserId} IS NOT NULL)`),
    check('kind_values', sql`${t.kind} IN ('public','private')`),
    check(
      'index_status_values',
      sql`${t.indexStatus} IN ('awaiting_file','pending','parsing','embedding','ready','failed','deleting')`,
    ),
    // At most one public edition per work.
    uniqueIndex('editions_one_public_per_book')
      .on(t.bookId)
      .where(sql`${t.kind} = 'public'`),
    // Same user uploading the same file twice is caught; different users are not deduped.
    uniqueIndex('editions_private_hash_per_owner')
      .on(t.ownerUserId, t.contentHash)
      .where(sql`${t.kind} = 'private'`),
    index('editions_pending_idx')
      .on(t.indexStatus)
      .where(sql`${t.indexStatus} = 'pending'`),
    index('editions_owner_idx').on(t.ownerUserId),
    // One private edition per user per book: adding a copyrighted book twice
    // must not create two placeholders awaiting the same file.
    uniqueIndex('editions_one_private_per_user_book')
      .on(t.ownerUserId, t.bookId)
      .where(sql`${t.kind} = 'private'`),
  ],
)

/* ------------------------------------------------------------------ *
 * Normalized full text + structure map.
 *
 * Kept for PUBLIC editions so re-chunking is cheap (change chunk size,
 * fix a parser bug) without re-fetching. DROPPED for private editions
 * after chunking — one fewer complete verbatim copy of a copyrighted
 * work on disk. Re-chunking a private edition needs a re-upload.
 * ------------------------------------------------------------------ */

export const editionText = pgTable('edition_text', {
  editionId: text('edition_id')
    .primaryKey()
    .references(() => editions.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  /** [{ chapter, section, start, end, pageStart }] — char offsets into text. */
  structure: jsonb('structure').notNull(),
})

/* ------------------------------------------------------------------ *
 * Chunks — Postgres is authoritative. Qdrant is a derived index that
 * can be dropped and rebuilt from these rows.
 * ------------------------------------------------------------------ */

export const chunks = pgTable(
  'chunks',
  {
    id: text('id').primaryKey(),
    editionId: text('edition_id')
      .notNull()
      .references(() => editions.id, { onDelete: 'cascade' }),
    /** Ordinal within the edition. Drives neighbour lookup and point ids. */
    idx: integer('idx').notNull(),
    text: text('text').notNull(),
    /** "Letter XIII", "Book IV" — the short cite label. */
    chapter: text('chapter'),
    /** "On Groundless Fears" — the drawer's long label. */
    section: text('section'),
    /** Real page number, or null for EPUB/txt. */
    page: integer('page'),
    /** 0-1 fallback locator when page is null. */
    posPct: real('pos_pct').notNull(),
    lang: text('lang').notNull().default('en'),
    tokenCount: integer('token_count').notNull(),
  },
  (t) => [uniqueIndex('chunks_edition_idx').on(t.editionId, t.idx)],
)

/* ------------------------------------------------------------------ *
 * Library — the authz source of truth. allowedEditions() reads this
 * and nothing else.
 * ------------------------------------------------------------------ */

export const userLibrary = pgTable(
  'user_library',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    editionId: text('edition_id')
      .notNull()
      .references(() => editions.id, { onDelete: 'cascade' }),
    status: text('status').$type<'ready' | 'needs_file'>().notNull(),
    /** User can keep a book but exclude it from searches. */
    selected: boolean('selected').notNull().default(true),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.editionId] }),
    check('library_status_values', sql`${t.status} IN ('ready','needs_file')`),
    index('user_library_selected_idx')
      .on(t.userId)
      .where(sql`${t.selected}`),
  ],
)

/* ------------------------------------------------------------------ *
 * Reveal log — structural cap on how much of one edition a user can
 * ever see through citations and passage expansion. The Google Books
 * limit, as a counter rather than a prompt instruction.
 * ------------------------------------------------------------------ */

export const revealLog = pgTable(
  'reveal_log',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    editionId: text('edition_id')
      .notNull()
      .references(() => editions.id, { onDelete: 'cascade' }),
    chunkIdx: integer('chunk_idx').notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.editionId, t.chunkIdx] })],
)

/* ------------------------------------------------------------------ *
 * Chat
 * ------------------------------------------------------------------ */

export const chatSessions = pgTable(
  'chat_sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('chat_sessions_user_idx').on(t.userId, t.updatedAt)],
)

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => chatSessions.id, { onDelete: 'cascade' }),
    role: text('role').$type<'user' | 'assistant'>().notNull(),
    content: text('content').notNull(),
    /**
     * Resolved citation objects, keyed by marker id ("c1" -> {...}).
     * Required, not optional: reopening an old chat must render the
     * original chips rather than re-running retrieval — which would
     * drift, or break once the user removes that book.
     */
    citations: jsonb('citations').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('chat_messages_session_idx').on(t.sessionId, t.createdAt)],
)

/* ------------------------------------------------------------------ *
 * User preferences (Settings screen)
 * ------------------------------------------------------------------ */

export const userPrefs = pgTable('user_prefs', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** "Quote exact passages" — design default on. */
  quoteExact: boolean('quote_exact').notNull().default(true),
  /** Onboarding step 1 answers, for suggestion seeding. */
  reasons: jsonb('reasons').notNull().default(sql`'[]'::jsonb`),
})

/* ------------------------------------------------------------------ *
 * App settings — the handful of knobs the admin panel can change at
 * runtime. Anything that would invalidate the index (embedding model,
 * collection, dimensions) is deliberately NOT here: those live in env
 * and changing one means re-embedding every chunk.
 * ------------------------------------------------------------------ */

export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
