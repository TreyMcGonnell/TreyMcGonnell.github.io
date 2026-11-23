// Home page behaviour against the mock API: tests E1–E7, plus the kill switch and version fallback.
import { botText, expect, scenario, stats, test } from './helpers';

const ANSWER = 'Sample answer: Trey built a sample tool.';

test('E1 landing: the replay is playing within 1.5 s and exactly one warm-up request is sent', async ({ page }) => {
  await scenario(page);
  const t0 = Date.now();
  await page.goto('/');
  await expect(page.locator('#replay-bar')).toBeVisible({ timeout: 1500 });
  expect(Date.now() - t0).toBeLessThan(1500 + 500);
  const first = await page.locator('#replay-bar .time').textContent();
  await page.waitForTimeout(1200);
  expect(await page.locator('#replay-bar .time').textContent()).not.toBe(first);
  await page.waitForTimeout(1500);
  expect((await stats(page)).warm).toBe(1);
  await expect(page.locator('#term-status')).toHaveText('Ready');
});

test('E2 ask via chip: thinking, writing, done; answer in the chat; source link opens the project page', async ({ page }) => {
  await scenario(page);
  await page.goto('/');
  await expect(page.locator('#term-status')).toHaveText('Ready');
  await page.locator('#term-chips button', { hasText: 'What has Trey built?' }).click();
  await expect(page.locator('#stage-title')).toHaveText('Getting ready to answer');
  await expect(page.locator('#stage-title')).toHaveText('Choosing the next word', { timeout: 5000 });
  await expect(page.locator('#stage-title')).toHaveText('How it wrote that answer', { timeout: 10000 });
  await expect(botText(page)).toHaveText(ANSWER);
  await expect(page.locator('#answer-live')).toHaveText(ANSWER);
  const link = page.locator('.note-row a', { hasText: 'Open the project page' });
  await expect(link).toHaveAttribute('href', '/projects/sample/');
  await link.click();
  await expect(page).toHaveURL(/\/projects\/sample\/$/);
  await expect(page.locator('h1')).toHaveText('Sample project');
});

test('E3 typing: token chips update, at most one tokenize request per 250 ms', async ({ page }) => {
  await scenario(page);
  await page.goto('/');
  await page.locator('#chat-input').pressSequentially('What has Trey built', { delay: 60 });
  await expect(page.locator('#stage-title')).toHaveText('Reading your question');
  await expect(page.locator('.tok-big .tok').first()).toHaveText('What');
  await page.locator('#chat-input').pressSequentially(' lately', { delay: 300 });
  await page.waitForTimeout(400);
  await expect(page.locator('.tok-big .tok')).toHaveCount(5); // What · has · Trey · built · lately
  const times = (await stats(page)).tokenize;
  expect(times.length).toBeGreaterThan(0);
  for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(240);
  await expect(page.locator('#chat-count')).toContainText('/ 300');
});

test('E4 cold ask: the waking timer shows, then the answer arrives', async ({ page }) => {
  test.setTimeout(60_000);
  await scenario(page, { readyAfterMs: 20_000 });
  await page.goto('/');
  await expect(page.locator('#term-status')).toContainText('Waking up');
  await page.locator('#chat-input').fill('What is Trey studying?');
  await page.locator('#chat-input').press('Enter');
  await expect(page.locator('.steps h3', { hasText: 'Waking the model' })).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.msg-note')).toContainText('Waking the model');
  await expect(botText(page)).toHaveText(ANSWER, { timeout: 30_000 });
  await expect(page.locator('#term-status')).toHaveText('Ready');
});

test('E5 stop: aborts the stream within 300 ms and re-enables the input', async ({ page }) => {
  await scenario(page, { tokenDelayMs: 500 });
  await page.goto('/');
  await expect(page.locator('#term-status')).toHaveText('Ready');
  await page.locator('#chat-input').fill('What has Trey built?');
  await page.locator('#chat-input').press('Enter');
  await expect(page.locator('#chat-stop')).toBeVisible();
  await expect(page.locator('#chat-input')).toBeDisabled();
  await expect(botText(page)).not.toBeEmpty({ timeout: 5000 });
  const t0 = Date.now();
  await page.locator('#chat-stop').click();
  await expect(page.locator('#chat-input')).toBeEnabled({ timeout: 300 });
  expect(Date.now() - t0).toBeLessThan(300 + 150);
  await expect(page.locator('#chat-stop')).toBeHidden();
  await expect(page.locator('.msg-note')).toHaveText('Stopped.');
});

test('E5 Esc stops too', async ({ page }) => {
  await scenario(page, { tokenDelayMs: 500 });
  await page.goto('/');
  await expect(page.locator('#term-status')).toHaveText('Ready');
  await page.locator('#chat-input').fill('What has Trey built?');
  await page.locator('#chat-input').press('Enter');
  await expect(botText(page)).not.toBeEmpty({ timeout: 5000 });
  await page.keyboard.press('Escape');
  await expect(page.locator('#chat-input')).toBeEnabled({ timeout: 300 });
});

test('E6 503: offline message, then the replay plays', async ({ page }) => {
  await scenario(page, { chatStatus: 503 });
  await page.goto('/');
  await expect(page.locator('#term-status')).toHaveText('Ready');
  await page.locator('#chat-input').fill('What has Trey built?');
  await page.locator('#chat-input').press('Enter');
  await expect(page.locator('.msg-error')).toContainText("Here's a recorded answer instead");
  await expect(page.locator('#replay-bar')).toBeVisible();
});

test('E6 server error: the model is offline message, then the replay', async ({ page }) => {
  await scenario(page, { chatStatus: 500 });
  await page.goto('/');
  await expect(page.locator('#term-status')).toHaveText('Ready');
  await page.locator('#chat-input').fill('What has Trey built?');
  await page.locator('#chat-input').press('Enter');
  await expect(page.locator('.msg-error')).toContainText('The model is offline right now');
  await expect(page.locator('#replay-bar')).toBeVisible();
});

test('E6 429: says how many minutes to wait', async ({ page }) => {
  await scenario(page, { chatStatus: 429 });
  await page.goto('/');
  await page.locator('#chat-input').fill('What has Trey built?');
  await page.locator('#chat-input').press('Enter');
  await expect(page.locator('.msg-error')).toContainText('Try again in 7 minutes');
  await expect(page.locator('.stage-error')).toContainText('Try again in 7 minutes');
});

test('E6 mid-stream error: keeps the partial answer and offers Retry', async ({ page }) => {
  await scenario(page, { failAfter: 3 });
  await page.goto('/');
  await expect(page.locator('#term-status')).toHaveText('Ready');
  await page.locator('#chat-input').fill('What has Trey built?');
  await page.locator('#chat-input').press('Enter');
  const retry = page.locator('.msg-error button', { hasText: 'Retry' });
  await expect(retry).toBeVisible({ timeout: 5000 });
  await expect(botText(page)).toHaveText('Sample answer:');
  await scenario(page);
  await retry.click();
  await expect(botText(page)).toHaveText(ANSWER, { timeout: 10_000 });
});

test('E6 model offline: status says Offline and asking plays the replay', async ({ page }) => {
  await scenario(page, { healthDown: true });
  await page.goto('/');
  await expect(page.locator('#term-status')).toHaveText('Offline');
  await page.locator('#chat-input').fill('What has Trey built?');
  await page.locator('#chat-input').press('Enter');
  await expect(page.locator('.msg-error')).toContainText('The model is offline right now');
  await expect(page.locator('#replay-bar')).toBeVisible();
});

test('E7 done: clicking a word scrubs the stage; the toggle switches modes', async ({ page }) => {
  await scenario(page);
  await page.goto('/');
  await expect(page.locator('#term-status')).toHaveText('Ready');
  await page.locator('#chat-input').fill('What has Trey built?');
  await page.locator('#chat-input').press('Enter');
  await expect(page.locator('#stage-title')).toHaveText('How it wrote that answer', { timeout: 10000 });
  await page.locator('.done-chip').nth(4).click();
  await expect(page.locator('.done-chip').nth(4)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.card h3').first()).toContainText('Word 5');
  await page.locator('.msg-bot .w').nth(1).click();
  await expect(page.locator('.card h3').first()).toContainText('Word 2');
  const where = page.locator('.toggle button', { hasText: 'Where it looked' });
  await where.click();
  await expect(where).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.legend-row')).toContainText('sample.md');
});

test('J4 kill switch: chat disabled means replay-only with the input off', async ({ page }) => {
  await scenario(page, { chatEnabled: false });
  await page.goto('/');
  await expect(page.locator('#term-status')).toHaveText('Replay only');
  await expect(page.locator('#chat-input')).toBeDisabled();
  await expect(page.locator('#replay-bar')).toBeVisible();
});

test('B1 a frontend/backend version mismatch falls back to the replay', async ({ page }) => {
  await scenario(page, { schemaV: 2 });
  await page.goto('/');
  await expect(page.locator('#term-status')).toHaveText('Replay only');
  await expect(page.locator('#replay-bar')).toBeVisible();
});

test('D2 replay ends with "Your turn" and can play again', async ({ page }) => {
  await scenario(page);
  await page.goto('/');
  await expect(page.locator('#replay-bar .narration')).toContainText('Your turn', { timeout: 25_000 });
  await page.locator('[data-action="toggle-replay"]').click();
  await expect(page.locator('#replay-bar .narration')).not.toContainText('Your turn');
});

test('Show as text gives a readable summary', async ({ page }) => {
  await scenario(page);
  await page.goto('/');
  await page.locator('#text-toggle').click();
  await expect(page.locator('#stage-text')).toBeVisible();
  await expect(page.locator('#stage-text')).toContainText('Question: What is Trey studying?');
});
