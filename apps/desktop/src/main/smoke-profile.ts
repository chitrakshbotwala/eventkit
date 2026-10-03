import { app } from 'electron';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// CI test runs (EVENTKIT_SMOKE_TEST, see smoke.ts; EVENTKIT_SETUP_TEST, see setup-test.ts)
// use a throwaway profile, so they never see or lock an attendee's sign-in and setup state.
// This module is imported first in index.ts: other modules read the profile while they load.
if (process.env['EVENTKIT_SMOKE_TEST'] || process.env['EVENTKIT_SETUP_TEST']) {
  app.setPath('userData', mkdtempSync(join(tmpdir(), 'eventkit-smoke-')));
}
