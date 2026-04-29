import type { ExtensionAPI, ProviderModelConfig, BashOperations } from "@mariozechner/pi-coding-agent";
import { createLocalBashOperations } from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import type { StreamFunction } from "@mariozechner/pi-ai";
import { execSync } from "child_process";
import { readFileSync, existsSync, realpathSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { pathToFileURL } from "url";

// Locate pi-ai's bedrock-provider.js by resolving the `pi` binary path,
// then load streamBedrock directly. This bypasses pi-ai's api-registry which
// pi's registerProvider monkey-patches to route through our extension's
// streamSimple — calling stream()/streamSimple() from pi-ai would recurse.
async function loadStreamBedrock(): Promise<StreamFunction<"bedrock-converse-stream", any>> {
  const piBin = execSync("which pi", { encoding: "utf-8" }).trim();
  const realBin = realpathSync(piBin);
  const piPkgRoot = join(dirname(realBin), "..");
  const bedrockProviderPath = join(
    piPkgRoot,
    "node_modules/@mariozechner/pi-ai/dist/bedrock-provider.js",
  );
  const mod: any = await import(pathToFileURL(bedrockProviderPath).href);
  return mod.bedrockProviderModule.streamBedrock;
}

const BEDROCK_AWS_PROFILE = "cultureamp-sandbox/BedrockDevTools";
const BEDROCK_AWS_REGION = "us-west-2";

// ─────────────────────────────────────────────────────────────────────────────
// AWS Env Isolation
//
// The AWS SDK used by pi-ai's bedrock provider reads process.env directly.
// If the user has AWS_PROFILE + AWS_ACCESS_KEY_ID both set (typical with
// granted), the SDK logs a noisy "Multiple credential sources detected"
// warning into the TUI. We also don't want the LLM provider to silently
// fall back to whatever creds the user happens to have exported.
//
// Strategy: snapshot and strip every AWS_* env var at extension load so the
// SDK only sees what we configure (profile + region via options). Re-inject
// the originals into every bash tool invocation via a `tool_call` handler
// so shell commands still run under the user's assumed role.
// ─────────────────────────────────────────────────────────────────────────────

const userAwsEnv: Record<string, string> = {};
for (const key of Object.keys(process.env)) {
  if (key.startsWith("AWS_")) {
    userAwsEnv[key] = process.env[key]!;
    delete process.env[key];
  }
}

function shellQuote(value: string): string {
  // Wrap in single quotes, escape embedded single quotes as '\''.
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function awsEnvPrefix(): string {
  const entries = Object.entries(userAwsEnv);
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => `export ${k}=${shellQuote(v)}`).join("; ") + "; ";
}

// ─────────────────────────────────────────────────────────────────────────────
// AWS Credential Refresh
//
// We keep AWS creds for Bedrock isolated from the user's shell env so that
// bash tool calls run against whatever profile the user assumed before
// starting pi (e.g. cultureamp-development/ReadOnly), not the Bedrock
// profile. To do that we never set process.env.AWS_*; instead we ensure
// the credentials cache that `granted credential-process` populates is
// fresh, and we pass `profile`/`region` directly into the Bedrock SDK
// options at call time (see streamSimple below).
// ─────────────────────────────────────────────────────────────────────────────

interface AwsCredentials {
  AccessKeyId: string;
  SecretAccessKey: string;
  SessionToken: string;
  Expiration: string;
}

let credentialExpiry: number | null = null;

function refreshBedrockCredentials(): boolean {
  try {
    const output = execSync(
      `granted credential-process --profile "${BEDROCK_AWS_PROFILE}" 2>/dev/null`,
      { encoding: "utf-8", timeout: 30000 },
    );

    const parsed = JSON.parse(output);
    const creds: AwsCredentials = parsed.Credentials ?? parsed;

    if (!creds.AccessKeyId || !creds.SecretAccessKey) {
      return false;
    }

    if (creds.Expiration) {
      credentialExpiry = new Date(creds.Expiration).getTime() - 5 * 60 * 1000;
    }

    return true;
  } catch (error) {
    return false;
  }
}

function needsRefresh(): boolean {
  if (!credentialExpiry) return true;
  return Date.now() > credentialExpiry;
}

// ─────────────────────────────────────────────────────────────────────────────
// Model Metadata (from pi-ai built-in registry)
// ─────────────────────────────────────────────────────────────────────────────

interface ModelMeta {
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  name: string;
}

const FALLBACK_DEFAULTS: ModelMeta = {
  contextWindow: 200000,
  maxTokens: 8192,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  name: "",
};

function getModelMeta(modelId: string): ModelMeta {
  const exact = getModel("amazon-bedrock", modelId as any);
  if (exact) {
    return {
      contextWindow: exact.contextWindow,
      maxTokens: exact.maxTokens,
      reasoning: exact.reasoning,
      input: exact.input as ("text" | "image")[],
      cost: { ...exact.cost },
      name: exact.name,
    };
  }

  if (modelId.startsWith("us.")) {
    const baseId = modelId.slice(3);
    const base = getModel("amazon-bedrock", baseId as any);
    if (base) {
      return {
        contextWindow: base.contextWindow,
        maxTokens: base.maxTokens,
        reasoning: base.reasoning,
        input: base.input as ("text" | "image")[],
        cost: { ...base.cost },
        name: base.name,
      };
    }
  }

  return { ...FALLBACK_DEFAULTS, name: modelId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Wilma Profile Loading
// ─────────────────────────────────────────────────────────────────────────────

interface WilmaProfile {
  profileArn: string;
  profileName: string;
  modelId: string;
  status: string;
  createdAt: string;
  tags: Record<string, string>;
  description: string;
}

function loadWilmaProfiles(): WilmaProfile[] {
  const modelsPath = join(homedir(), ".pi/agent/extensions/ca-bedrock-auth/models.json");

  if (!existsSync(modelsPath)) {
    return [];
  }

  try {
    const content = readFileSync(modelsPath, "utf-8");
    const profiles: WilmaProfile[] = JSON.parse(content);
    return profiles.filter((p) => p.status === "ACTIVE");
  } catch (error) {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension
// ─────────────────────────────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  refreshBedrockCredentials();

  const profiles = loadWilmaProfiles();
  if (profiles.length === 0) {
    return;
  }

  const streamBedrock = await loadStreamBedrock();

  // ARN map: modelId → application-inference-profile ARN
  const arnMap = new Map<string, string>();
  for (const profile of profiles) {
    arnMap.set(profile.modelId, profile.profileArn);
  }

  const models = profiles.map((profile): ProviderModelConfig => {
    const meta = getModelMeta(profile.modelId);
    return {
      id: profile.modelId,
      name: meta.name || profile.modelId,
      reasoning: meta.reasoning,
      input: meta.input,
      contextWindow: meta.contextWindow,
      maxTokens: meta.maxTokens,
      cost: meta.cost,
    };
  });

  // Custom streamSimple wraps pi-ai's dispatch and:
  //   1. Injects `profile` + `region` into BedrockOptions so the AWS SDK
  //      uses the Bedrock profile *only* for this call, leaving the
  //      shell's AWS_* env vars untouched.
  //   2. Swaps modelId → application-inference-profile ARN.
  pi.registerProvider("amazon-bedrock", {
    baseUrl: `https://bedrock-runtime.${BEDROCK_AWS_REGION}.amazonaws.com`,
    apiKey: "aws-sdk",
    api: "bedrock-converse-stream",
    models,
    streamSimple: (model, context, options) => {
      const arn = arnMap.get(model.id);
      const effectiveModel = arn ? { ...model, id: arn } : model;
      const effectiveOptions = {
        ...options,
        profile: BEDROCK_AWS_PROFILE,
        region: BEDROCK_AWS_REGION,
      };
      return streamBedrock(effectiveModel as any, context, effectiveOptions as any);
    },
  });

  pi.on("session_start", async () => {
    if (needsRefresh()) refreshBedrockCredentials();
  });

  pi.on("turn_start", async () => {
    if (needsRefresh()) refreshBedrockCredentials();
  });

  // Re-inject the user's original AWS_* env vars into every bash command
  // so tools that talk to AWS (aws cli, terraform, etc.) see the role the
  // user assumed before launching pi — not our stripped-down process env.
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    const prefix = awsEnvPrefix();
    if (!prefix) return;
    event.input.command = prefix + event.input.command;
  });

  // Same treatment for `!cmd` / `!!cmd` user-typed bash. user_bash can't
  // rewrite the command (it's a local in handleBashCommand), so instead we
  // supply a BashOperations override that restores AWS_* via the spawned
  // process env.
  const localBash = createLocalBashOperations();
  const awsAwareBash: BashOperations = {
    exec: (command, cwd, options) =>
      localBash.exec(command, cwd, {
        ...options,
        env: { ...process.env, ...options.env, ...userAwsEnv },
      }),
  };
  pi.on("user_bash", async () => {
    if (Object.keys(userAwsEnv).length === 0) return;
    return { operations: awsAwareBash };
  });
}
