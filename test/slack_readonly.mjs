import path from 'node:path';
import assert from 'node:assert/strict';
import { Harness } from './harness.mjs';
import { testApp } from './paths.mjs';
const profile = path.resolve(process.argv[2] ?? 'profiles/slack-desktop');
const h = new Harness(testApp('Slack'), { profile });
const qa = (value) => `[data-qa="${value}"]`;
const visibleDialogs = `[...document.querySelectorAll('[role="dialog"]')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.height&&getComputedStyle(e).visibility!=='hidden';}).length`;
try {
  await h.step('signed-in workspace renders with original Slack preload and backend', async () => {
    await h.start();
    await h.wait(
      async () =>
        h.frame &&
        (await h.evaluate(`!!document.querySelector('.p-client_container,.p-workspace')`)),
      'signed-in Slack',
      100000,
    );
    h.hidden();
    assert(await h.evaluate(`!!document.querySelector(${JSON.stringify(qa('top_nav_search'))})`));
  });
  await h.step('DMs navigation and return to Home', async () => {
    await h.click(qa('tab_rail_dms_button'));
    await h.wait(
      async () =>
        await h.evaluate(
          `document.querySelector(${JSON.stringify(qa('tab_rail_dms_button'))}).getAttribute('aria-selected')==='true'`,
        ),
      'DMs tab',
    );
    await h.click(qa('tab_rail_home_button'));
    await h.wait(
      async () =>
        await h.evaluate(
          `document.querySelector(${JSON.stringify(qa('tab_rail_home_button'))}).getAttribute('aria-selected')==='true'`,
        ),
      'Home tab',
    );
  });
  await h.step('global search is focused safely before typing or Return', async () => {
    await h.click(qa('top_nav_search'));
    if (await h.evaluate(`!!document.querySelector('[data-qa=coachmark-close-button]')`))
      await h.click('[data-qa=coachmark-close-button]');
    await h.click('[role=combobox][contenteditable=true]');
    await h.wait(
      async () =>
        await h.evaluate(
          `(()=>{const e=document.activeElement;return e&&e.matches('input,[contenteditable=true]')&&(e.getAttribute('role')==='combobox'||/search/i.test(e.className+' '+e.getAttribute('aria-label')+' '+e.dataset.qa))&&!e.closest('[data-qa=message_input],.p-message_pane__input');})()`,
        ),
      'focused search field',
    );
    const focused = await h.evaluate(
      `({tag:document.activeElement.tagName,role:document.activeElement.getAttribute('role'),qa:document.activeElement.dataset.qa})`,
    );
    console.log('Verified search focus', JSON.stringify(focused));
    h.paste('terminal');
    await h.wait(
      async () =>
        await h.evaluate(
          `(()=>{const e=document.activeElement;return(e.value??e.textContent).includes('terminal')&&e.matches('[role=combobox][contenteditable=true]')&&e.getBoundingClientRect().top<150;})()`,
        ),
      'search query',
    );
    // Return is allowed only in the positively identified search field.
    h.key(13);
    await h.wait(
      async () =>
        await h.evaluate(
          `location.pathname.includes('/search')||!!document.querySelector('.p-search_workspace,.p-search_results,.p-search_results__container,[data-qa=search_results],.p-search_results__search_results')`,
        ),
      'search results',
    );
  });
  await h.step('return through history and open/cancel quick switcher', async () => {
    await h.click(qa('history_back_button'));
    h.key(107, 8);
    await h.wait(
      async () =>
        await h.evaluate(
          `!!document.querySelector('[role=dialog] input,[role=dialog] [role=combobox],.p-quick_switcher')`,
        ),
      'quick switcher',
    );
    h.key(27);
  });
  await h.step(
    'multiple viewport resizes retain signed-in UI and hidden native window',
    async () => {
      await h.resize(1200, 800);
      await h.resize(900, 650);
      await h.resize(1000, 700);
      h.hidden();
      assert(await h.evaluate(`!!document.querySelector('.p-client_container,.p-workspace')`));
    },
  );
  await h.step('channel details opens read-only and closes with Escape', async () => {
    const baseline = await h.evaluate(visibleDialogs);
    await h.click(qa('channel_name_button'));
    await h.wait(
      async () => await h.evaluate(`(${visibleDialogs})>${baseline}`),
      'channel details',
    );
    h.key(27);
    await h.wait(
      async () => await h.evaluate(`(${visibleDialogs})===${baseline}`),
      'close details',
    );
  });
  await h.step('Files view and Home navigation remain read-only', async () => {
    await h.click(qa('tab_rail_files_button'));
    await h.wait(
      async () =>
        await h.evaluate(
          `document.querySelector(${JSON.stringify(qa('tab_rail_files_button'))}).getAttribute('aria-selected')==='true'`,
        ),
      'Files view',
    );
    await h.click(qa('tab_rail_home_button'));
    await h.wait(
      async () =>
        await h.evaluate(
          `document.querySelector(${JSON.stringify(qa('tab_rail_home_button'))}).getAttribute('aria-selected')==='true'`,
        ),
      'Home view',
    );
  });
  await h.step('clean shutdown without composing or sending', () => h.quit());
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  h.save('proof/slack-readonly');
  await h.stop();
}
