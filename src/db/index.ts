import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

import { env } from '@/lib/env'
import * as schema from './schema'

// Single pool per process. In dev, Next's module reloading would otherwise
// leak a pool per edit until Postgres refuses connections.
const globalForDb = globalThis as unknown as { __pool?: Pool }

const pool =
  globalForDb.__pool ??
  new Pool({
    connectionString: env.databaseUrl,
    max: 10,
  })

if (process.env.NODE_ENV !== 'production') globalForDb.__pool = pool

export const db = drizzle(pool, { schema })
export { schema }
export * from './schema'
