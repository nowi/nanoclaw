/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { CONTAINER_IMAGE } from './config.js';
import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** Hostname containers use to reach the host machine. */
export const CONTAINER_HOST_GATEWAY = 'host.docker.internal';

/**
 * Address the credential proxy binds to.
 * Docker Desktop (macOS): 127.0.0.1 — the VM routes host.docker.internal to loopback.
 * Docker (Linux): bind to the docker0 bridge IP so only containers can reach it,
 *   falling back to 0.0.0.0 if the interface isn't found.
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || detectProxyBindHost();

function detectProxyBindHost(): string {
  if (os.platform() === 'darwin') return '127.0.0.1';

  // WSL uses Docker Desktop (same VM routing as macOS) — loopback is correct.
  // Check /proc filesystem, not env vars — WSL_DISTRO_NAME isn't set under systemd.
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';

  // Bare-metal Linux: bind to the docker0 bridge IP instead of 0.0.0.0
  const ifaces = os.networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  return '0.0.0.0';
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      '║  1. Ensure Docker is installed and running                     ║',
    );
    console.error(
      '║  2. Run: docker info                                           ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start');
  }
}

/** Returns true if the agent container image is present locally. */
export function containerImageExists(image: string = CONTAINER_IMAGE): boolean {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} image inspect ${image}`, {
      stdio: 'pipe',
      timeout: 15000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect a container-start failure caused by the image being absent
 * (e.g. swept by `docker system prune`). Matches the runtime's
 * "image not found" / "pull access denied" / "no such image" messages.
 */
export function isMissingImageError(stderr: string): boolean {
  return /Unable to find image|repository does not exist|No such image|manifest( for .*)? unknown|pull access denied/i.test(
    stderr,
  );
}

// Single in-flight build shared across all callers, so concurrent failures
// (multiple groups, startup + a spawn retry) trigger exactly one rebuild.
let buildInFlight: Promise<boolean> | null = null;

/** Rebuild the agent image via container/build.sh. De-duplicated while running. */
export function buildContainerImage(): Promise<boolean> {
  if (buildInFlight) return buildInFlight;

  const buildScript = path.join(process.cwd(), 'container', 'build.sh');
  logger.info({ image: CONTAINER_IMAGE }, 'Building agent container image');

  buildInFlight = new Promise<boolean>((resolve) => {
    const proc = spawn('bash', [buildScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CONTAINER_RUNTIME: CONTAINER_RUNTIME_BIN },
    });
    const log = (data: Buffer) => {
      for (const line of data.toString().trim().split('\n')) {
        if (line) logger.debug({ build: true }, line);
      }
    };
    proc.stdout.on('data', log);
    proc.stderr.on('data', log);
    proc.on('close', (code) => {
      buildInFlight = null;
      if (code === 0) {
        logger.info({ image: CONTAINER_IMAGE }, 'Agent image build complete');
        resolve(true);
      } else {
        logger.error({ code }, 'Agent image build failed');
        resolve(false);
      }
    });
    proc.on('error', (err) => {
      buildInFlight = null;
      logger.error({ err }, 'Agent image build failed to start');
      resolve(false);
    });
  });

  return buildInFlight;
}

/**
 * Ensure the agent image is present, building it if missing.
 * Returns true once the image is available. Safe to call concurrently.
 */
export async function ensureContainerImage(): Promise<boolean> {
  if (containerImageExists()) return true;
  logger.warn(
    { image: CONTAINER_IMAGE },
    'Agent container image missing — rebuilding',
  );
  return buildContainerImage();
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
