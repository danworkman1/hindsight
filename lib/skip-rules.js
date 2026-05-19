export const REVIEW_CAP = 3;

const PROTECTED_BRANCHES = new Set(["main", "master"]);
const WIP_PATTERN = /\bwip\b/i;
const NO_REVIEW_TAG = /\[no-review\]/i;

export function shouldSkip({ branch, commitMessage, reviewCount, reviewCap = REVIEW_CAP }) {
  if (branch && PROTECTED_BRANCHES.has(branch)) {
    return { skip: true, reason: `protected branch: ${branch}` };
  }

  if (commitMessage && NO_REVIEW_TAG.test(commitMessage)) {
    return { skip: true, reason: "[no-review] tag in commit message" };
  }

  if (commitMessage && WIP_PATTERN.test(commitMessage)) {
    return { skip: true, reason: "wip commit" };
  }

  if (typeof reviewCount === "number" && reviewCount >= reviewCap) {
    return {
      skip: true,
      reason: `branch review cap reached (${reviewCount}/${reviewCap}) — run manually to force another review`,
    };
  }

  return { skip: false, reason: "" };
}
