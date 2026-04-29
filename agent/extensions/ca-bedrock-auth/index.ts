import type { ExtensionAPI, ProviderModelConfig } from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const AWS_PROFILE = "cultureamp-sandbox/BedrockDevTools";
const AWS_REGION = "us-west-2";

// ─────────────────────────────────────────────────────────────────────────────
// AWS Credential Refresh
// ─────────────────────────────────────────────────────────────────────────────

interface AwsCredentials {
  AccessKeyId: string;
  SecretAccessKey: string;
  SessionToken: string;
  Expiration: string;
}

let credentialExpiry: number | null = null;

function refreshAwsCredentials(): boolean {
  try {
    const output = execSync(
      `granted credential-process --profile "${AWS_PROFILE}" 2>/dev/null`,
      { encoding: "utf-8", timeout: 30000 }
    );

    const parsed = JSON.parse(output);
    const creds: AwsCredentials = parsed.Credentials ?? parsed;

    if (!creds.AccessKeyId || !creds.SecretAccessKey) {
      return false;
    }

    process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
    process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
    process.env.AWS_SESSION_TOKEN = creds.SessionToken;
    process.env.AWS_REGION = AWS_REGION;
    process.env.AWS_DEFAULT_REGION = AWS_REGION;
    // Unset AWS_PROFILE to avoid SDK warning about multiple credential sources
    delete process.env.AWS_PROFILE;

    if (creds.Expiration) {
      credentialExpiry = new Date(creds.Expiration).getTime() - 5 * 60 * 1000;
    }

    return true;
  } catch (error) {
    // Silent fail - credentials not available
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
  // Try exact match first
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

  // Try without "us." prefix (cross-region inference profiles)
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
    // Silent fail - no models loaded, user needs to run wilma
    return [];
  }

  try {
    const content = readFileSync(modelsPath, "utf-8");
    const profiles: WilmaProfile[] = JSON.parse(content);
    return profiles.filter((p) => p.status === "ACTIVE");
  } catch (error) {
    // Silent fail - invalid JSON
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension
// ─────────────────────────────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  // Refresh credentials at startup
  refreshAwsCredentials();

  // Load wilma profiles
  const profiles = loadWilmaProfiles();
  if (profiles.length === 0) {
    return;
  }

  // Build ARN map: modelId → profileArn
  const arnMap = new Map<string, string>();
  for (const profile of profiles) {
    arnMap.set(profile.modelId, profile.profileArn);
  }

  // Transform to pi models (with real AWS pricing from pi-ai registry)
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



  // Register provider (replaces built-in bedrock models)
  pi.registerProvider("amazon-bedrock", {
    baseUrl: `https://bedrock-runtime.${AWS_REGION}.amazonaws.com`,
    apiKey: "aws-sdk",
    api: "bedrock-converse-stream",
    models,
  });

  // Swap modelId → ARN before API request
  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    if (model?.provider === "amazon-bedrock") {
      const arn = arnMap.get(model.id);
      if (arn && event.payload && typeof event.payload === "object") {
        const payload = event.payload as Record<string, unknown>;
        if (payload.modelId === model.id) {
          return { ...payload, modelId: arn };
        }
      }
    }
  });

  // Credential refresh hooks
  pi.on("session_start", async () => {
    if (needsRefresh()) refreshAwsCredentials();
  });

  pi.on("turn_start", async () => {
    if (needsRefresh()) refreshAwsCredentials();
  });
}
