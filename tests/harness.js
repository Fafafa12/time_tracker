// Minimal test harness for `gjs -m`: test(), eq(), ok(), run().
import System from 'system';

const tests = [];

export function test(name, fn) {
    tests.push({name, fn});
}

export function eq(actual, expected, message = '') {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e)
        throw new Error(`${message} expected ${e}, got ${a}`);
}

export function ok(value, message = 'expected truthy value') {
    if (!value)
        throw new Error(message);
}

export function run() {
    let failed = 0;
    for (const {name, fn} of tests) {
        try {
            fn();
            print(`ok   ${name}`);
        } catch (e) {
            failed++;
            print(`FAIL ${name}\n     ${e.message}`);
        }
    }
    print(`\n${tests.length - failed}/${tests.length} passed`);
    System.exit(failed ? 1 : 0);
}
