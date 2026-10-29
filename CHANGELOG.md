# n8n-nodes-transglot

This changelog is maintained by [Changesets](https://github.com/changesets/changesets); new
entries are prepended on each release.

## 0.1.1

- Authenticate trigger deliveries using HMAC-SHA256 over the exact request bytes, with
  a five-minute timestamp window. Reject unsigned, altered, stale and wrong-event requests.
- Retain each subscription's reveal-once signing secret, replace legacy subscriptions
  on activation, and clear the secret when unsubscribing.
- Preserve downloaded JSON files as text and provide their parsed preview in current n8n runtimes.
- Add current n8n credentials/icons, safer source-file handling, usage requirements and
  example workflows. Publish from the standalone connector repository with provenance.

## 0.1.0

- Initial release: the n8n community node (AI translation action, file pull,
  project/batch status, and event trigger) over the deploy-token API.
