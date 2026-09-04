/**
 * Sandbox — OS-level sandboxing for bash + path/network policy for pi's tools.
 *
 * Uses @anthropic-ai/sandbox-runtime (sandbox-exec on macOS, bubblewrap on Linux)
 * to restrict bash. pi's in-process read/write/edit tools bypass the OS sandbox,
 * so they are gated separately in the `tool_call` hook.
 *
 * Two modes (config `mode`, default "sandbox"; switch at runtime with
 * `/sandbox enable` or `/sandbox prompt`):
 *
 *   "sandbox" — OS sandbox on. Network access to hosts outside `allowedDomains`
 *     is prompted at CONNECTION time via the sandbox's request-time ask callback
 *     (accurate — no command regex). read/write/edit are gated against
 *     allowRead/allowWrite/denyWrite. Grants can be kept for the session, the
 *     project, or all projects. Denying a host/path is remembered for the session
 *     (chatty endpoints otherwise re-prompt on every connection). Prompt keys:
 *     a = session, P = project, G = global, d = deny for session, esc = deny once.
 *
 *   "prompt" — NO OS sandbox. The agent can touch anything outside the sandbox,
 *     but every read/edit/write/bash is prompted, every time, with no memory.
 *
 * Config (merged; project overrides global):
 *   ~/.pi/agent/sandbox.json   (global)
 *   <cwd>/.pi/sandbox.json     (project)
 *
 * The bundled patch (patches/) neutralises the library's hardcoded
 * mandatory write-denies: DANGEROUS_FILES / DANGEROUS_DIRECTORIES (which
 * blocked .vscode/.idea/.claude/* and various dotfiles, see issue #159) and
 * the unconditional .git/hooks + .git/config denies (cwd-relative + glob,
 * inconsistent and broken when running from a repo subdirectory).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { BashOperations, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashTool, DynamicBorder, getAgentDir, getShellConfig, isToolCallEventType, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

// ── Config ──────────────────────────────────────────────────────────────────

type Mode = "sandbox" | "prompt";

interface NetworkConfig {
	allowedDomains?: string[];
	deniedDomains?: string[];
	allowLocalBinding?: boolean;
	allowAllUnixSockets?: boolean;
	allowUnixSockets?: string[];
	allowMachLookup?: string[];
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
	enableWeakerNetworkIsolation?: boolean;
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
		enableWeakerNetworkIsolation: o.enableWeakerNetworkIsolation ?? acc.enableWeakerNetworkIsolation,
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
			// The sandbox isolates network via an HTTP(S) proxy (HTTPS_PROXY). Node's
			// fetch/undici ignores that proxy unless NODE_USE_ENV_PROXY=1, so Node-based
			// CLIs (e.g. mcporter MCP calls) get EPERM. Opt them into the proxy here.
			const childEnv = { ...(env ?? process.env) };
			if (childEnv.NODE_USE_ENV_PROXY === undefined) childEnv.NODE_USE_ENV_PROXY = "1";
			return new Promise((resolvePromise, reject) => {
				const child = spawn(shell, [...args, wrapped], { cwd, env: childEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
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

/**
 * Outcome of a grant prompt. "deny" is an explicit choice and may be remembered;
 * "cancel" means the user dismissed the dialog (ESC) and must never be remembered
 * — it blocks the operation at hand and nothing more.
 */
type Grant = "session" | "project" | "global" | "deny" | "cancel";

const isAllow = (g: Grant): g is "session" | "project" | "global" => g === "session" || g === "project" || g === "global";

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const { shell } = getShellConfig();
	// Honor the user's shellCommandPrefix (e.g. "shopt -s expand_aliases"). Core
	// applies it to its own bash tool, but we replace that tool below, so we must
	// thread it through ourselves. user_bash (!) is unaffected — core prepends the
	// prefix before our operations hook runs.
	const shellCommandPrefix = SettingsManager.create(cwd, getAgentDir()).getShellCommandPrefix();
	const localBash = createBashTool(cwd, { commandPrefix: shellCommandPrefix });

	let mode: Mode = "sandbox";
	let sandboxOn = false; // OS sandbox initialised
	let ctxRef: ExtensionContext | null = null;

	// Runtime grants (in-memory, not visible to the agent), on top of config files.
	const sessionDomains = new Set<string>();
	const sessionDeniedDomains = new Set<string>();
	const sessionRead: string[] = [];
	const sessionWrite: string[] = [];
	// Explicit "deny — this session" choices: block without re-prompting.
	const sessionDeniedRead = new Set<string>();
	const sessionDeniedWrite = new Set<string>();

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
	// Each option has a single-key accelerator; ESC is also listed explicitly so
	// the "deny once" escape hatch is discoverable rather than implicit.
	const GRANT_OPTIONS: { grant: Grant; key: string; label: string }[] = [
		{ grant: "session", key: "a", label: "Allow — this session only" },
		{ grant: "project", key: "P", label: "Allow — this project (.pi/sandbox.json)" },
		{ grant: "global", key: "G", label: "Allow — all projects (~/.pi/agent/sandbox.json)" },
		{ grant: "deny", key: "d", label: "Deny — this session" },
		{ grant: "cancel", key: "esc", label: "Deny — just this once" },
	];
	const grantLabel = (o: (typeof GRANT_OPTIONS)[number]) => `${o.label} [${o.key}]`;
	let promptSeq = 0;

	async function promptGrant(ctx: ExtensionContext, title: string): Promise<Grant> {
		// Let alerting extensions know a human is being blocked on (see alerter.ts).
		const attentionKey = `sandbox:${++promptSeq}`;
		pi.events.emit("attention:request", { key: attentionKey, message: title });
		try {
			return await askGrant(ctx, title);
		} finally {
			pi.events.emit("attention:resolve", { key: attentionKey });
		}
	}

	async function askGrant(ctx: ExtensionContext, title: string): Promise<Grant> {
		if (ctx.mode !== "tui") {
			// No custom components (rpc/json/print): fall back to the plain selector.
			const choice = await ctx.ui.select(title, GRANT_OPTIONS.map(grantLabel));
			return GRANT_OPTIONS.find((o) => grantLabel(o) === choice)?.grant ?? "cancel";
		}
		return ctx.ui.custom<Grant>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

			const items: SelectItem[] = GRANT_OPTIONS.map((o) => ({ value: o.grant, label: grantLabel(o) }));
			const list = new SelectList(items, items.length, {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			});
			list.onSelect = (item) => done(item.value as Grant);
			list.onCancel = () => done("cancel");
			container.addChild(list);
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • a/P/G/d shortcuts • esc deny once"), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render: (w) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data) => {
					const hit = GRANT_OPTIONS.find((o) => o.key === data);
					if (hit) {
						done(hit.grant);
						return;
					}
					list.handleInput(data);
					tui.requestRender();
				},
			};
		});
	}

	async function applyGrant(kind: "domain" | "read" | "write", value: string, grant: Grant): Promise<void> {
		if (!isAllow(grant)) return;
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
			enableWeakerNetworkIsolation: cfg.enableWeakerNetworkIsolation,
			network: {
				allowedDomains: effAllowedDomains(),
				deniedDomains: cfg.network?.deniedDomains ?? [],
				allowLocalBinding: cfg.network?.allowLocalBinding,
				allowAllUnixSockets: cfg.network?.allowAllUnixSockets,
				allowUnixSockets: cfg.network?.allowUnixSockets,
				allowMachLookup: cfg.network?.allowMachLookup,
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
		if (sessionDeniedDomains.has(host)) return false;
		const ctx = ctxRef;
		if (!ctx?.hasUI) return false;
		return enqueue(async () => {
			if (domainAllowed(host, effAllowedDomains())) return true; // granted while queued
			if (sessionDeniedDomains.has(host)) return false; // denied while queued
			const grant = await promptGrant(ctx, `🌐 Allow network connection to "${host}"?`);
			if (grant === "deny") {
				// Remember for the session: chatty endpoints (analytics, telemetry) retry
				// constantly and the library asks on every connection.
				sessionDeniedDomains.add(host);
				return false;
			}
			// Dismissed: fail this connection only, so a stray ESC can't blackhole a
			// host for the rest of the session. The next attempt asks again.
			if (grant === "cancel") return false;
			await applyGrant("domain", host, grant);
			return true;
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
			const sandboxed = createBashTool(cwd, { operations: sandboxedBashOps(shell), commandPrefix: shellCommandPrefix });
			const result = await sandboxed.execute(id, params, signal, onUpdate);

			// Detect an OS-level write block and offer to allow + retry once.
			if (ctx?.hasUI) {
				const text = result.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
				const blocked = blockedWritePath(text);
				if (blocked && !sessionDeniedWrite.has(canonicalizePath(blocked)) && !matchesPattern(blocked, loadConfig(cwd).filesystem?.denyWrite ?? [])) {
					const grant = await promptGrant(ctx, `📝 bash write blocked: allow write to "${blocked}"?`);
					if (grant === "deny") sessionDeniedWrite.add(canonicalizePath(blocked));
					if (isAllow(grant)) {
						await applyGrant("write", blocked, grant);
						onUpdate?.({ content: [{ type: "text", text: `\n--- write allowed for "${blocked}", retrying ---\n` }], details: undefined });
						const retry = createBashTool(cwd, { operations: sandboxedBashOps(shell), commandPrefix: shellCommandPrefix });
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
			if (sessionDeniedRead.has(path)) return { block: true, reason: `Sandbox: read denied for "${path}" (denied for this session)` };
			const grant = await promptGrant(ctx, `📖 Allow read of "${path}"?`);
			if (grant === "deny") sessionDeniedRead.add(path);
			if (!isAllow(grant)) return { block: true, reason: `Sandbox: read denied for "${path}"` };
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
			if (sessionDeniedWrite.has(path)) return { block: true, reason: `Sandbox: write denied for "${path}" (denied for this session)` };
			const grant = await promptGrant(ctx, `📝 Allow write to "${path}"?`);
			if (grant === "deny") sessionDeniedWrite.add(path);
			if (!isAllow(grant)) return { block: true, reason: `Sandbox: write denied for "${path}"` };
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
			setModeStatus(ctx);
			return;
		}
		if (process.platform !== "darwin" && process.platform !== "linux") {
			ctx.ui.notify(`Sandbox not supported on ${process.platform}`, "warning");
			return;
		}
		try {
			await initSandbox();
		} catch (err) {
			ctx.ui.notify(`Sandbox init failed: ${err instanceof Error ? err.message : err}`, "error");
		}
		setModeStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (sandboxOn) try { await SandboxManager.reset(); } catch {}
	});

	// ── mode switching ────────────────────────────────────────────────────────
	function setModeStatus(ctx: ExtensionContext): void {
		if (mode === "prompt") {
			ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("warning", "🔓 Prompt mode: every read/edit/bash asks"));
			return;
		}
		if (!sandboxOn) {
			ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("warning", "🔒 Sandbox mode (inactive)"));
			return;
		}
		const cfg = loadConfig(cwd);
		const n = cfg.network?.allowedDomains?.length ?? 0;
		const w = cfg.filesystem?.allowWrite?.length ?? 0;
		ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", `🔒 Sandbox: ${n} domains, ${w} write paths`));
	}

	async function enterSandboxMode(ctx: ExtensionContext): Promise<void> {
		if (process.platform !== "darwin" && process.platform !== "linux") {
			ctx.ui.notify(`Sandbox not supported on ${process.platform}`, "warning");
			return;
		}
		mode = "sandbox";
		if (!sandboxOn) {
			try {
				await initSandbox();
			} catch (err) {
				ctx.ui.notify(`Sandbox init failed: ${err instanceof Error ? err.message : err}`, "error");
				return;
			}
		}
		setModeStatus(ctx);
		ctx.ui.notify("Sandbox mode: OS sandbox on; network & paths gated", "info");
	}

	async function enterPromptMode(ctx: ExtensionContext): Promise<void> {
		mode = "prompt";
		if (sandboxOn) {
			try { await SandboxManager.reset(); } catch {}
			sandboxOn = false;
		}
		setModeStatus(ctx);
		ctx.ui.notify("Prompt mode: no OS sandbox; every read/edit/bash asks", "info");
	}

	function showConfig(ctx: ExtensionContext): void {
		const cfg = loadConfig(cwd);
		const { globalPath, projectPath } = configPaths(cwd);
		const lines = [
			`Sandbox mode: ${mode}${mode === "sandbox" && !sandboxOn ? " (inactive)" : ""}`,
			"  Switch: /sandbox enable | /sandbox prompt",
			`  Global config:  ${globalPath}`,
			`  Project config: ${projectPath}`,
			"",
			"Network:",
			`  Allowed:      ${cfg.network?.allowedDomains?.join(", ") || "(none)"}`,
			`  Denied:       ${cfg.network?.deniedDomains?.join(", ") || "(none)"}`,
			`  Mach lookup:  ${cfg.network?.allowMachLookup?.join(", ") || "(none)"}`,
			...(sessionDomains.size ? [`  Session allowed: ${[...sessionDomains].join(", ")}`] : []),
			...(sessionDeniedDomains.size ? [`  Session denied:  ${[...sessionDeniedDomains].join(", ")}`] : []),
			"",
			"Filesystem:",
			`  Deny Read:   ${cfg.filesystem?.denyRead?.join(", ") || "(none)"}`,
			`  Allow Read:  ${cfg.filesystem?.allowRead?.join(", ") || "(none)"}`,
			`  Allow Write: ${cfg.filesystem?.allowWrite?.join(", ") || "(none)"}`,
			`  Deny Write:  ${cfg.filesystem?.denyWrite?.join(", ") || "(none)"}`,
			...(sessionRead.length ? [`  Session read:  ${sessionRead.join(", ")}`] : []),
			...(sessionWrite.length ? [`  Session write: ${sessionWrite.join(", ")}`] : []),
			...(sessionDeniedRead.size ? [`  Session denied read:  ${[...sessionDeniedRead].join(", ")}`] : []),
			...(sessionDeniedWrite.size ? [`  Session denied write: ${[...sessionDeniedWrite].join(", ")}`] : []),
		];
		ctx.ui.notify(lines.join("\n"), "info");
	}

	// ── /sandbox ────────────────────────────────────────────────────────────────
	pi.registerCommand("sandbox", {
		description: "Show config or switch mode: /sandbox [show|enable|prompt]",
		getArgumentCompletions: (prefix) => {
			const subs = [
				{ value: "show", label: "show", description: "Show current sandbox config" },
				{ value: "enable", label: "enable", description: "Switch to OS sandbox mode" },
				{ value: "prompt", label: "prompt", description: "Switch to prompt-everything mode" },
			];
			const filtered = subs.filter((s) => s.value.startsWith(prefix.trim().toLowerCase()));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().toLowerCase();
			if (sub === "enable" || sub === "sandbox") return enterSandboxMode(ctx);
			if (sub === "prompt") return enterPromptMode(ctx);
			showConfig(ctx);
		},
	});
}
