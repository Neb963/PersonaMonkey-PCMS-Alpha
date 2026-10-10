/** P405: consumes P205 verified file codec plus P405 Core-owned ports. */
import { createBackupRestore } from './restore.mjs';

export function createBackupIntegration({exporter, decodeFile, downloads, authority = null} = {}) {
  if (typeof exporter?.exportBackup !== 'function' || typeof downloads?.downloadFile !== 'function' || typeof downloads?.maintain !== 'function' || typeof downloads?.status !== 'function') throw new TypeError('Backup integration requires P205 exporter and durable download service');
  const restore = createBackupRestore({exporter,decodeFile,authority});
  return Object.freeze({
    /** No raw archive or secret-bearing data is ever returned to the UI. */
    async exportToDownloads(input) {
      const {file,inventory} = await exporter.exportBackup(input);
      const download = await downloads.downloadFile(file);
      return Object.freeze({encrypted:false,downloadId:download.id,filename:download.filename,status:download.status,
        unavailable:inventory.filter(x=>x.availability==='UNAVAILABLE').map(x=>({item:x.item,reason:x.reason}))});
    },
    stageRestore:restore.stage,
    applyRestore:restore.apply,
    reconcileRestore:restore.resumeReconciliation,
    restoreAvailable:restore.supported,
    downloads: Object.freeze({maintain:downloads.maintain,status:downloads.status})
  });
}