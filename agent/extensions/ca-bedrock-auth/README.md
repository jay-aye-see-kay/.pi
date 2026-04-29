# ca-bedrock

An extension for working with bedrock profiles provided by wilma. Replaces existing bedrock models.

## setup

- add profiles with wilma
- save wilma config to models.json
```bash
wilma list --json > ~/.pi/agent/extensions/ca-bedrock-auth/models.json
```
- until https://github.com/cultureamp/wilma/pull/47 merges, you have to delete the first couple of lines in this file manually to get valid json

## what models are available?

Look at pi's config for bedrock models, and assume that's what's available (it will be very close). This "one liner" prints available models sorted by cost

```bash
node --input-type=module -e '
 import { realpathSync } from "fs";
 import { execSync } from "child_process"; import { join, dirname } from "path";

 const piPkg = join(dirname(realpathSync(execSync("which pi",{encoding:"utf8"}).trim())), "..");
 const { MODELS } = await import("file://" + join(piPkg, "node_modules/@mariozechner/pi-ai/dist/models.generated.js"));

 const m = Object.values(MODELS["amazon-bedrock"]);
 const sorted = m.sort((a,b) => a.cost.output - b.cost.output);
 const maxId = Math.max("model".length, ...sorted.map(v => v.id.length));
 const maxCtx = Math.max("context".length, ...sorted.map(v => (Math.round(v.contextWindow/1000)+"k").length));
 const maxIn = Math.max("in".length, ...sorted.map(v => (""+v.cost.input).length));
 const maxOut = Math.max("out".length, ...sorted.map(v => (""+v.cost.output).length));
 console.log(`${"model".padEnd(maxId)} | ${"context".padStart(maxCtx)} | ${"in".padStart(maxIn)} | ${"out".padStart(maxOut)}`);
 console.log(`${"-".repeat(maxId)}-+-${"-".repeat(maxCtx)}-+-${"-".repeat(maxIn)}-+-${"-".repeat(maxOut)}`);
 sorted.forEach(v => {
   const ctx = Math.round(v.contextWindow/1000)+"k";
   console.log(`${v.id.padEnd(maxId)} | ${ctx.padStart(maxCtx)} | ${(""+v.cost.input).padStart(maxIn)} | ${(""+v.cost.output).padStart(maxOut)}`);
 });
 '
```

## list and delete models

```bash
# get all models configured via wilma
cat agent/extensions/ca-bedrock-auth/models.json | jq '.[].profileArn'

# manually turn them into these commands to delete
aws bedrock delete-inference-profile --inference-profile-identifier arn:aws:bedrock:us-west-2:529105607725:application-inference-profile/...XYZ...
```
