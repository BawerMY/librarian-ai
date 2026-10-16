/**
 * A nudge from the chat view to the sidebar.
 *
 * They are siblings in the layout with no shared state, and threading a
 * callback through a server-component layout is not possible. A window event
 * is the smallest thing that makes "Recent" update the moment a turn starts or
 * finishes, rather than on the next full page load.
 */
export const CHAT_UPDATED = 'librarian:chat-updated'

/**
 * The chat the user just started, before the server knows about it.
 *
 * The session row is created inside POST /api/chat, so refetching the list at
 * the moment of asking returned a list without the new chat — it only appeared
 * on a later poll, up to twenty seconds of your own question missing from the
 * history beside it. Carrying id and title on the event lets the sidebar show
 * the entry immediately and drop it again once the server list contains it.
 */
export type StartedChat = { id: string; title: string }

export function notifyChatUpdated(started?: StartedChat): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<StartedChat | undefined>(CHAT_UPDATED, { detail: started }))
}
