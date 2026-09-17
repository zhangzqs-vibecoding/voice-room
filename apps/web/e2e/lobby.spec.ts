import { expect, test } from '@playwright/test';

test('移动宽度下保留身份、麦克风和仅收听控件', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByLabel('昵称')).toBeVisible();
  await expect(page.getByLabel('麦克风设备', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '仅收听进入' })).toBeVisible();
});
