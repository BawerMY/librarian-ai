/**
 * Apply generated migrations.
 *
 *   pnpm db:generate   # schema.ts -> drizzle/*.sql  (review the diff)
 *   pnpm db:migrate    # apply
 *
 * Versioned migrations rather than `drizzle-kit push`: the schema carries
 * partial unique indexes and CHECK constraints that encode product rules
 * (one public edition per book; owner set iff private). Those are worth
 * seeing in a reviewable diff before they reach a database, and they have to
 * replay identically when this moves to the homelab.
 */
import { config } from 'dotenv'

config({ path: '.env.local', quiet: true })

async function main() {
  const { migrate } = await import('drizzle-orm/node-postgres/migrator')
  const { db } = await import('@/db')

  await migrate(db, { migrationsFolder: './drizzle' })
  console.log('migrations applied')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
