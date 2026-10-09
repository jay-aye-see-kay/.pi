---
name: aws-docs
description: Search and read official AWS documentation, check which AWS services/APIs/CloudFormation resources are available in which regions, and fetch AWS's guided how-to skills, via the AWS Knowledge MCP (mcp__aws_knowledge). Use for AWS service limits, config params, API/CLI/CDK/CloudFormation reference, AWS error troubleshooting, "is X available in ap-southeast-2", or recent AWS announcements. Prefer it over web search for AWS questions.
---

# AWS docs (AWS Knowledge MCP)

AWS Knowledge is the `mcp__aws_knowledge` MCP server (no auth), called from `codemode`. Its tool descriptions are good (`describeTool("mcp__aws_knowledge__aws___<tool>")`), but results are JSON inside a text block, and errors are returned as successful results. Use the helpers in [lib.js](lib.js) instead — load it first in every script:

```js
const aws = new Function("tools", await tools.read({ path: "~/.pi/agent/skills/aws-docs/lib.js" }))(tools);

const hits = await aws.search("Fargate ephemeral storage maximum", { n: 4 });   // [{ title, url, text }]
return aws.show(hits);                    // title, URL, first 600 chars of chunk; show(hits, 0) = titles only

const [page] = await aws.read(hits[0].url, { max: 10000 });   // [{ url, text, total, end, truncated } | { url, error }]
await aws.read(page.url, { start: page.end });                // continue a truncated page

await aws.avail(["ap-southeast-2", "us-east-1"], "product", ["AWS Lambda", "Amazon Bedrock"]);
// → { "AWS Lambda": { "ap-southeast-2": "available", ... } }   statuses: available | no | planned
await aws.avail("ap-southeast-2", "product", null, { match: "lambda" });  // find exact catalog names
await aws.avail(["ap-southeast-2"], "api", ["EC2+RunInstances"]);       // or "cfn", ["AWS::Lambda::Function"]
```

- Search `text` is the **verbatim page chunk** (~1–2KB), which usually answers the question. Read the full page only for "list all X" questions, or when the chunks miss the answer.
- `search(q, { topics })` takes **one** topic: `reference_documentation` (API/CLI/config params), `troubleshooting` (error strings — keep them verbatim), `current_awareness` (new/announced), `cdk_docs`, `cdk_constructs`, `cloudformation`, `amplify_docs`, `strands_docs`, `agent_skills`, `general` (default).
- `read` only accepts AWS-owned URLs (docs.aws.amazon.com, aws.amazon.com, repost.aws/knowledge-center, some AWS GitHub READMEs, constructs.dev). Use exact URLs from search. Other URLs return `{ error }`.
- `avail` names must **exactly** match AWS's catalog ("AWS Lambda", not "Lambda"). A bad name throws an error that includes "did you mean" suggestions. Use `match` on a single region to list the valid names. Multi-region queries require filters. An unfiltered query pages through the whole catalog, which takes about 10s.
- **AWS guided skills:** `search(q, { topics: "agent_skills" })` returns hits with a `skill` name, and `aws.skill(name, file?)` returns its markdown. These are step-by-step AWS CLI procedures (launch EC2, CloudFront setup, …). Treat them as a reference; Culture Amp infra normally goes through our own IaC.
- `aws.regions()` → `[{ id, name }]`. `aws.call(tool, args)` returns the parsed raw result for anything else.

## When to use a subagent

- **Main agent:** a fact or limit lookup, or an availability check. One search usually answers it.
- **Subagent:** comparing services, reading several full pages, or following a guided skill's references. Have it return the answer with doc URLs.
