import { runDbContract } from './dbContract';
import { createMemoryDb } from './memoryDb';

runDbContract('memory (jsdom)', async () => {
  const db = createMemoryDb();
  return { db, plantOrphan: async (draftKey, assetId, blob) => db.plantOrphan(draftKey, assetId, blob) };
});
