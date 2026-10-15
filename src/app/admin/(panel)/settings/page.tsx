import { revalidatePath } from 'next/cache'

import { getSettings, readOnlyConfig, setSetting, systemStatus } from '@/lib/admin/data'
import { requireAdmin } from '@/lib/admin/session'

export default async function AdminSettingsPage() {
  const [status, settings] = await Promise.all([systemStatus(), getSettings()])

  async function save(formData: FormData) {
    'use server'
    await requireAdmin()
    await setSetting('allow_registration', formData.get('allow_registration') ? 'true' : 'false')

    const mb = Number(formData.get('max_upload_mb'))
    if (Number.isFinite(mb) && mb > 0 && mb <= 2000) {
      await setSetting('max_upload_mb', String(Math.round(mb)))
    }
    revalidatePath('/admin/settings')
  }

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-8 px-5 py-7">
      <h1 className="m-0 text-[clamp(24px,3.5vw,32px)]">Settings</h1>

      <section className="flex flex-col gap-3">
        <h2 className="eyebrow m-0">Services</h2>
        <div className="grid gap-2 sm:grid-cols-3">
          <Health
            name="Postgres"
            ok={status.postgres.ok}
            detail={`${status.postgres.users} users · ${status.postgres.chunks.toLocaleString()} passages`}
          />
          <Health
            name="Qdrant"
            ok={status.qdrant.ok}
            detail={
              status.qdrant.ok
                ? `${status.qdrant.points.toLocaleString()} points`
                : (status.qdrant.error ?? 'unreachable')
            }
          />
          <Health
            name="Ollama"
            ok={status.ollama.ok}
            detail={status.ollama.ok ? status.ollama.model : (status.ollama.error ?? 'unreachable')}
          />
        </div>

        {status.indexing > 0 ? (
          <p className="m-0 rounded-md border border-warn-fg/20 bg-warn-bg p-3 text-[13px] text-warn-fg">
            {status.indexing} edition(s) indexing. Row and vector counts will not agree until that
            finishes.
          </p>
        ) : status.drift === null ? null : status.drift === 0 ? (
          <p className="m-0 rounded-md border border-ok-fg/20 bg-ok-bg p-3 text-[13px] text-ok-fg">
            Index consistent with Postgres — {status.postgres.chunks.toLocaleString()} passages,{' '}
            {status.qdrant.points.toLocaleString()} vectors.
          </p>
        ) : (
          <p className="m-0 rounded-md border border-accent/25 bg-accent-soft p-3 text-[13px] leading-relaxed text-accent">
            <b>Drift of {Math.abs(status.drift).toLocaleString()}</b> between chunk rows and
            vectors. Postgres is the source of truth; rebuild with{' '}
            <code>pnpm reindex --all --drop</code>, or inspect with <code>pnpm verify:index</code>.
          </p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="eyebrow m-0">General</h2>
        <form action={save} className="flex flex-col gap-4 rounded-md border border-line bg-surface p-4">
          <label className="flex cursor-pointer items-start gap-2.5 text-sm">
            <input
              type="checkbox"
              name="allow_registration"
              defaultChecked={settings.allow_registration === 'true'}
              className="mt-0.5 accent-[var(--color-accent)]"
            />
            <span>
              <b>Allow new accounts</b>
              <span className="mt-0.5 block text-[12.5px] leading-relaxed text-muted">
                When off, the sign-up form is refused. Existing users keep working. Worth turning
                off on a homelab instance reachable from the internet.
              </span>
            </span>
          </label>

          <label className="flex flex-col gap-1.5 text-sm font-semibold">
            Maximum upload size (MB)
            <input
              name="max_upload_mb"
              type="number"
              min={1}
              max={2000}
              defaultValue={settings.max_upload_mb}
              className="h-11 w-40 rounded-md border border-line-input bg-paper px-3 text-[15px] font-normal outline-none focus:border-accent"
            />
          </label>

          <button
            type="submit"
            className="h-10 self-start rounded-md bg-ink px-4 text-sm font-semibold text-surface transition-colors hover:bg-accent"
          >
            Save
          </button>
        </form>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="eyebrow m-0">Fixed configuration</h2>
        <p className="m-0 text-[13px] leading-relaxed text-muted">
          Set in <code>.env.local</code>, not here. The embedding values in particular are not a
          preference: the Qdrant collection is named after the model, and changing it means
          re-embedding every passage in the system.
        </p>
        <div className="scroll-x rounded-md border border-line bg-surface">
          <table className="w-full border-collapse text-[13px]">
            <tbody>
              {readOnlyConfig().map(([label, value, note]) => (
                <tr key={label} className="border-b border-line last:border-0">
                  <td className="whitespace-nowrap px-3 py-2.5 font-semibold">{label}</td>
                  <td className="px-3 py-2.5 font-mono text-[12.5px]">{value}</td>
                  <td className="px-3 py-2.5 text-[12px] text-faint">{note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function Health({ name, ok, detail }: { name: string; ok: boolean; detail: string }) {
  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={`h-2 w-2 rounded-full ${ok ? 'bg-ok-fg' : 'bg-accent'}`}
        />
        <span className="text-sm font-semibold">{name}</span>
      </div>
      <div className="mt-0.5 text-[12px] text-muted-2">{detail}</div>
    </div>
  )
}
