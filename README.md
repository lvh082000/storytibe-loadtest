# storytibe-loadtest

k6 load test for https://storytibe.com, run on GitHub Actions (public repo ⇒ free minutes).

- `k6/novel-reader.js` — simulated readers. The request profile per page view was recorded from a
  real Chrome session (HTML, Next.js segment prefetches, covers, CORS preflight, view count).
- `.github/workflows/load.yml` — manual workflow; `jobs` runners in parallel, each with its own IP,
  all starting at the same moment.

Results and how to read them: ric-api `docs/novel/02-ket-qua-do-hieu-nang.md` (private).

Only run against production with the owner's approval: the server is shared with other systems.
Each run inflates chapter view counts; snapshot them before and restore them after.
