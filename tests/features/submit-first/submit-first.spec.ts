/**
 * Feature Documentation: Mid-Turn Message Injection
 *
 * Demonstrates that pressing Enter while the agent is working queues the
 * message immediately — it appears in the feed with a "Queued" badge and
 * is injected into the active SDK session at the next pause point, without
 * requiring the user to stop the agent first.
 *
 * Run with: pnpm test:feature-docs submit-first
 */
import { test, expect, resetApp } from '../_shared/electron-fixture'
import type { Page } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { screenshotElement } from '../_shared/screenshot-helpers'
import { generateFeaturePage, generateIndex, FeatureStep } from '../_shared/template'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FEATURE_DIR = __dirname
const SCREENSHOTS = path.join(FEATURE_DIR, 'screenshots')
const FEATURES_ROOT = path.join(__dirname, '..')

let page: Page
const steps: FeatureStep[] = []

test.beforeAll(async () => {
  await fs.promises.mkdir(SCREENSHOTS, { recursive: true })
  ;({ page } = await resetApp({
    scenario: 'marketing',
    // Delay the mock response so the agent stays "running" long enough for
    // screenshots and the queued message to appear.
    agentResponseDelayMs: 4000,
    agentResponses: [
      { match: 'implement', response: "I'll start by reading the existing code to understand the structure." },
    ],
  }))
})

test.afterAll(async () => {
  await generateFeaturePage(
    {
      title: 'Mid-Turn Message Injection',
      description:
        'Pressing Enter while the agent is working now queues your message immediately. ' +
        'It appears in the chat feed with a pulsing "Queued" badge and is injected into ' +
        'the active session at the next pause point — no need to stop the agent first.',
      steps,
    },
    FEATURE_DIR,
  )
  await generateIndex(FEATURES_ROOT)
})

test.describe.serial('Feature: Mid-Turn Message Injection', () => {
  test('Step 1: Navigate to a Claude session and verify the input is ready', async () => {
    const backendSession = page.locator('.cursor-pointer', { hasText: 'backend-api' }).first()
    await backendSession.click()

    const agentPanel = page.locator('[data-panel-id="agent"]')
    await expect(agentPanel).toBeVisible({ timeout: 10000 })

    const textarea = page.locator('textarea').filter({ visible: true }).first()
    await expect(textarea).toBeVisible({ timeout: 5000 })

    await screenshotElement(page, agentPanel, path.join(SCREENSHOTS, '01-chat-ready.png'))
    steps.push({
      screenshotPath: 'screenshots/01-chat-ready.png',
      caption: 'Agent chat ready to receive input',
      description: 'The agent chat panel is idle and ready. The input box accepts messages.',
    })
  })

  test('Step 2: Type a message — the placeholder hints that mid-turn typing is supported', async () => {
    const agentPanel = page.locator('[data-panel-id="agent"]')
    const textarea = page.locator('textarea').filter({ visible: true }).first()

    await textarea.click()
    await textarea.fill('Please implement the new caching layer')

    await screenshotElement(page, agentPanel, path.join(SCREENSHOTS, '02-typing-message.png'))
    steps.push({
      screenshotPath: 'screenshots/02-typing-message.png',
      caption: 'Typing the first message',
      description: 'The user types a message. Pressing Enter will send it to the agent.',
    })
  })

  test('Step 3: Send first message, then immediately queue a follow-up mid-turn', async () => {
    const agentPanel = page.locator('[data-panel-id="agent"]')
    const textarea = page.locator('textarea').filter({ visible: true }).first()

    // Send the first message — agent enters "running" state
    await textarea.press('Enter')

    // Wait for React to re-render with isRunning=true before typing the queued message.
    // Without this, handleSubmit fires before the running state is reflected and routes
    // to onSubmit (which no-ops) instead of onQueue.
    await expect(agentPanel.locator('text=Working...')).toBeVisible({ timeout: 5000 })

    // Type and queue the follow-up. The textarea stays accessible while the agent runs.
    // Use keyboard.type() rather than fill() so React receives individual keystroke events,
    // which is more reliable after a previous submit cleared the textarea value.
    await textarea.click()
    await page.keyboard.type('Actually, start with the tests first')
    await page.keyboard.press('Enter')

    // Queued message must appear in the feed with the badge
    await expect(agentPanel.getByText('Actually, start with the tests first')).toBeVisible({ timeout: 3000 })
    await expect(agentPanel.getByText('Queued')).toBeVisible({ timeout: 3000 })

    await screenshotElement(page, agentPanel, path.join(SCREENSHOTS, '03-queued-badge.png'))
    steps.push({
      screenshotPath: 'screenshots/03-queued-badge.png',
      caption: 'Queued message in the feed with a pulsing "Queued" badge',
      description:
        'Pressing Enter while the agent is running adds the message to the chat feed ' +
        'immediately, with a pulsing "Queued" badge below the bubble. The message has ' +
        'already been injected into the active SDK session with priority "next".',
    })
  })

  test('Step 4: While agent is working, the input placeholder reflects the running state', async () => {
    const agentPanel = page.locator('[data-panel-id="agent"]')
    const textarea = page.locator('textarea').filter({ visible: true }).first()

    // The placeholder text changes while running to hint mid-turn typing is supported
    await expect(textarea).toHaveAttribute('placeholder', /Agent is working/)

    await screenshotElement(page, agentPanel, path.join(SCREENSHOTS, '04-working-state.png'))
    steps.push({
      screenshotPath: 'screenshots/04-working-state.png',
      caption: '"Agent is working..." placeholder hints that typing mid-turn is supported',
      description:
        'While the agent is busy, the input placeholder changes to "Agent is working... ' +
        '(type your next message)" to make the new capability discoverable.',
    })
  })

  test('Step 5: Agent finishes — Queued badge clears automatically', async () => {
    const agentPanel = page.locator('[data-panel-id="agent"]')

    // Wait for the mock response to arrive (4s delay)
    await expect(agentPanel.getByText("I'll start by reading")).toBeVisible({ timeout: 8000 })

    // Queued badge should be gone once the turn completes
    await expect(agentPanel.getByText('Queued')).not.toBeVisible({ timeout: 3000 })

    await screenshotElement(page, agentPanel, path.join(SCREENSHOTS, '05-turn-complete.png'))
    steps.push({
      screenshotPath: 'screenshots/05-turn-complete.png',
      caption: 'Turn complete — Queued badge cleared, conversation continues',
      description:
        'When the agent finishes its turn, the "Queued" badge is automatically removed ' +
        'from all queued messages. The conversation shows the original message, ' +
        'the queued follow-up, and the agent\'s response.',
    })
  })
})
