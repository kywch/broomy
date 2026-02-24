import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let electronApp: ElectronApplication
let page: Page

test.beforeAll(async () => {
  electronApp = await electron.launch({
    args: [path.join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      E2E_TEST: 'true',
      E2E_HEADLESS: process.env.E2E_HEADLESS ?? 'true',
    },
  })
  page = await electronApp.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForSelector('#root > div', { timeout: 10000 })
  // Wait for terminal to initialize
  await page.waitForTimeout(1500)
})

test.afterAll(async () => {
  if (electronApp) await electronApp.close()
})

// Helper: check if a tab name span has the active underline
async function isTabActive(tabText: string): Promise<boolean> {
  // Active tabs have a span with border-b-2 border-accent
  const span = page.locator(`span.truncate:has-text("${tabText}"):visible`).first()
  const classes = await span.getAttribute('class')
  return classes?.includes('border-accent') ?? false
}

test.describe('Terminal Tabs', () => {
  test('should show Agent tab as active by default', async () => {
    // The Agent tab should be visible
    const agentTab = page.locator('div.cursor-pointer:has-text("Agent"):visible').first()
    await expect(agentTab).toBeVisible()

    // The Agent tab's name span should have the active indicator
    expect(await isTabActive('Agent')).toBe(true)
  })

  test('should show add tab button', async () => {
    const addBtn = page.locator('button[title="New terminal tab"]:visible')
    await expect(addBtn).toBeVisible()
  })

  test('should add a user terminal tab and show shell prompt', async () => {
    const addBtn = page.locator('button[title="New terminal tab"]:visible')
    await addBtn.click()
    await page.waitForTimeout(2000) // Wait for PTY init

    // The new tab should be active (Agent tab should not be active)
    expect(await isTabActive('Agent')).toBe(false)

    // The visible terminal should show the user shell prompt
    const terminalText = await page.evaluate(() => {
      const allRows = document.querySelectorAll('.xterm-rows')
      for (const rows of allRows) {
        const wrapper = rows.closest('.hidden')
        if (!wrapper) return rows.textContent || ''
      }
      return ''
    })
    expect(terminalText).toContain('test-shell$')
  })

  test('should switch back to Agent tab', async () => {
    // Click on Agent tab
    const agentTab = page.locator('div.cursor-pointer:has-text("Agent"):visible').first()
    await agentTab.click()
    await page.waitForTimeout(500)

    // Agent tab should be active
    expect(await isTabActive('Agent')).toBe(true)

    // Terminal should show fake claude output
    const terminalText = await page.evaluate(() => {
      const allRows = document.querySelectorAll('.xterm-rows')
      for (const rows of allRows) {
        const wrapper = rows.closest('.hidden')
        if (!wrapper) return rows.textContent || ''
      }
      return ''
    })
    expect(terminalText).toContain('FAKE_CLAUDE_READY')
  })

  test('should close a user terminal tab', async () => {
    // Find and hover the non-Agent tab to reveal close button
    // The user tab is the one that is NOT "Agent"
    const userTab = page.locator('div.cursor-pointer:visible').filter({ hasNotText: 'Agent' }).filter({ has: page.locator('span.truncate') }).first()
    await userTab.hover()
    await page.waitForTimeout(200)

    // Click the close button
    const closeBtn = userTab.locator('button').first()
    await closeBtn.click()
    await page.waitForTimeout(300)

    // Should fall back to Agent tab (which becomes active)
    expect(await isTabActive('Agent')).toBe(true)
  })
})
