#!/usr/bin/env bash
# git-auto: stage changes, generate a conventional commit message, commit, push.
# Usage:
#   ./scripts/git-auto.sh              # add → commit → push
#   ./scripts/git-auto.sh --dry-run    # print message only
#   ./scripts/git-auto.sh --no-push    # commit without push
#   ./scripts/git-auto.sh -m "msg"     # use explicit message
#   ./scripts/git-auto.sh -- path...   # only stage given paths
set -euo pipefail

DRY_RUN=0
NO_PUSH=0
MSG_OVERRIDE=""
PATHS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --no-push) NO_PUSH=1; shift ;;
    -m|--message)
      MSG_OVERRIDE="${2:-}"
      if [[ -z "$MSG_OVERRIDE" ]]; then
        echo "error: -m requires a message" >&2
        exit 1
      fi
      shift 2
      ;;
    --) shift; PATHS+=("$@"); break ;;
    -h|--help)
      sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      echo "error: unknown option: $1" >&2
      exit 1
      ;;
    *)
      PATHS+=("$1"); shift ;;
  esac
done

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: not a git repository" >&2
  exit 1
fi

cd "$(git rev-parse --show-toplevel)"

# Refuse obvious secrets in the working tree / index candidates.
SECRET_GLOBS=('*.pem' '*.key' '*credentials*' '.env' '.env.*' '*id_rsa*' '*secret*')
check_secrets() {
  local f
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    local base
    base="$(basename "$f")"
    for g in "${SECRET_GLOBS[@]}"; do
      # shellcheck disable=SC2254
      case "$base" in
        $g)
          echo "error: refusing to auto-commit possible secret: $f" >&2
          exit 1
          ;;
      esac
    done
  done
}

# Stage
if [[ ${#PATHS[@]} -gt 0 ]]; then
  git add -- "${PATHS[@]}"
else
  git add -A
fi

check_secrets < <(git diff --cached --name-only; git ls-files --others --exclude-standard)

if git diff --cached --quiet; then
  # Nothing new to commit — still push if ahead and push enabled.
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "nothing staged"
    exit 0
  fi
  if [[ "$NO_PUSH" -eq 1 ]]; then
    echo "nothing to commit"
    exit 0
  fi
  branch="$(git rev-parse --abbrev-ref HEAD)"
  if [[ "$branch" == "HEAD" ]]; then
    echo "error: detached HEAD; nothing to push" >&2
    exit 1
  fi
  echo "nothing to commit; pushing $branch…"
  git push -u origin HEAD
  exit 0
fi

generate_message() {
  local names stats type scope summary
  names="$(git diff --cached --name-only)"
  stats="$(git diff --cached --stat)"

  type="chore"
  if echo "$names" | grep -qE '(^|/)test/|\.test\.|spec\.'; then
    type="test"
  fi
  if echo "$names" | grep -qE '(^|/)docs/|README|CHANGELOG|\.md$'; then
    type="docs"
  fi
  if echo "$names" | grep -qE '(^|/)src/|(^|/)lib/|\.(js|ts|tsx|jsx)$'; then
    if echo "$names" | grep -qiE 'fix|bug|hotfix' || \
       git diff --cached | grep -qiE '^\+.*(fix|bugfix)|^-.*(bug)'; then
      type="fix"
    elif git diff --cached --diff-filter=A --name-only | grep -qE '(^|/)src/'; then
      type="feat"
    else
      type="feat"
    fi
  fi
  if echo "$names" | grep -qE 'package\.json|package-lock|\.gitignore|Dockerfile|workflow'; then
    if [[ "$type" != "feat" && "$type" != "fix" ]]; then
      type="chore"
    fi
  fi
  # Pure docs (no src/test code)
  if echo "$names" | grep -qE 'README|docs/|\.md$' && \
     ! echo "$names" | grep -qE '(^|/)src/|(^|/)test/|\.(js|ts)$'; then
    type="docs"
  fi

  scope=""
  # Prefer a single top-level area as scope
  local areas
  areas="$(echo "$names" | awk -F/ '{
    if ($1=="src" && NF>1) print $2;
    else if ($1=="test") print "test";
    else if ($1=="docs") print "docs";
    else if ($1 ~ /\./) print "root";
    else print $1;
  }' | sed 's/\\.[^.]*$//' | sort -u)"
  local area_count
  area_count="$(echo "$areas" | grep -c . || true)"
  if [[ "$area_count" -eq 1 ]]; then
    scope="$(echo "$areas" | head -1)"
    scope="${scope%.js}"
    scope="${scope%.ts}"
    scope="${scope%.md}"
  fi

  # Summary: first meaningful path or shortstat subject line
  local primary
  primary="$(echo "$names" | head -1)"
  local file_count
  file_count="$(echo "$names" | grep -c . || true)"

  if [[ "$file_count" -eq 1 ]]; then
    summary="update ${primary}"
    case "$type" in
      feat) summary="add ${primary}" ;;
      fix) summary="fix ${primary}" ;;
      docs) summary="update ${primary}" ;;
      test) summary="cover ${primary}" ;;
      chore) summary="update ${primary}" ;;
    esac
  else
    summary="update ${file_count} files"
    # Prefer a human hint from the largest hunk file basename
    local top
    top="$(echo "$names" | head -3 | xargs -I{} basename {} | paste -sd ', ' -)"
    summary="update ${top}"
  fi

  # Soften summary: drop leading path noise
  summary="$(echo "$summary" | sed 's|src/||g; s|test/||g; s|docs/||g')"

  local subject
  if [[ -n "$scope" && "$scope" != "root" ]]; then
    subject="${type}(${scope}): ${summary}"
  else
    subject="${type}: ${summary}"
  fi

  # Keep subject reasonably short
  if [[ ${#subject} -gt 72 ]]; then
    subject="${subject:0:69}..."
  fi

  local body
  body="$(printf '%s\n' "$stats" | sed 's/^/  /')"

  printf '%s\n\n%s\n' "$subject" "$body"
}

MSG=""
if [[ -n "$MSG_OVERRIDE" ]]; then
  MSG="$MSG_OVERRIDE"
else
  MSG="$(generate_message)"
fi

echo "──── commit message ────"
echo "$MSG"
echo "────────────────────────"

if [[ "$DRY_RUN" -eq 1 ]]; then
  # Undo staging performed for message generation.
  git restore --staged . >/dev/null 2>&1 || git reset -q HEAD -- . >/dev/null 2>&1 || true
  echo "(dry-run: not committing or pushing)"
  exit 0
fi

git commit -m "$MSG"

if [[ "$NO_PUSH" -eq 1 ]]; then
  echo "committed (push skipped)"
  exit 0
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$branch" == "HEAD" ]]; then
  echo "error: detached HEAD; commit done but cannot push" >&2
  exit 1
fi

echo "pushing ${branch} → origin…"
git push -u origin HEAD
echo "done."
