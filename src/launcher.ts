/**
 * CODESYS launcher — spawns CODESYS with UI and watcher script,
 * tracks process lifecycle, delegates to IPC for command execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, ChildProcess } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { LauncherConfig, LauncherStatus, CodesysState, IpcResult, ScriptExecutor } from './types';
import { IpcClient, DEFAULT_IPC_CONFIG } from './ipc';
import { ScriptManager } from './script-manager';
import { launcherLog } from './logger';

const SESSION_DIR_PREFIX = 'codesys-mcp-persistent';
// Cold first-launch of CODESYS V3.5 SP16 Patch 5 takes ~120s on a bench PC
// before the watcher writes ready.signal. Default was 60s, which landed us
// in 'error' state every time. Override via CODESYS_MCP_READY_TIMEOUT_MS.
const READY_TIMEOUT_MS = Number(process.env.CODESYS_MCP_READY_TIMEOUT_MS) > 0
  ? Number(process.env.CODESYS_MCP_READY_TIMEOUT_MS)
  : 180_000;
const READY_POLL_MS = 500;
const SHUTDOWN_WAIT_MS = 5_000;
const HEALTH_CHECK_INTERVAL_MS = 5_000;
// Stale session threshold: if ready.signal is older than this, refuse to
// adopt even if the PID is alive (the PID may have been recycled by Windows
// to a completely different process after a reboot).
const STALE_SESSION_THRESHOLD_MS = 30_000;
// Sessions older than this get cleaned up on launcher start (disk space).
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export class CodesysLauncher implements ScriptExecutor {
  private config: LauncherConfig;
  private state: CodesysState = 'stopped';
  private pid: number | null = null;
  private sessionId: string | null = null;
  private ipcDir: string | null = null;
  private ipcClient: IpcClient | null = null;
  private process: ChildProcess | null = null;
  private startedAt: number | null = null;
  private lastError: string | null = null;
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private stateChangeCallbacks: Array<(state: CodesysState) => void> = [];

  constructor(config: LauncherConfig) {
    this.config = config;
  }

  /**
   * Scan %TEMP%/codesys-mcp-persistent/ for an existing live session and
   * adopt it. Used at first launch() after an MCP-server restart, where the
   * previous server left a perfectly good CODESYS+watcher running but the
   * fresh CodesysLauncher has no PID recorded. Returns true if a session
   * was adopted (state set to 'ready'), false otherwise.
   *
   * Adoption rules:
   *   - The session's ready.signal must exist and parse as JSON.
   *   - The PID recorded in ready.signal must still be alive.
   *   - The recorded profile must match config.profileName (skip if mismatched).
   *   - When multiple candidates exist, prefer the most-recently-modified
   *     ready.signal (newest live session).
   */
  private async tryAdoptExistingSession(): Promise<boolean> {
    try {
      const sessionsRoot = path.join(os.tmpdir(), SESSION_DIR_PREFIX);
      if (!fs.existsSync(sessionsRoot)) return false;
      // Janitor: remove session dirs older than SESSION_MAX_AGE_MS.
      const allEntries = fs.readdirSync(sessionsRoot, { withFileTypes: true });
      for (const ent of allEntries) {
        if (!ent.isDirectory()) continue;
        const dir = path.join(sessionsRoot, ent.name);
        try {
          const stat = fs.statSync(dir);
          if (Date.now() - stat.mtimeMs > SESSION_MAX_AGE_MS) {
            launcherLog.info(`Cleaning up old session: ${ent.name}`);
            fs.rmSync(dir, { recursive: true, force: true });
          }
        } catch { /* skip if we can't stat/remove */ }
      }
      // Re-scan remaining dirs for adoption candidates.
      const entries = fs.readdirSync(sessionsRoot, { withFileTypes: true });
      const candidates: Array<{ dir: string; pid: number; sig: string; mtime: number }> = [];
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const dir = path.join(sessionsRoot, ent.name);
        const sigPath = path.join(dir, 'ready.signal');
        if (!fs.existsSync(sigPath)) continue;
        let parsed: { pid?: number; python_version?: string } = {};
        try {
          parsed = JSON.parse(fs.readFileSync(sigPath, 'utf-8'));
        } catch {
          continue; // malformed ready.signal — skip
        }
        if (typeof parsed.pid !== 'number') continue;
        // Profile gate: ready.signal records python_version including the
        // profile string. Require config.profileName to appear in it.
        if (parsed.python_version && this.config.profileName &&
            !parsed.python_version.includes(this.config.profileName)) {
          continue;
        }
        // Liveness check. Only ESRCH (no such process) means truly dead.
        // EPERM / EACCES means the process exists but we can't query it --
        // that's still alive enough to adopt.
        try { process.kill(parsed.pid, 0); } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code === 'ESRCH') continue;
        }
        // Timestamp freshness check. On Windows, a PID from a previous boot
        // may have been recycled to a completely different process, making
        // the kill(0) check above pass for a non-CODESYS process.  Reject
        // sessions whose ready.signal is older than STALE_SESSION_THRESHOLD.
        const mtime = fs.statSync(sigPath).mtimeMs;
        const age = Date.now() - mtime;
        if (age > STALE_SESSION_THRESHOLD_MS) {
          launcherLog.info(`Skipping stale session ${ent.name}: ready.signal age ${age}ms > ${STALE_SESSION_THRESHOLD_MS}ms`);
          continue;
        }
        candidates.push({ dir, pid: parsed.pid, sig: sigPath, mtime });
      }
      if (candidates.length === 0) return false;
      candidates.sort((a, b) => b.mtime - a.mtime);
      const chosen = candidates[0];
      launcherLog.info(`Adopting existing session: PID ${chosen.pid} dir ${chosen.dir}`);
      this.sessionId = path.basename(chosen.dir);
      this.ipcDir = chosen.dir;
      this.ipcClient = new IpcClient({ baseDir: this.ipcDir, ...DEFAULT_IPC_CONFIG });
      await this.ipcClient.ensureDirectories();
      this.pid = chosen.pid;
      this.process = null; // we didn't spawn it; no ChildProcess handle
      this.startedAt = chosen.mtime;
      this.lastError = null;
      this.setState('ready');
      this.startHealthMonitor();
      return true;
    } catch (err) {
      launcherLog.warn(`Adoption scan failed: ${err}`);
      return false;
    }
  }

  /** Launch CODESYS with UI and watcher script */
  async launch(): Promise<void> {
    if (this.state === 'ready' || this.state === 'launching') {
      launcherLog.warn(`Cannot launch: state is ${this.state}`);
      return;
    }

    // First: try to adopt an existing live session left by a previous MCP
    // server process. This closes out the "orphan CODESYS on MCP restart"
    // problem — without it, a /mcp reconnect spawns a second CODESYS on top
    // of the live one and they fight for project lockfiles. Only runs on a
    // genuinely fresh launcher (no PID recorded yet); after that the
    // error-recovery path below handles same-process retries.
    if (this.pid === null && this.state === 'stopped') {
      if (await this.tryAdoptExistingSession()) {
        return;
      }
    }

    // Recovery path: we previously timed out, but the CODESYS process the
    // launcher spawned is still alive and its watcher has now written
    // ready.signal (or is about to). Re-attach rather than spawning a fresh
    // CODESYS on top — two instances would fight for project lockfiles. Cold
    // SP16 P5 launches frequently exceed the historical 60s budget, so this
    // path also covers the "MCP gave up too early" case independently of the
    // timeout bump above.
    if (this.state === 'error' && this.pid !== null && this.ipcDir && this.ipcClient) {
      const stillAlive = this.isRunning();
      if (stillAlive) {
        const readyNow = await this.ipcClient.isReady();
        if (readyNow) {
          launcherLog.info(`Recovery: live PID ${this.pid} watcher already ready; attaching`);
          this.lastError = null;
          if (this.startedAt === null) this.startedAt = Date.now();
          this.setState('ready');
          this.startHealthMonitor();
          return;
        }
        launcherLog.warn(`Recovery: PID ${this.pid} alive but watcher not ready yet — polling without respawn`);
        this.setState('launching');
        const recoverStart = Date.now();
        while (Date.now() - recoverStart < READY_TIMEOUT_MS) {
          if (await this.ipcClient.isReady()) {
            this.lastError = null;
            if (this.startedAt === null) this.startedAt = Date.now();
            this.setState('ready');
            launcherLog.info('CODESYS watcher is ready (recovery path)');
            this.startHealthMonitor();
            return;
          }
          await this.sleep(READY_POLL_MS);
        }
        this.lastError = `Recovery: PID ${this.pid} still no ready.signal after ${READY_TIMEOUT_MS}ms`;
        this.setState('error');
        throw new Error(this.lastError);
      }
      // Recorded PID is dead — clear it and fall through to a fresh spawn.
      launcherLog.info(`Recovery: PID ${this.pid} no longer alive; spawning fresh`);
      this.pid = null;
      this.process = null;
    }

    // Validate CODESYS exe exists
    if (!fs.existsSync(this.config.codesysPath)) {
      const err = `CODESYS executable not found: ${this.config.codesysPath}`;
      this.setState('error');
      this.lastError = err;
      throw new Error(err);
    }

    // Optional: kill any pre-existing CODESYS.exe before launching. This is
    // only useful in dev to clean up after an MCP server restart that left
    // the old CODESYS detached and holding a project lock. It is OFF by
    // default because killing an unrelated CODESYS instance the user is
    // working in would lose unsaved work. Opt in with --kill-existing-codesys.
    if (this.config.killExistingCodesys === true && process.platform === 'win32') {
      try {
        const { execSync } = require('child_process');
        const exeBase = path.basename(this.config.codesysPath);
        try {
          execSync(`taskkill /F /T /IM "${exeBase}"`, { timeout: 10_000, stdio: 'ignore' });
          launcherLog.info(`Killed pre-existing ${exeBase} processes (opted-in via --kill-existing-codesys).`);
          await this.sleep(2_000);
        } catch {
          // Most common failure: no process found. That's the normal case.
        }
      } catch (killErr) {
        launcherLog.warn(`Pre-launch kill skipped: ${killErr}`);
      }
    }

    this.setState('launching');
    this.sessionId = uuidv4();
    this.ipcDir = path.join(os.tmpdir(), SESSION_DIR_PREFIX, this.sessionId);

    launcherLog.info(`Session ${this.sessionId} — IPC dir: ${this.ipcDir}`);

    // Create IPC client and directories
    this.ipcClient = new IpcClient({
      baseDir: this.ipcDir,
      ...DEFAULT_IPC_CONFIG,
    });
    await this.ipcClient.ensureDirectories();

    // Prepare watcher script with interpolated IPC path. ScriptManager.
    // interpolate() now Python-escapes the value, so no manual pre-escape.
    const scriptManager = new ScriptManager();
    const watcherTemplate = scriptManager.loadTemplate('watcher');
    const watcherContent = scriptManager.interpolate(watcherTemplate, {
      IPC_BASE_DIR: this.ipcDir,
    });

    // Write interpolated watcher to IPC directory
    const watcherPath = path.join(this.ipcDir, 'watcher.py');
    fs.writeFileSync(watcherPath, watcherContent, 'utf-8');

    const codesysDir = path.dirname(this.config.codesysPath);

    // Use `start` (ShellExecuteEx) so Windows shows UAC elevation prompt
    // when the CODESYS executable requires admin. Build as a single command
    // string with shell:true so cmd.exe parses quotes natively — passing
    // quoted paths in an argv array with shell:false mangles nested quotes
    // on Windows ("\"C:\Program...\" becomes broken).
    const quotedExe = `"${this.config.codesysPath}"`;
    const profileArg = `--profile="${this.config.profileName}"`;
    const scriptArg = `--runscript="${watcherPath}"`;
    const fullCommand = `start "" ${quotedExe} ${profileArg} ${scriptArg}`;

    launcherLog.info(`Spawning: ${fullCommand}`);

    this.process = spawn(fullCommand, [], {
      detached: true,
      shell: true,
      windowsHide: false,
      stdio: 'ignore',
      cwd: codesysDir,
    });

    this.pid = this.process.pid ?? null;
    this.process.unref();

    launcherLog.info(`CODESYS launcher spawned with PID ${this.pid} (shell PID for cmd.exe)`);

    // Handle process errors
    this.process.on('error', (err: NodeJS.ErrnoException) => {
      launcherLog.error(`CODESYS spawn error: ${err.message} (code=${err.code})`);
      this.lastError = `CODESYS spawn failed: ${err.message} (${err.code})`;
      this.pid = null;
      this.process = null;
      this.setState('error');
    });

    // The shell (cmd.exe) exits quickly after launching CODESYS via start.
    // Don't treat this as an error when we're still in 'launching' state.
    this.process.on('exit', (code) => {
      launcherLog.info(`Launcher shell exited with code ${code} (state=${this.state})`);
      if (this.state !== 'launching' && this.state !== 'stopping') {
        this.lastError = `CODESYS exited unexpectedly (code ${code})`;
        this.setState('error');
      }
      this.pid = null;
      this.process = null;
    });

    // Poll for ready.signal
    const readyStart = Date.now();
    while (Date.now() - readyStart < READY_TIMEOUT_MS) {
      if (await this.ipcClient.isReady()) {
        // Read the real CODESYS PID from ready.signal (the watcher writes
        // os.getpid() which is the CODESYS.exe PID). The shell PID we got
        // from spawn() is cmd.exe, which exits before ready.signal arrives.
        try {
          const sigPath = path.join(this.ipcDir!, 'ready.signal');
          const sigContent = fs.readFileSync(sigPath, 'utf-8');
          const sig = JSON.parse(sigContent);
          if (typeof sig.pid === 'number') {
            this.pid = sig.pid;
            launcherLog.info(`Real CODESYS PID from ready.signal: ${this.pid}`);
          }
        } catch (readErr) {
          launcherLog.warn(`Could not read PID from ready.signal: ${readErr}`);
        }
        this.setState('ready');
        this.startedAt = Date.now();
        launcherLog.info('CODESYS watcher is ready');
        this.startHealthMonitor();
        return;
      }
      await this.sleep(READY_POLL_MS);
    }

    // Timeout — watcher never signaled ready
    this.lastError = `Watcher did not signal ready within ${READY_TIMEOUT_MS}ms`;
    this.setState('error');
    throw new Error(this.lastError);
  }

  /** Graceful shutdown */
  async shutdown(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'stopping') return;

    this.setState('stopping');
    this.stopHealthMonitor();

    // Try to close projects and quit CODESYS gracefully via script
    if (this.ipcClient && this.state !== 'error') {
      try {
        launcherLog.info('Sending quit script to close projects and exit CODESYS...');
        await this.ipcClient.sendCommand(`
import sys
try:
    import scriptengine as se
    # Close all open projects without saving (save should be done before shutdown)
    for p in list(se.projects):
        try:
            p.close()
        except:
            pass
    print("Projects closed")
except:
    pass
# Request CODESYS to quit
try:
    import scriptengine as se
    se.system.exit()
except:
    pass
print("SCRIPT_SUCCESS")
sys.exit(0)
`, 10_000);
      } catch {
        launcherLog.debug('Quit script timed out or failed (expected if CODESYS exits)');
      }
    }

    // Send terminate signal to watcher
    if (this.ipcClient) {
      try {
        await this.ipcClient.sendTerminate();
      } catch {
        launcherLog.warn('Failed to send terminate signal');
      }
    }

    // Wait for process exit
    if (this.pid !== null) {
      const waitStart = Date.now();
      while (Date.now() - waitStart < SHUTDOWN_WAIT_MS) {
        if (!this.isRunning()) break;
        await this.sleep(500);
      }

      // Force kill if still alive
      if (this.isRunning() && this.pid !== null) {
        launcherLog.warn('Force-killing CODESYS process');
        try {
          // On Windows, use taskkill for reliable process termination
          if (process.platform === 'win32') {
            const { execSync } = require('child_process');
            try {
              // First try graceful close (WM_CLOSE)
              execSync(`taskkill /PID ${this.pid}`, { timeout: 5000, stdio: 'ignore' });
              await this.sleep(3_000);
            } catch { /* ignore */ }
            if (this.isRunning()) {
              // Force kill
              try {
                execSync(`taskkill /F /PID ${this.pid}`, { timeout: 5000, stdio: 'ignore' });
              } catch { /* ignore */ }
            }
          } else if (this.process) {
            this.process.kill('SIGTERM');
            await this.sleep(2_000);
            if (this.isRunning() && this.process) {
              this.process.kill('SIGKILL');
            }
          }
        } catch {
          launcherLog.warn('Failed to kill CODESYS process');
        }
      }
    }

    // Clean up IPC directory
    if (this.ipcClient) {
      await this.ipcClient.cleanup();
    }

    this.pid = null;
    this.process = null;
    this.ipcClient = null;
    this.setState('stopped');
    launcherLog.info('Shutdown complete');
  }

  /** Execute a script through the IPC channel */
  async executeScript(content: string, timeoutMs?: number): Promise<IpcResult> {
    if (this.state !== 'ready' || !this.ipcClient) {
      throw new Error(`Cannot execute script: launcher state is '${this.state}'`);
    }
    return this.ipcClient.sendCommand(content, timeoutMs);
  }

  /** Get current launcher status */
  getStatus(): LauncherStatus {
    return {
      state: this.state,
      pid: this.pid,
      sessionId: this.sessionId,
      ipcDir: this.ipcDir,
      startedAt: this.startedAt,
      lastError: this.lastError,
    };
  }

  /** Check if the CODESYS process is still alive */
  isRunning(): boolean {
    if (this.pid === null) return false;
    try {
      process.kill(this.pid, 0); // Signal 0 = test if process exists
      return true;
    } catch (err: unknown) {
      // On Windows, process.kill(pid, 0) may throw EPERM even when the
      // process is alive (e.g. GUI processes in a different session).
      // Only ESRCH (process not found) means truly dead.
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
      // EPERM, EACCES, or any other error -> process exists, assume alive.
      return true;
    }
  }

  /** Register callback for state changes */
  onStateChange(callback: (state: CodesysState) => void): void {
    this.stateChangeCallbacks.push(callback);
  }

  private setState(state: CodesysState): void {
    const prev = this.state;
    this.state = state;
    if (prev !== state) {
      launcherLog.info(`State: ${prev} -> ${state}`);
      for (const cb of this.stateChangeCallbacks) {
        try { cb(state); } catch { /* ignore callback errors */ }
      }
    }
  }

  private startHealthMonitor(): void {
    this.healthInterval = setInterval(() => {
      if (this.state === 'ready' && !this.isRunning()) {
        launcherLog.error('Health check: CODESYS process died');
        this.lastError = 'CODESYS process died unexpectedly';
        this.pid = null;
        this.process = null;
        this.setState('error');
        this.stopHealthMonitor();
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  private stopHealthMonitor(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
