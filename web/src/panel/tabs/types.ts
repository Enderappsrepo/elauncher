import { sendRequest } from '../relay'
import type { RequestAction } from '../relay'
import type { ServerRow } from '../data'

/**
 * The contract every server tab is built against.
 *
 * Tabs are written as independent components that know nothing about each other
 * or about the shell — App.tsx picks which one to render and passes this in.
 * Keeping the surface this small is what lets the tabs be worked on separately
 * without them growing quiet dependencies on one another.
 */
export interface TabProps {
  row: ServerRow
  userId: string
  /** Ask the host something about THIS server. Rejects with a readable message. */
  ask: <T = unknown>(action: RequestAction, params?: Record<string, unknown>) => Promise<T>
}

/** Bind the relay to one server so a tab never has to thread ids around. */
export function makeAsk(row: ServerRow, userId: string): TabProps['ask'] {
  return (action, params = {}) =>
    sendRequest(row.server_id, row.owner_id || userId, userId, action, params)
}
