// Entry point: gjs -m tests/run.js
import {run} from './harness.js';
import './timecalc.test.js';
import './store.test.js';
import './tracker.test.js';
import './day.test.js';
import './stats.test.js';
import './dbus.test.js';
import './signatures.test.js';

run();
