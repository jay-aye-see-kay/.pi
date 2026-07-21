/**
 * Sandbox — OS-level sandboxing for bash + path/network policy for pi's tools.
 *
 * Uses @anthropic-ai/sandbox-runtime (sandbox-exec on macOS, bubblewrap on Linux)
 * to restrict bash. pi's in-process read/write/edit tools bypass the OS sandbox,
 * so they are gated separately in the `tool_call` hook.
 *
 * Two modes (config `mode`, default "sandbox"):
 *
 *   "sandbox" — OS sandbox on. Network access to hosts outside `allowedDomains`
 *     is prompted at CONNECTION time via the sandbox's request-time ask callback
 *     (accurate — no command regex). read/write/edit are gated against
 *     allowRead/allowWrite/denyWrite. Grants can be kept for the session, the
 *     project, or all projects.
 *
 *   "prompt" — NO OS sandbox. The agent can touch anything outside the sandbox,
 *     but every read/edit/write/bash is prompted, every time, with no memory.
 *
 * Config (merged; project overrides global):
 *   ~/.pi/agent/sandbox.json   (global)
 *   <cwd>/.pi/sandbox.json     (project)
 *
 * The bundled patch (patches/) neutralises the library's hardcoded
 * DANGEROUS_FILES / DANGEROUS_DIRECTORIES mandatory write-denies (which
 * blocked .vscode/.idea/.claude/* and various dotfiles, see issue #159).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { BashOperations, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashTool, getAgentDir, getShellConfig, isToolCallEventType } from "@earendil-works/pi-coding-agent";

// ── Config ──────────────────────────────────────────────────────────────────

type Mode = "sandbox" | "prompt";

interface NetworkConfig {
	allowedDomains?: string[];
	deniedDomains?: string[];
	allowLocalBinding?: boolean;
	allowAllUnixSockets?: boolean;
	allowUnixSockets?: string[];
}
interface FilesystemConfig {
	denyRead?: string[];
	allowRead?: string[];
	allowWrite?: string[];
	denyWrite?: string[];
}
interface SandboxConfig {
	mode?: Mode;
	enabled?: boolean;
	network?: NetworkConfig;
	filesystem?: FilesystemConfig;
}

const DEFAULT_CONFIG: SandboxConfig = {
	mode: "sandbox",
	enabled: true,
	network: {
		allowedDomains: ["localhost", "github.com", "*.github.com", "registry.npmjs.org", "*.npmjs.org", "pypi.org", "*.pypi.org"],
		deniedDomains: [],
	},
	filesystem: {
		denyRead: [],
		allowRead: ["."],
		allowWrite: [".", "/tmp"],
		denyWrite: [".env", ".env.*", "*.pem", "*.key"],
	},
};

function readJson(path: string): Partial<SandboxConfig> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (e) {
		console.error(`sandbox: could not parse ${path}: ${e}`);
		return {};
	}
}

function configPaths(cwd: string): { globalPath: string; projectPath: string } {
	return { globalPath: join(getAgentDir(), "sandbox.json"), projectPath: join(cwd, ".pi", "sandbox.json") };
}

function loadConfig(cwd: string): SandboxConfig {
	const { globalPath, projectPath } = configPaths(cwd);
	const merged = [DEFAULT_CONFIG, readJson(globalPath), readJson(projectPath)].reduce<SandboxConfig>((acc, o) => ({
		mode: o.mode ?? acc.mode,
		enabled: o.enabled ?? acc.enabled,
		network: { ...acc.network, ...o.network },
		filesystem: { ...acc.filesystem, ...o.filesystem },
	}), {} as SandboxConfig);
	return merged;
}

// ── Path matching ───────────────────────────────────────────────────────────

function expandPath(p: string): string {
	return resolve(p.replace(/^~(?=$|\/)/, homedir()));
}

function canonicalizePath(p: string): string {
	const abs = expandPath(p);
	try {
		return realpathSync.native(abs);
	} catch {
		// Path (or a tail of it) does not exist yet: resolve symlinks in the
		// nearest existing ancestor, then re-append the missing tail.
		const tail: string[] = [];
		let probe = abs;
		while (!existsSync(probe)) {
			const parent = dirname(probe);
			if (parent === probe) return abs;
			tail.unshift(basename(probe));
			probe = parent;
		}
		try {
			return resolve(realpathSync.native(probe), ...tail);
		} catch {
			return abs;
		}
	}
}

function matchesPattern(filePath: string, patterns: string[]): boolean {
	const abs = canonicalizePath(filePath);
	return patterns.some((pat) => {
		if (pat.includes("*")) {
			const absPat = expandPath(pat);
			const rx = absPat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
			return new RegExp(`^${rx}$`).test(abs);
		}
		const absPat = canonicalizePath(pat);
		const sep = absPat.endsWith("/") ? "" : "/";
		return abs === absPat || abs.startsWith(absPat + sep);
	});
}

// ── Domain matching ─────────────────────────────────────────────────────────

function domainMatches(domain: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (pattern.startsWith("*.")) {
		const base = pattern.slice(2);
		return domain === base || domain.endsWith("." + base);
	}
	return domain === pattern;
}

function domainAllowed(domain: string, allowed: string[]): boolean {
	return allowed.some((p) => domainMatches(domain, p));
}

// ── Config writers (in-process; not OS-sandboxed) ─────────────────────────────

function writeConfig(path: string, cfg: Partial<SandboxConfig>): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}

function addToConfigList(path: string, section: "network" | "filesystem", key: string, value: string): void {
	const cfg = readJson(path);
	const sec = ((cfg as Record<string, Record<string, unknown>>)[section] ??= {});
	const list = (sec[key] as string[] | undefined) ?? [];
	if (!list.includes(value)) {
		sec[key] = [...list, value];
		writeConfig(path, cfg);
	}
}

// ── Sandboxed bash ops ────────────────────────────────────────────────────────

function sandboxedBashOps(shellPath?: string): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout, env }) {
			if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
			const wrapped = await SandboxManager.wrapWithSandbox(command);
			const { shell, args } = getShellConfig(shellPath);
			return new Promise((resolvePromise, reject) => {
				const child = spawn(shell, [...args, wrapped], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
				let timedOut = false;
				let th: NodeJS.Timeout | undefined;
				if (timeout && timeout > 0) {
					th = setTimeout(() => {
						timedOut = true;
						if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
					}, timeout * 1000);
				}
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				child.on("error", (e) => { if (th) clearTimeout(th); reject(e); });
				const onAbort = () => { if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } };
				signal?.addEventListener("abort", onAbort, { once: true });
				child.on("close", (code) => {
					if (th) clearTimeout(th);
					signal?.removeEventListener("abort", onAbort);
					if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${timeout}`));
					else resolvePromise({ exitCode: code });
				});
			});
		},
	};
}

/** Pull a blocked write path out of a bash "Operation not permitted" error. */
function blockedWritePath(output: string): string | null {
	const m = output.match(/(?:\/bin\/bash|bash|sh): (?:line \d+: )?(\/[^\s:]+): Operation not permitted/);
	return m ? m[1] : null;
}

// ── Extension ─────────────────────────────────────────────────────────────────

type Grant = "session" | "project" | "global" | "deny";

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const { shell } = getShellConfig();
	const localBash = createBashTool(cwd);

	let mode: Mode = "sandbox";
	let sandboxOn = false; // OS sandbox initialised
	let ctxRef: ExtensionContext | null = null;

	// Runtime grants (in-memory, not visible to the agent), on top of config files.
	const sessionDomains = new Set<string>();
	const sessionRead: string[] = [];
	const sessionWrite: string[] = [];

	const effAllowedDomains = () => [...(loadConfig(cwd).network?.allowedDomains ?? []), ...sessionDomains];
	const effAllowRead = () => [...(loadConfig(cwd).filesystem?.allowRead ?? []), ...sessionRead];
	const effAllowWrite = () => [...(loadConfig(cwd).filesystem?.allowWrite ?? []), ...sessionWrite];

	// ── Serial prompt queue (network asks can fire concurrently mid-execution) ──
	let queue: Promise<unknown> = Promise.resolve();
	function enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const run = queue.then(fn);
		queue = run.then(() => {}, () => {});
		return run;
	}

	// ── Grant prompt ────────────────────────────────────────────────────────────
	const GRANT_LABELS: Record<Exclude<Grant, "deny">, string> = {
		session: "Allow — this session only",
		project: "Allow — this project (.pi/sandbox.json)",
		global: "Allow — all projects (~/.pi/agent/sandbox.json)",
	};
	async function promptGrant(ctx: ExtensionContext, title: string): Promise<Grant> {
		const labels = [GRANT_LABELS.session, GRANT_LABELS.project, GRANT_LABELS.global, "Deny"];
		const choice = await ctx.ui.select(title, labels);
		if (choice === GRANT_LABELS.session) return "session";
		if (choice === GRANT_LABELS.project) return "project";
		if (choice === GRANT_LABELS.global) return "global";
		return "deny";
	}

	async function applyGrant(kind: "domain" | "read" | "write", value: string, grant: Grant): Promise<void> {
		if (grant === "deny") return;
		const { globalPath, projectPath } = configPaths(cwd);
		const section = kind === "domain" ? "network" : "filesystem";
		const key = kind === "domain" ? "allowedDomains" : kind === "read" ? "allowRead" : "allowWrite";
		if (kind === "domain") sessionDomains.add(value);
		else if (kind === "read") { if (!sessionRead.includes(value)) sessionRead.push(value); }
		else if (!sessionWrite.includes(value)) sessionWrite.push(value);
		if (grant === "project") addToConfigList(projectPath, section, key, value);
		if (grant === "global") addToConfigList(globalPath, section, key, value);
		// Reinitialise so a running OS sandbox picks up new fs paths for bash.
		// Network grants are served by the ask callback, so no reinit needed.
		if (kind !== "domain" && sandboxOn) await reinitSandbox();
	}

	// ── Sandbox init ──────────────────────────────────────────────────────────
	function runtimeConfig() {
		const cfg = loadConfig(cwd);
		return {
			network: {
				allowedDomains: effAllowedDomains(),
				deniedDomains: cfg.network?.deniedDomains ?? [],
				allowLocalBinding: cfg.network?.allowLocalBinding,
				allowAllUnixSockets: cfg.network?.allowAllUnixSockets,
				allowUnixSockets: cfg.network?.allowUnixSockets,
			},
			filesystem: {
				denyRead: cfg.filesystem?.denyRead ?? [],
				allowRead: effAllowRead(),
				allowWrite: effAllowWrite(),
				denyWrite: cfg.filesystem?.denyWrite ?? [],
			},
		};
	}

	// Request-time network gate. Fires only for hosts the proxy can't already
	// resolve via allow/deny lists → we only need to consult runtime grants.
	const askNetwork = async ({ host }: { host: string; port: number | undefined }): Promise<boolean> => {
		if (domainAllowed(host, effAllowedDomains())) return true;
		const ctx = ctxRef;
		if (!ctx?.hasUI) return false;
		return enqueue(async () => {
			if (domainAllowed(host, effAllowedDomains())) return true; // granted while queued
			const grant = await promptGrant(ctx, `🌐 Allow network connection to "${host}"?`);
			await applyGrant("domain", host, grant);
			return grant !== "deny";
		});
	};

	async function initSandbox(): Promise<void> {
		await SandboxManager.initialize(runtimeConfig(), askNetwork);
		sandboxOn = true;
	}
	async function reinitSandbox(): Promise<void> {
		try {
			await SandboxManager.reset();
			await SandboxManager.initialize(runtimeConfig(), askNetwork);
		} catch (e) {
			console.error(`sandbox: reinit failed: ${e}`);
		}
	}

	// ── bash tool ─────────────────────────────────────────────────────────────
	pi.registerTool({
		...localBash,
		label: "bash",
		async execute(id, params, signal, onUpdate, ctx) {
			if (mode !== "sandbox" || !sandboxOn) {
				return localBash.execute(id, params, signal, onUpdate); // prompt mode / disabled: run bare
			}
			const sandboxed = createBashTool(cwd, { operations: sandboxedBashOps(shell) });
			const result = await sandboxed.execute(id, params, signal, onUpdate);

			// Detect an OS-level write block and offer to allow + retry once.
			if (ctx?.hasUI) {
				const text = result.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
				const blocked = blockedWritePath(text);
				if (blocked && !matchesPattern(blocked, loadConfig(cwd).filesystem?.denyWrite ?? [])) {
					const grant = await promptGrant(ctx, `📝 bash write blocked: allow write to "${blocked}"?`);
					if (grant !== "deny") {
						await applyGrant("write", blocked, grant);
						onUpdate?.({ content: [{ type: "text", text: `\n--- write allowed for "${blocked}", retrying ---\n` }], details: undefined });
						const retry = createBashTool(cwd, { operations: sandboxedBashOps(shell) });
						return retry.execute(id, params, signal, onUpdate);
					}
				}
			}
			return result;
		},
	});

	// ── tool_call: fs gates (sandbox) / confirm-everything (prompt) ─────────────
	pi.on("tool_call", async (event, ctx) => {
		if (mode === "prompt") {
			if (isToolCallEventType("read", event)) return confirmOnce(ctx, "read", event.input.path);
			if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) return confirmOnce(ctx, "write", (event.input as { path: string }).path);
			if (isToolCallEventType("bash", event)) return confirmOnce(ctx, "run", event.input.command);
			return;
		}
		if (!sandboxOn) return;

		if (isToolCallEventType("read", event)) {
			const path = canonicalizePath(event.input.path);
			if (matchesPattern(path, effAllowRead())) return;
			const grant = await promptGrant(ctx, `📖 Allow read of "${path}"?`);
			if (grant === "deny") return { block: true, reason: `Sandbox: read denied for "${path}"` };
			await applyGrant("read", path, grant);
			return;
		}

		if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			const path = canonicalizePath((event.input as { path: string }).path);
			const cfg = loadConfig(cwd);
			if (matchesPattern(path, cfg.filesystem?.denyWrite ?? [])) {
				return { block: true, reason: `Sandbox: write denied for "${path}" (in denyWrite)` };
			}
			if (matchesPattern(path, effAllowWrite())) return;
			const grant = await promptGrant(ctx, `📝 Allow write to "${path}"?`);
			if (grant === "deny") return { block: true, reason: `Sandbox: write denied for "${path}"` };
			await applyGrant("write", path, grant);
			return;
		}
	});

	async function confirmOnce(ctx: ExtensionContext, verb: string, target: string): Promise<{ block: true; reason: string } | undefined> {
		if (!ctx.hasUI) return { block: true, reason: `Sandbox (prompt mode): no UI to approve ${verb}` };
		const ok = await ctx.ui.confirm(`Allow ${verb}?`, target);
		return ok ? undefined : { block: true, reason: `Denied ${verb}: ${target}` };
	}

	// ── user_bash (! commands) ──────────────────────────────────────────────────
	pi.on("user_bash", async (event, ctx) => {
		if (mode === "prompt") {
			if (ctx.hasUI && !(await ctx.ui.confirm("Allow run?", event.command))) {
				return { result: { output: "Denied by sandbox (prompt mode).", exitCode: 1, cancelled: false, truncated: false } };
			}
			return;
		}
		if (sandboxOn) return { operations: sandboxedBashOps(shell) };
	});

	// ── lifecycle ───────────────────────────────────────────────────────────────
	pi.on("session_start", async (_e, ctx) => {
		ctxRef = ctx;
		const cfg = loadConfig(cwd);
		mode = cfg.mode ?? "sandbox";

		if (cfg.enabled === false) {
			ctx.ui.notify("Sandbox disabled via config", "info");
			return;
		}
		if (mode === "prompt") {
			ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("warning", "🔓 Prompt mode: every read/edit/bash asks"));
			return;
		}
		if (process.platform !== "darwin" && process.platform !== "linux") {
			ctx.ui.notify(`Sandbox not supported on ${process.platform}`, "warning");
			return;
		}
		try {
			await initSandbox();
			const n = cfg.network?.allowedDomains?.length ?? 0;
			const w = cfg.filesystem?.allowWrite?.length ?? 0;
			ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", `🔒 Sandbox: ${n} domains, ${w} write paths`));
		} catch (err) {
			ctx.ui.notify(`Sandbox init failed: ${err instanceof Error ? err.message : err}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		if (sandboxOn) try { await SandboxManager.reset(); } catch {}
	});

	// ── /sandbox ────────────────────────────────────────────────────────────────
	pi.registerCommand("sandbox", {
		description: "Show sandbox configuration",
		handler: async (_args, ctx) => {
			const cfg = loadConfig(cwd);
			const { globalPath, projectPath } = configPaths(cwd);
			const lines = [
				`Sandbox mode: ${mode}${mode === "sandbox" && !sandboxOn ? " (inactive)" : ""}`,
				`  Global config:  ${globalPath}`,
				`  Project config: ${projectPath}`,
				"",
				"Network:",
				`  Allowed: ${cfg.network?.allowedDomains?.join(", ") || "(none)"}`,
				`  Denied:  ${cfg.network?.deniedDomains?.join(", ") || "(none)"}`,
				...(sessionDomains.size ? [`  Session: ${[...sessionDomains].join(", ")}`] : []),
				"",
				"Filesystem:",
				`  Deny Read:   ${cfg.filesystem?.denyRead?.join(", ") || "(none)"}`,
				`  Allow Read:  ${cfg.filesystem?.allowRead?.join(", ") || "(none)"}`,
				`  Allow Write: ${cfg.filesystem?.allowWrite?.join(", ") || "(none)"}`,
				`  Deny Write:  ${cfg.filesystem?.denyWrite?.join(", ") || "(none)"}`,
				...(sessionRead.length ? [`  Session read:  ${sessionRead.join(", ")}`] : []),
				...(sessionWrite.length ? [`  Session write: ${sessionWrite.join(", ")}`] : []),
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
