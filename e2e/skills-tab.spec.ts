import { test, expect } from '@playwright/test';
import { installWebMcpStub } from './webmcp-stub';

async function openSkillsTab(page: import('@playwright/test').Page) {
  await page.click('button[data-tab="skills"]');
}

test('no-skill modes show the "no skill provided" message, not any cards', async ({ page }) => {
  await installWebMcpStub(page);
  for (const mode of ['static', 'dynamic']) {
    await page.goto(`/?mode=${mode}`);
    await openSkillsTab(page);
    await expect(page.locator('.tabbody .empty')).toHaveText(
      /No skill is provided in this experiment mode/,
    );
    await expect(page.locator('.tabbody .tool')).toHaveCount(0);
  }
});

test('catalog modes surface all three catalog skills, not just the assembly one', async ({
  page,
}) => {
  await installWebMcpStub(page);
  for (const mode of ['catalog-skill', 'static+catalog-skill']) {
    await page.goto(`/?mode=${mode}`);
    // Wait for the harness's own catalog read (initializeExperimentMode) to finish
    // before the Skills tab has anything real to render.
    await page.waitForFunction(() => document.querySelector('.tabs button[data-tab="skills"]'));
    await page.waitForTimeout(300);
    await openSkillsTab(page);

    const cards = await page.locator('.tabbody .tool').all();
    expect(cards).toHaveLength(3);

    const names = await page.locator('.tabbody .tool code').allTextContents();
    expect(names).toEqual([
      'Assemble Forge Titan',
      'Maintain the Forge Titan coolant loop',
      'Paint the Forge Titan body',
    ]);

    // Only the assembly skill is ever auto-loaded by this demo's harness -
    // the other two are catalog metadata only, never fetched automatically.
    const statuses = await page.locator('.tabbody .tool .skill-pill').allTextContents();
    expect(statuses[0]).toBe('CATALOG MODE');
    expect(statuses[1]).toBe('ADVERTISED ONLY');
    expect(statuses[2]).toBe('ADVERTISED ONLY');
  }
});

test('inspecting a skill fetches its real content over HTTP, per skill', async ({ page }) => {
  await installWebMcpStub(page);
  await page.goto('/?mode=catalog-skill');
  await page.waitForFunction(() => document.querySelector('.tabs button[data-tab="skills"]'));
  await page.waitForTimeout(300);
  await openSkillsTab(page);

  // The assembly skill: not yet auto-fetched (no agent run happened), so
  // clicking Inspect must do a real fetch, not show empty/cached content.
  await page.click('button[data-inspect-skill*="assemble-forge-titan"]');
  await expect(page.locator('#skillDialog h2')).toHaveText('Assemble Forge Titan');
  await expect(page.locator('#skillDialog pre')).toContainText('name: assemble-forge-titan');
  await expect(page.locator('#skillDialog pre')).toContainText('Reserve the module kit');
  await page.click('#skillDialog .x');

  // A different skill must show genuinely different fetched content, proving
  // this isn't a single cached/bundled copy reused for every card.
  await page.click('button[data-inspect-skill*="coolant"]');
  await expect(page.locator('#skillDialog h2')).toHaveText('Maintain the Forge Titan coolant loop');
  await expect(page.locator('#skillDialog pre')).toContainText(
    'name: maintain-forge-titan-coolant',
  );
  await expect(page.locator('#skillDialog pre')).toContainText('open_maintenance_hatch');
});
