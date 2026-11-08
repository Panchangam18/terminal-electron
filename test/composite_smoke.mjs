import { Harness } from './harness.mjs';
import { testApp } from './paths.mjs';
const h = new Harness(testApp('Composite'));
try {
  await h.step('Composite starts through its bundled runtime', () => h.start());
  await h.step('Composite loads its UI in an offscreen window', async () => {
    await h.wait(
      async () => h.frame && (await h.evaluate('document.body.innerText')).trim().length > 20,
      'loaded UI',
      30000,
    );
    await h.settle();
    h.hidden();
  });
  await h.step('clean shutdown', () => h.quit());
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  h.save('proof/composite');
  await h.stop();
}
