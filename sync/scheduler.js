const config = require('../config');
const queue = require('../db/queue');
const templates = require('../qbxml/templates');
const log = require('../db/log');

/**
 * Queue background sync requests based on the current cycle number.
 * Called during authenticate() when QBWC connects with valid credentials.
 *
 * - Inventory sync: every `inventoryEveryN` cycles (default 1 = every cycle)
 * - Customer sync: every `customerEveryN` cycles (default 5 = every 5th cycle)
 *
 * Uses PRIORITY.BACKGROUND (10) so user-initiated requests always go first.
 * Skips queuing if matching background requests are already pending.
 */
function queueBackgroundSyncs(cycle) {
  let queued = 0;

  // Inventory sync
  if (cycle % config.sync.inventoryEveryN === 0) {
    if (!hasPendingOfType('ItemInventoryQuery')) {
      const qbxml = templates.buildItemInventoryQuery({
        activeStatus: 'ActiveOnly',
        maxReturned: 5000,
      });

      queue.addToQueue({
        type: 'ItemInventoryQuery',
        qbxml,
        priority: queue.PRIORITY.BACKGROUND,
        metadata: { trigger: 'scheduler', cycle },
      });

      queued++;
      console.log(`[SCHEDULER] Queued inventory sync (cycle ${cycle})`);
    } else {
      console.log(`[SCHEDULER] Inventory sync skipped — already pending (cycle ${cycle})`);
    }
  }

  // Customer sync
  if (cycle % config.sync.customerEveryN === 0) {
    if (!hasPendingOfType('CustomerQuery')) {
      const qbxml = templates.buildCustomerQuery({
        activeStatus: 'ActiveOnly',
        maxReturned: 5000,
      });

      queue.addToQueue({
        type: 'CustomerQuery',
        qbxml,
        priority: queue.PRIORITY.BACKGROUND,
        metadata: { trigger: 'scheduler', cycle },
      });

      queued++;
      console.log(`[SCHEDULER] Queued customer sync (cycle ${cycle})`);
    } else {
      console.log(`[SCHEDULER] Customer sync skipped — already pending (cycle ${cycle})`);
    }
  }

  if (queued > 0) {
    log.logEvent({
      event: 'scheduler',
      detail: { cycle, queued },
    });
  }

  return queued;
}

/**
 * Check if there's already a pending background request of the given type.
 * Prevents duplicate syncs from stacking up if QBWC reconnects quickly.
 */
function hasPendingOfType(type) {
  const { getDb } = require('../db/schema');
  const db = getDb();

  const row = db.prepare(`
    SELECT COUNT(*) as count FROM request_queue
    WHERE type = ? AND status = 'pending' AND priority = ?
  `).get(type, queue.PRIORITY.BACKGROUND);

  return row.count > 0;
}

module.exports = { queueBackgroundSyncs };
