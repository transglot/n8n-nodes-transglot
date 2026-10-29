# Publishing

The public source repository is transglot/n8n-nodes-transglot. Publish only from the manual `.github/workflows/publish.yml` workflow with npm provenance. It runs Node 24, npm 11, clean dependency installation, typechecking, tests, official n8n lint and build.

npm trusted publishing must match owner `transglot`, repository `n8n-nodes-transglot`, workflow `publish.yml`, environment `npm`. Allow `npm publish`; dist-tag management is not required. No long-lived npm token is used. Restrict repository write and environment access to authorized maintainers.

Before publishing, inspect `npm pack --dry-run` and run the official n8n package scanner. After publishing, verify the exact registry version and provenance, then submit through the n8n Creator Portal. Publication does not imply n8n verification or n8n Cloud availability. Never commit account tokens or workflow exports containing real signing secrets.
