// ============================================================================
// OpenClaw Monitor - System Resource Collector
// Gathers CPU, memory, disk, temperature, and network statistics.
// Uses OS-level APIs and shell commands to read real-time system metrics.
// CPU usage is calculated via delta between two samples to avoid the
// always-zero problem of instantaneous reads.
// ============================================================================

import os from 'os';
import { execFileSync } from 'child_process';
import type { SystemStats, CpuStats, MemoryStats, DiskStats, TemperatureStats, NetworkStats } from './types.js';

/** Snapshot of per-core CPU times used for delta calculation */
interface CpuTimesSnapshot {
  idle: number;
  total: number;
}

/** Raw network byte counters with a timestamp for rate calculation */
interface NetworkSnapshot {
  rx: number;
  tx: number;
  time: number;
}

export class SystemCollector {
  // Previous CPU snapshot for delta-based usage calculation
  private prevCpuSnapshots: CpuTimesSnapshot[] | null = null;

  // Previous network byte counters for throughput calculation
  private prevNetworkSnapshot: NetworkSnapshot | null = null;

  /**
   * Collect a full snapshot of system resource statistics.
   * On the very first call, CPU usage will be 0% because there is no
   * previous snapshot to compare against. Subsequent calls produce
   * accurate delta-based values.
   */
  async collect(): Promise<SystemStats> {
    const cpu = this.getCpuUsage();
    const memory = this.getMemory();
    const disk = this.getDisk();
    const temperature = this.getTemperature();
    const network = this.getNetwork();
    const uptime = os.uptime();

    return { cpu, memory, disk, temperature, network, uptime };
  }

  // --------------------------------------------------------------------------
  // CPU
  // --------------------------------------------------------------------------

  /**
   * Calculate CPU usage by comparing the current os.cpus() snapshot with the
   * previous one. Each core's idle/total time delta gives per-core usage, and
   * the overall usage is the average across all cores.
   *
   * On the first invocation there is no previous snapshot, so usage is reported
   * as 0%. The caller should invoke collect() at a regular interval (e.g. 2s)
   * so subsequent readings are accurate.
   */
  private getCpuUsage(): CpuStats {
    const cpus = os.cpus();
    const currentSnapshots: CpuTimesSnapshot[] = cpus.map((cpu) => {
      const times = cpu.times;
      const total = times.user + times.nice + times.sys + times.irq + times.idle;
      return { idle: times.idle, total };
    });

    let perCore: number[] = new Array(cpus.length).fill(0);
    let overallUsage = 0;

    if (this.prevCpuSnapshots && this.prevCpuSnapshots.length === currentSnapshots.length) {
      // Compute per-core usage from the delta of idle vs total ticks
      perCore = currentSnapshots.map((curr, i) => {
        const prev = this.prevCpuSnapshots![i];
        const idleDelta = curr.idle - prev.idle;
        const totalDelta = curr.total - prev.total;
        if (totalDelta === 0) return 0;
        return Math.round(((totalDelta - idleDelta) / totalDelta) * 100 * 100) / 100;
      });
      overallUsage = Math.round((perCore.reduce((sum, v) => sum + v, 0) / perCore.length) * 100) / 100;
    }

    // Store snapshot for the next delta calculation
    this.prevCpuSnapshots = currentSnapshots;

    return {
      usage: overallUsage,
      cores: cpus.length,
      perCore,
    };
  }

  // --------------------------------------------------------------------------
  // Memory
  // --------------------------------------------------------------------------

  /**
   * Read total and free memory from the Node.js os module and compute usage.
   * Values are reported in gigabytes, rounded to two decimal places.
   */
  private getMemory(): MemoryStats {
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    const usedBytes = totalBytes - freeBytes;

    const totalGB = Math.round((totalBytes / (1024 ** 3)) * 100) / 100;
    const usedGB = Math.round((usedBytes / (1024 ** 3)) * 100) / 100;
    const usagePercent = Math.round((usedBytes / totalBytes) * 100 * 100) / 100;

    return { usagePercent, usedGB, totalGB };
  }

  // --------------------------------------------------------------------------
  // Disk
  // --------------------------------------------------------------------------

  /**
   * Parse the output of `df -k /` to determine root filesystem disk usage.
   * Falls back to zeros if the command fails (e.g. on unsupported platforms).
   *
   * Example `df -k /` output:
   *   Filesystem  1024-blocks     Used Available Capacity  Mounted on
   *   /dev/disk1  976490576  453826124  522664452    47%    /
   */
  private getDisk(): DiskStats {
    try {
      const output = execFileSync('df', ['-k', '/'], { encoding: 'utf-8', timeout: 5000 });
      const lines = output.trim().split('\n');

      // The data line may be at index 1 or later; find the first line with numeric data
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].trim().split(/\s+/);
        // Expect: filesystem, 1K-blocks, used, available, capacity%, mount
        if (parts.length >= 5) {
          const totalKB = parseInt(parts[1], 10);
          const usedKB = parseInt(parts[2], 10);
          const availableKB = parseInt(parts[3], 10);
          if (!isNaN(totalKB) && !isNaN(usedKB) && totalKB > 0) {
            const totalGB = Math.round((totalKB / (1024 ** 2)) * 100) / 100;
            const usedGB = Math.round((usedKB / (1024 ** 2)) * 100) / 100;
            // Use Used/(Used+Available) to account for APFS/ZFS reserved space
            const effectiveTotal = !isNaN(availableKB) ? usedKB + availableKB : totalKB;
            const usagePercent = Math.round((usedKB / effectiveTotal) * 100 * 100) / 100;
            return { usagePercent, usedGB, totalGB };
          }
        }
      }
    } catch {
      // Command failed or timed out; return safe defaults
    }

    return { usagePercent: 0, usedGB: 0, totalGB: 0 };
  }

  // --------------------------------------------------------------------------
  // Temperature
  // --------------------------------------------------------------------------

  /**
   * Attempt to read CPU temperature on macOS.
   *
   * Strategy:
   * 1. Try the `osx-cpu-temp` CLI if installed (brew install osx-cpu-temp).
   * 2. Fallback: estimate temperature based on CPU usage.
   *    - Idle (~0% usage) maps to ~40 C
   *    - Full load (~100% usage) maps to ~95 C
   *    This is a rough heuristic but still useful for trend visualisation.
   */
  private getTemperature(): TemperatureStats {
    // Attempt: osx-cpu-temp CLI (brew install osx-cpu-temp)
    try {
      const output = execFileSync('osx-cpu-temp', [], {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const match = output.match(/([\d.]+)\s*°?C/);
      if (match) {
        return { cpu: parseFloat(match[1]) };
      }
    } catch {
      // Not available, fall through to estimation
    }

    // Fallback: estimate from CPU usage (linear interpolation between 40-95 C)
    const cpuUsage = this.prevCpuSnapshots
      ? this.estimateCurrentCpuUsage()
      : 0;
    const estimated = Math.round((40 + (cpuUsage / 100) * 55) * 10) / 10;
    return { cpu: estimated };
  }

  /**
   * Quick CPU usage estimate from the stored snapshot (used only for temp fallback).
   * This does NOT consume a snapshot; it reads the current os.cpus() against the
   * stored previous values.
   */
  private estimateCurrentCpuUsage(): number {
    if (!this.prevCpuSnapshots) return 0;
    const cpus = os.cpus();
    let totalUsage = 0;
    for (let i = 0; i < cpus.length && i < this.prevCpuSnapshots.length; i++) {
      const times = cpus[i].times;
      const total = times.user + times.nice + times.sys + times.irq + times.idle;
      const prev = this.prevCpuSnapshots[i];
      const idleDelta = times.idle - prev.idle;
      const totalDelta = total - prev.total;
      if (totalDelta > 0) {
        totalUsage += (totalDelta - idleDelta) / totalDelta;
      }
    }
    return (totalUsage / cpus.length) * 100;
  }

  // --------------------------------------------------------------------------
  // Network
  // --------------------------------------------------------------------------

  /**
   * Calculate network throughput (upload/download) in MB/s by reading cumulative
   * byte counters and computing the delta since the last call.
   *
   * On macOS, `netstat -ib` provides per-interface byte counters.
   * On Linux, /proc/net/dev is parsed instead.
   *
   * The first call returns 0 MB/s because there is no previous snapshot.
   */
  private getNetwork(): NetworkStats {
    const currentSnapshot = this.readNetworkBytes();

    let uploadMBps = 0;
    let downloadMBps = 0;

    if (this.prevNetworkSnapshot && currentSnapshot) {
      const timeDelta = (currentSnapshot.time - this.prevNetworkSnapshot.time) / 1000; // seconds
      if (timeDelta > 0) {
        const rxDelta = currentSnapshot.rx - this.prevNetworkSnapshot.rx;
        const txDelta = currentSnapshot.tx - this.prevNetworkSnapshot.tx;
        // Convert bytes/sec to MB/sec
        downloadMBps = Math.round((rxDelta / timeDelta / (1024 * 1024)) * 100) / 100;
        uploadMBps = Math.round((txDelta / timeDelta / (1024 * 1024)) * 100) / 100;
        // Guard against negative values (counter reset, interface change)
        if (downloadMBps < 0) downloadMBps = 0;
        if (uploadMBps < 0) uploadMBps = 0;
      }
    }

    if (currentSnapshot) {
      this.prevNetworkSnapshot = currentSnapshot;
    }

    return { uploadMBps, downloadMBps };
  }

  /**
   * Read the total received (rx) and transmitted (tx) bytes across all active
   * network interfaces by parsing OS-specific commands.
   */
  private readNetworkBytes(): NetworkSnapshot | null {
    const platform = os.platform();

    try {
      if (platform === 'darwin') {
        return this.readNetworkBytesMacOS();
      } else if (platform === 'linux') {
        return this.readNetworkBytesLinux();
      }
    } catch {
      // Parsing failed; return null so we skip this sample
    }

    return null;
  }

  /**
   * macOS: Parse `netstat -ib` to sum byte counters across physical interfaces.
   * We skip loopback (lo0) and only count interfaces that have non-zero bytes.
   *
   * Example output line:
   *   en0   1500  <Link#4>  ...  123456789  0  987654321  0
   *   The Ibytes column (index 6) and Obytes column (index 9) are what we need.
   */
  private readNetworkBytesMacOS(): NetworkSnapshot | null {
    const output = execFileSync('netstat', ['-ib'], { encoding: 'utf-8', timeout: 5000 });
    const lines = output.trim().split('\n');

    let totalRx = 0;
    let totalTx = 0;
    // Track which interfaces we've already counted (netstat may list duplicates)
    const seen = new Set<string>();

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].trim().split(/\s+/);
      // Skip loopback and non-Link entries
      if (parts.length < 10) continue;
      if (parts[0].startsWith('lo')) continue;
      if (!parts[2].startsWith('<Link')) continue;

      const ifaceName = parts[0];
      if (seen.has(ifaceName)) continue;
      seen.add(ifaceName);

      const ibytes = parseInt(parts[6], 10);
      const obytes = parseInt(parts[9], 10);
      if (!isNaN(ibytes)) totalRx += ibytes;
      if (!isNaN(obytes)) totalTx += obytes;
    }

    return { rx: totalRx, tx: totalTx, time: Date.now() };
  }

  /**
   * Linux: Parse /proc/net/dev to sum byte counters across all non-loopback interfaces.
   *
   * Example /proc/net/dev line:
   *   eth0: 123456 100 0 0 0 0 0 0  654321 80 0 0 0 0 0 0
   *   Fields after the colon: rx_bytes rx_packets ... tx_bytes tx_packets ...
   */
  private readNetworkBytesLinux(): NetworkSnapshot | null {
    const output = execFileSync('cat', ['/proc/net/dev'], { encoding: 'utf-8', timeout: 5000 });
    const lines = output.trim().split('\n');

    let totalRx = 0;
    let totalTx = 0;

    // Skip the first two header lines
    for (let i = 2; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('lo:')) continue;

      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;

      const values = line.substring(colonIdx + 1).trim().split(/\s+/);
      if (values.length >= 9) {
        const rxBytes = parseInt(values[0], 10);
        const txBytes = parseInt(values[8], 10);
        if (!isNaN(rxBytes)) totalRx += rxBytes;
        if (!isNaN(txBytes)) totalTx += txBytes;
      }
    }

    return { rx: totalRx, tx: totalTx, time: Date.now() };
  }
}
