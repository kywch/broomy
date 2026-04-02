/**
 * Branch status computation from git state and persisted PR information.
 *
 * Implements a priority-based rule chain that maps a combination of local git
 * state (uncommitted files, ahead count, tracking branch, merge status) and
 * persisted PR state into one of six statuses: in-progress, pushed, empty, open,
 * merged, or closed. The `hasHadCommits` sticky flag distinguishes genuinely
 * merged branches from fresh/empty ones that have zero commits ahead of main.
 */
export type BranchStatus = 'in-progress' | 'pushed' | 'empty' | 'open' | 'merged' | 'closed'

export type PrState = 'OPEN' | 'MERGED' | 'CLOSED' | null

/**
 * Status chip value displayed in both the sidebar and source control panel.
 * This is the single source of truth for the session's visual status.
 *
 * - 'in-progress' | 'pushed' | 'empty' | 'merged' | 'closed': from branch status
 * - 'open': PR is open with no actionable feedback or CI failure
 * - 'feedback': PR has requested changes or new comments since last push
 * - 'failed': PR's CI checks have failed
 */
export type StatusChip = BranchStatus | 'feedback' | 'failed'

export interface BranchStatusInput {
  // From git status polling
  uncommittedFiles: number
  ahead: number
  hasTrackingBranch: boolean
  isOnMainBranch: boolean
  // Git-native merge detection
  isMergedToMain: boolean
  // Persisted session state
  hasHadCommits: boolean
  lastKnownPrState: PrState | undefined
}

export function computeBranchStatus(input: BranchStatusInput): BranchStatus {
  const {
    uncommittedFiles,
    ahead,
    hasTrackingBranch,
    isOnMainBranch,
    isMergedToMain,
    hasHadCommits,
    lastKnownPrState,
  } = input

  // 1. On main branch -> always in-progress
  if (isOnMainBranch) {
    return 'in-progress'
  }

  // 2. Has uncommitted changes or commits ahead of remote -> in-progress
  if (uncommittedFiles > 0 || ahead > 0) {
    return 'in-progress'
  }

  // 3. Git-native merge check (works for UI push, terminal push, and GitHub PR merge)
  if (isMergedToMain && hasHadCommits && hasTrackingBranch) {
    return 'merged'
  }

  // 3b. Fresh branch with tracking: isMergedToMain is true because there are 0 commits
  // ahead of main, but there were never any commits — this is an empty/fresh branch.
  if (isMergedToMain && !hasHadCommits && hasTrackingBranch) {
    return 'empty'
  }

  // 4. Check persisted PR state
  if (lastKnownPrState === 'MERGED') return 'merged'
  if (lastKnownPrState === 'CLOSED') return 'closed'
  if (lastKnownPrState === 'OPEN') return 'open'

  // 5. Has remote tracking branch, no PR -> pushed
  if (hasTrackingBranch) {
    return 'pushed'
  }

  // 6. Default
  return 'in-progress'
}

/**
 * Single function that computes the status chip value from branch status + PR metadata.
 * Used by both the sidebar and the source control panel to guarantee consistency.
 *
 * Priority: feedback > failed > base branch status
 * (feedback and failed only apply when the PR is open)
 */
export function computeStatusChip(
  branchStatus: BranchStatus,
  hasFeedback: boolean,
  checksStatus: 'passed' | 'failed' | 'pending' | 'none',
): StatusChip {
  if (branchStatus === 'open') {
    if (hasFeedback) return 'feedback'
    if (checksStatus === 'failed') return 'failed'
  }
  return branchStatus
}
