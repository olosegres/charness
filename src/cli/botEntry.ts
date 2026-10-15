#!/usr/bin/env node

import { applyDnsFix } from './applyDnsFix';
import { runBot } from './bot';

applyDnsFix();

// The nodemon-restarted worker of `charness hot`: its supervisor (maybe pre-rename code) and the running
// agents hold paths in DATA_DIR, so a worker reload never migrates the legacy names.
runBot({ isHotWorker: true }).catch((error) => {
  console.error(error);
  process.exit(1);
});
