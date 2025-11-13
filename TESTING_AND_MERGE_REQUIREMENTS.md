# Testing and Merge Requirements for Claude Code Logs Feature

This document outlines the testing validation and CI/CD requirements that must pass before this PR can be merged into Langfuse.

## ✅ Completed Requirements

### 1. Code Implementation
- ✅ Created `ClaudeCodeLogsToTracesConverter` class in `packages/shared/src/server/otel/`
- ✅ Created API endpoint at `/api/public/claude-code/logs`
- ✅ Followed public API patterns (withMiddlewares, createAuthedProjectAPIRoute)
- ✅ Used Zod v4 for validation
- ✅ Proper error handling and logging

### 2. Testing
- ✅ Created comprehensive Jest tests in `web/src/__tests__/async/claude-code-logs-api.servertest.ts`
- ✅ Tests cover all major event types:
  - User prompt events
  - Tool result events
  - API request events with token usage
  - Multiple events in one batch
  - Empty logs handling
  - Invalid content type rejection
- ✅ Tests are decoupled and can run independently
- ✅ No `pruneDatabase` calls in async tests

### 3. Documentation
- ✅ Created comprehensive README.md with:
  - API usage examples
  - Configuration instructions
  - Event type documentation
  - Privacy and security guidelines
- ✅ Added Fern API specification (`fern/apis/server/definition/claude-code.yml`)

### 4. Code Quality
- ✅ Passed linter checks
- ✅ Fixed TypeScript iteration issues
- ✅ Follows existing code conventions
- ✅ Uses existing infrastructure (OtelIngestionQueue, S3 storage)

## 🔄 CI/CD Pipeline Requirements

According to `.github/workflows/pipeline.yml`, the following jobs must pass:

### Required Jobs (Lines 566-580)

All of these jobs run automatically on pull requests and must succeed:

1. **`lint`** (Lines 31-53)
   - Runs ESLint checks
   - Status: ✅ Should pass (no linting errors found)

2. **`prettier-check`** (Lines 55-96)
   - Checks code formatting
   - Status: ✅ Should pass (proper formatting)

3. **`test-docker-build`** (Lines 98-134)
   - Tests Docker build process
   - Status: ⚠️ Runs automatically in CI

4. **`tests-web-sync`** (Lines 136-210)
   - Runs synchronous Jest tests
   - Matrix: Node 24 × PostgreSQL [12, 15]
   - Status: ⚠️ Runs automatically in CI

5. **`tests-web-async`** (Lines 212-301) **← Our tests run here**
   - Runs asynchronous Jest tests
   - Matrix: Node 24 × PostgreSQL [12, 15] × Deploy modes ["", "-azure", "-redis-cluster"]
   - **This is where our `claude-code-logs-api.servertest.ts` tests execute**
   - Command: `pnpm --filter=web run test`
   - Status: ⚠️ Runs automatically in CI

6. **`tests-worker`** (Lines 303-366)
   - Runs worker package tests
   - Status: ✅ No worker changes, should pass

7. **`test-worker-llm-connections`** (Lines 368-439)
   - Tests LLM connections
   - Status: ✅ No LLM connection changes, should pass

8. **`e2e-tests`** (Lines 441-499)
   - Playwright end-to-end UI tests
   - Status: ✅ No UI changes, should pass

9. **`e2e-server-tests`** (Lines 501-564)
   - End-to-end server tests
   - Status: ✅ No server changes affecting E2E, should pass

### CI/CD Success Criteria

The `all-ci-passed` job (Lines 566-590) requires ALL above jobs to succeed. If any fail, the merge is blocked.

## 📋 Manual Actions Required

### Option 1: Wait for CI (Recommended for PRs)

Simply create the PR and wait for GitHub Actions to run all tests automatically. The CI will:

1. Run all linting and formatting checks
2. Build Docker images
3. Run all test suites (sync, async, worker, e2e)
4. Report results on the PR

**Timeline:** Typically 20-30 minutes for full CI pipeline

### Option 2: Run Tests Locally (Optional)

If you want to validate before creating the PR:

#### Prerequisites
```bash
# Ensure Docker is running for databases
docker compose -f docker-compose.dev.yml up -d

# Ensure dependencies are installed
pnpm install

# Set up test environment
cp .env.test.example .env.test
```

#### Run Specific Tests
```bash
# Run only Claude Code tests
cd web
pnpm test -- --testPathPattern="claude-code-logs-api"

# Run all async tests (includes Claude Code tests)
pnpm test

# Run lint
pnpm run lint

# Run prettier check
pnpm prettier --check web/src/pages/api/public/claude-code/** packages/shared/src/server/otel/ClaudeCodeLogsToTracesConverter.ts
```

## 🎯 Fern API Spec Generation

**IMPORTANT:** According to CLAUDE.md line 142-143, after updating Fern specs, you should regenerate the OpenAPI spec:

```bash
# Install Fern CLI if not already installed
npm install -g fern-api

# Generate OpenAPI spec (requires Fern account login)
npx fern-api generate --api server
```

**Note:** This step is typically done by maintainers during the review process, but you can do it if you have Fern access.

The generated files will be:
- `web/public/generated/api/openapi.yml`
- `web/public/generated/postman/collection.json`

## 📝 Additional Review Requirements

### 1. Contributor License Agreement (CLA)
- Must be signed via [CLA Assistant](https://cla-assistant.io/langfuse/langfuse)
- Will be prompted automatically on first PR
- Only needs to be done once

### 2. Conventional Commits
- Main branch uses [conventional commits](https://www.conventionalcommits.org/)
- PR will be squash-merged with conventional commit message
- Current commit messages are compliant:
  - ✅ `feat: add Claude Code OpenTelemetry logs to traces conversion`
  - ✅ `docs: add Fern API specification for Claude Code logs endpoint`

### 3. Code Review
- Maintainers will review the implementation
- May request changes or improvements
- Discussion happens on GitHub PR

## 🚀 Expected CI Behavior

### On Pull Request Creation

1. **Automatic Triggers:** All test jobs start automatically
2. **Concurrent Execution:** Jobs run in parallel for speed
3. **Matrix Testing:** Tests run across multiple configurations (PostgreSQL 12 & 15, different Redis modes)
4. **Status Checks:** GitHub shows progress on PR page

### Success Indicators

When all tests pass, you'll see:
- ✅ All CI checks green on PR
- ✅ "All checks have passed" message
- ✅ PR is eligible for merge (subject to review)

### Failure Scenarios

If tests fail:
- ❌ Failed job will show in PR checks
- 📋 Review logs in GitHub Actions tab
- 🔧 Fix issues and push new commit
- 🔄 CI re-runs automatically on new commits

## 📊 Current Status

| Requirement | Status | Notes |
|------------|--------|-------|
| Code Implementation | ✅ Complete | All files created and pushed |
| Unit Tests | ✅ Complete | Comprehensive test coverage |
| Documentation | ✅ Complete | README + Fern spec |
| Linting | ✅ Pass | No linting errors |
| Type Safety | ✅ Pass | TypeScript compilation clean |
| Fern Spec | ✅ Complete | Added to `fern/apis/server/definition/` |
| CI Pipeline | ⏳ Pending | Will run on PR creation |
| Code Review | ⏳ Pending | Requires maintainer review |
| CLA | ⏳ Pending | User must sign |

## 🎉 Next Steps

1. **Create Pull Request** on GitHub
2. **Wait for CI** to complete (20-30 minutes)
3. **Sign CLA** if prompted
4. **Address Review Feedback** from maintainers
5. **Celebrate** when merged! 🎊

## 💡 Tips for Success

- **CI Failures:** Don't panic! Review logs, fix issues, push updates
- **Test Failures:** Ensure local environment matches CI (Node 24, correct PostgreSQL version)
- **Review Comments:** Be responsive and open to suggestions
- **Documentation:** Keep README updated if implementation changes

## 📞 Getting Help

- **Discord:** Join [Langfuse Discord](https://langfuse.com/discord) for real-time help
- **GitHub Issues:** Comment on PR for maintainer assistance
- **Documentation:** Reference [Contributing Guide](CONTRIBUTING.md)

---

**Summary:** All code is ready! Create the PR and let CI validate everything. The comprehensive test suite and proper documentation mean this feature is well-positioned for a smooth review process.
