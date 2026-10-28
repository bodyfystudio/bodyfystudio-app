import assert from 'node:assert/strict';
import {RECOVERY_WINDOW_MS,isRecoverable} from '../retention.js';
const start=Date.parse('2026-10-29T06:00:00Z');
assert.equal(RECOVERY_WINDOW_MS,172800000);
assert.equal(isRecoverable(start,start+RECOVERY_WINDOW_MS-1),true);
assert.equal(isRecoverable(start,start+RECOVERY_WINDOW_MS),false);
assert.equal(isRecoverable(new Date(start).toISOString(),start+RECOVERY_WINDOW_MS+1),false);
assert.equal(isRecoverable(null,start),false);assert.equal(isRecoverable('invalid',start),false);
console.log('PASS: the recovery deadline is exactly 48 hours; invalid/expired timestamps cannot restore.');
