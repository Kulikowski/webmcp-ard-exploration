import { test, expect } from '@playwright/test';
import { installWebMcpStub } from './webmcp-stub';

test('the deterministic manual walkthrough ships Forge Titan end to end', async ({ page }) => {
  await installWebMcpStub(page);
  await page.goto('/?autotest&mode=catalog-skill');
  await expect(page).toHaveTitle(/AUTOTEST (PASS|FAIL)/, { timeout: 20_000 });
  await expect(page).toHaveTitle(/AUTOTEST PASS/);
});

test('reserve_part/release_part/remove_module round-trip correctly', async ({ page }) => {
  await installWebMcpStub(page);
  // Static mode registers every tool from the start, so the rollback tools
  // (release_part, remove_module) are reachable without waiting on dynamic
  // re-registration between manual-walkthrough steps.
  await page.goto('/?mode=static');
  await page.waitForFunction(() => Boolean(window.document.modelContext));

  const call = (name: string, args: Record<string, unknown> = {}) =>
    page.evaluate(
      async ([name, args]) => {
        const mc = document.modelContext!;
        const tools = await mc.getTools();
        const tool = tools.find((t) => t.name === name)!;
        const raw = await mc.executeTool(tool, JSON.stringify(args));
        try {
          return JSON.parse(raw as string);
        } catch {
          return raw;
        }
      },
      [name, args] as const,
    );

  async function clickManualNextAndWait() {
    await page.click('#manualNext');
    await page.waitForFunction(
      () => document.querySelector('#manualNext')?.getAttribute('aria-busy') !== 'true',
    );
  }

  // Drives the real manual walkthrough (real supplier MCP order) through a
  // successful reservation before testing the rollback tools against it.
  await clickManualNextAndWait(); // list_parts
  await clickManualNextAndWait(); // reserve_part, including the supplier order + poll

  const reserved = await call('check_stock');
  expect(reserved.stock).toEqual({ Torso: 0, Legs: 1, Arms: 1, Armor: 5, Core: 0, Bracket: 0 });

  const released = await call('release_part');
  expect(released.stock).toEqual({ Torso: 1, Legs: 2, Arms: 2, Armor: 6, Core: 1, Bracket: 1 });
  expect(released.station).toBe('inventory');
  expect(released.step).toBe(1);

  await call('reserve_part');
  await call('mount_torso');
  await call('install_leg_actuators');

  const firstRemoval = await call('remove_module');
  expect(firstRemoval.detached).toBe('install_leg_actuators');
  const secondRemoval = await call('remove_module');
  expect(secondRemoval.detached).toBe('mount_torso');
  expect(secondRemoval.step).toBe(0);

  const thirdRemoval = await call('remove_module');
  expect(thirdRemoval.isError).toBe(true);
  expect(thirdRemoval.content[0].text).toMatch(/nothing installed to detach/);
});
