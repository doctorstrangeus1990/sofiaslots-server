/**
 * railwayPatch.js
 * Patches Puppeteer's Page prototype to multiply all timeouts by a factor.
 * Import this ONCE at the top of server.js — affects all controllers automatically.
 */

const TIMEOUT_MULTIPLIER = 4; // 10000ms becomes 40000ms, 15000ms becomes 60000ms

const { Page } = require('puppeteer');

const methodsToPath = [
    'waitForFunction',
    'waitForSelector',
    'waitForNavigation',
    'waitForNetworkIdle',
];

methodsToPath.forEach(method => {
    const original = Page.prototype[method];
    Page.prototype[method] = function (...args) {
        // Last arg is options object if it's a plain object
        const lastArg = args[args.length - 1];
        if (lastArg && typeof lastArg === 'object' && !Array.isArray(lastArg)) {
            if (lastArg.timeout !== undefined) {
                lastArg.timeout = lastArg.timeout * TIMEOUT_MULTIPLIER;
            } else {
                // No timeout set — set a generous default
                lastArg.timeout = 60000;
            }
        } else {
            // No options object at all — push one
            args.push({ timeout: 60000 });/**
 * railwayPatch.js
 * Reliable Puppeteer timeout patch for Railway — works with Puppeteer v24+
 * Just require() this at the top of server.js
 */

const TIMEOUT_MULTIPLIER = 4;

try {
    const puppeteerCore = require('puppeteer-core/lib/cjs/puppeteer/api/Page.js');
    const PageClass = puppeteerCore.Page;

    const methods = ['waitForFunction', 'waitForSelector', 'waitForNavigation', 'waitForNetworkIdle'];

    methods.forEach(method => {
        const original = PageClass.prototype[method];
        if (!original) return;

        PageClass.prototype[method] = function (...args) {
            // Find options object (last arg that is a plain object)
            let optsIndex = -1;
            for (let i = args.length - 1; i >= 0; i--) {
                if (args[i] && typeof args[i] === 'object' && !Array.isArray(args[i]) && !(args[i] instanceof Function)) {
                    optsIndex = i;
                    break;
                }
            }

            if (optsIndex >= 0) {
                const opts = args[optsIndex];
                if (typeof opts.timeout === 'number' && opts.timeout > 0) {
                    opts.timeout = opts.timeout * TIMEOUT_MULTIPLIER;
                } else if (opts.timeout === undefined) {
                    opts.timeout = 60000;
                }
            } else {
                // No options object — push one at the end
                args.push({ timeout: 60000 });
            }

            return original.apply(this, args);
        };
    });

    console.log(`✅ Railway Puppeteer patch applied (x${TIMEOUT_MULTIPLIER} timeouts via puppeteer-core)`);

} catch (e) {
    console.warn('⚠️ Railway patch failed (non-fatal):', e.message);
    console.warn('   Controllers will use their original timeouts');
}
        }
        return original.apply(this, args);
    };
});

console.log(`✅ Railway patch applied — all Puppeteer timeouts multiplied by ${TIMEOUT_MULTIPLIER}x`);