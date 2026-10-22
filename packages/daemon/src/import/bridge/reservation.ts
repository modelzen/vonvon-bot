import {realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {BridgeImportJournalSchema} from './journal';
import {readLocalText} from './bounded-local-files';

/** Runs inside the bots mutex, before registration writes credentials, namespaces, or config. */
export async function assertBridgeImportReservation(root: string, appId: string, txId?: string): Promise<void> {
  // The configured data root is already validated by the registry writer. Normalize OS aliases
  // here too; links BELOW that physical root remain forbidden by readLocalText.
  const physicalRoot = await realpath(root);
  const text = await readLocalText(physicalRoot, join(physicalRoot, 'import/bridge/journal.json'), undefined, 1024 * 1024);
  if (text === undefined) return;
  const journal = BridgeImportJournalSchema.parse(JSON.parse(text));
  if (journal.txId === txId) return;
  if ((journal.outcome === null || journal.cleanupPending) && journal.reservedAppIds.includes(appId)) {
    throw new Error('这个 Bot 正在从 bridge 导入，导入结束后再试');
  }
}
