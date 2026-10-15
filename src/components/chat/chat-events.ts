/**
 * A nudge from the chat view to the sidebar.
 *
 * They are siblings in the layout with no shared state, and threading a
 * callback through a server-component layout is not possible. A window event
 * is the smallest thing that makes "Recent" update the moment a turn starts or
 * finishes, rather than on the next full page load.
 */
export const CHAT_UPDATED = 'librarian:chat-updated'

export function notifyChatUpdated(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(CHAT_UPDATED))
}
