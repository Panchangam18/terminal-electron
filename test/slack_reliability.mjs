import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Harness } from './harness.mjs';
import { testApp } from './paths.mjs';
const profile = path.resolve(process.argv[2] ?? 'profiles/slack-desktop');
const results = [];
let identity;
for (let attempt = 1; attempt <= 5; attempt++) {
  const h = new Harness(testApp('Slack'), { profile, frameFormat: 'bgra' });
  const started = Date.now();
  try {
    await h.start();
    await h.wait(
      async () =>
        h.frame &&
        (await h.evaluate(
          `!!document.querySelector('.p-client_container,.p-workspace')&&!!document.querySelector('[data-qa=top_nav_search]')`,
        )),
      'authenticated workspace',
      30000,
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert(await h.evaluate(`!!document.querySelector('[data-qa=top_nav_search]')`));
    for (const tab of ['dms', 'home', 'files', 'home']) {
      const selector = `[data-qa=tab_rail_${tab}_button]`;
      await h.click(selector);
      await h.wait(
        async () =>
          await h.evaluate(
            `document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-selected')==='true'`,
          ),
        tab + ' navigation',
      );
    }
    await h.resize(1100, 760);
    await h.resize(1000, 700);
    h.hidden();
    const binaryHash = createHash('sha256')
      .update(fs.readFileSync(h.session.command.executable))
      .digest('hex');
    identity ??= binaryHash;
    assert.equal(binaryHash, identity);
    await h.quit();
    results.push({
      attempt,
      status: 'pass',
      ms: Date.now() - started,
      frames: h.frames,
      binarySHA256: binaryHash,
      checks: [
        'authenticated workspace persists',
        'DMs/Home/Files navigation',
        'resizing',
        'native windows hidden',
        'unchanged runtime identity',
        'clean shutdown',
      ],
    });
  } catch (error) {
    results.push({
      attempt,
      status: 'fail',
      ms: Date.now() - started,
      frames: h.frames,
      error: error.message,
    });
    process.exitCode = 1;
  } finally {
    await h.stop();
    fs.mkdirSync('proof/slack-reliability', { recursive: true });
    fs.writeFileSync(
      'proof/slack-reliability/restarts.json',
      JSON.stringify(
        {
          profile: 'private terminal-electron profile',
          runtimeHandling: 'generic',
          messagesSent: 0,
          results,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify(results.at(-1)));
  }
  if (process.exitCode) break;
}
