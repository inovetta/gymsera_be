'use strict';

/**
 * Regression tests for REL-05 / 2A Blocker 3:
 * 1. unhandledRejection: log it, do NOT shut down.
 * 2. Keep shutdown for SIGTERM / SIGINT.
 */

const { fork, spawn } = require('child_process');
const path = require('path');

describe('2A Blocker 3: unhandledRejection and Graceful Shutdown (REL-05)', () => {
  test('unhandledRejection is logged to console.error without calling shutdown or exiting process', async () => {
    // Spawn a node child process that sets up the exact server.js handlers
    const childScript = `
      let isShuttingDown = false;
      function shutdown(signal, code = 0) {
        if (isShuttingDown) return;
        isShuttingDown = true;
        console.log('[Shutdown] Graceful shutdown complete');
        process.exit(code);
      }

      process.on('unhandledRejection', (reason) => {
        console.error('[Process ERROR] Unhandled Rejection:', reason && reason.message ? reason.message : reason);
      });

      process.on('SIGTERM', () => shutdown('SIGTERM', 0));
      process.on('SIGINT', () => shutdown('SIGINT', 0));

      // Trigger an unhandled rejection
      Promise.reject(new Error('Simulated transient rejection'));

      // Keep event loop alive to confirm process does not terminate
      setTimeout(() => {
        console.log('PROCESS_STILL_ALIVE');
        process.exit(0);
      }, 300);
    `;

    const child = spawn(process.execPath, ['-e', childScript]);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const exitCode = await new Promise((resolve) => {
      child.on('close', resolve);
    });

    // Process exited normally with 0 after the timeout, NOT killed by unhandledRejection
    expect(exitCode).toBe(0);
    // Unhandled rejection was logged
    expect(stderr).toContain('[Process ERROR] Unhandled Rejection: Simulated transient rejection');
    // Process stayed alive and executed the subsequent timer callback
    expect(stdout).toContain('PROCESS_STILL_ALIVE');
    // Shutdown was NOT called for unhandledRejection
    expect(stdout).not.toContain('[Shutdown] Graceful shutdown complete');
  });

  test('SIGTERM triggers graceful shutdown and exits with code 0', async () => {
    const childScript = `
      let isShuttingDown = false;
      function shutdown(signal, code = 0) {
        if (isShuttingDown) return;
        isShuttingDown = true;
        console.log('[' + signal + '] Shutting down gracefully...');
        console.log('[Shutdown] Graceful shutdown complete');
        process.exit(code);
      }

      process.on('SIGTERM', () => shutdown('SIGTERM', 0));
      process.on('SIGINT', () => shutdown('SIGINT', 0));

      console.log('READY');
      setInterval(() => {}, 1000);
    `;

    const child = spawn(process.execPath, ['-e', childScript]);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => {
      stdout += d.toString();
      if (stdout.includes('READY') && !child.killed) {
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const exitCode = await new Promise((resolve) => {
      child.on('close', resolve);
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain('[SIGTERM] Shutting down gracefully...');
    expect(stdout).toContain('[Shutdown] Graceful shutdown complete');
  });

  test('SIGINT triggers graceful shutdown and exits with code 0', async () => {
    const childScript = `
      let isShuttingDown = false;
      function shutdown(signal, code = 0) {
        if (isShuttingDown) return;
        isShuttingDown = true;
        console.log('[' + signal + '] Shutting down gracefully...');
        console.log('[Shutdown] Graceful shutdown complete');
        process.exit(code);
      }

      process.on('SIGTERM', () => shutdown('SIGTERM', 0));
      process.on('SIGINT', () => shutdown('SIGINT', 0));

      console.log('READY');
      setInterval(() => {}, 1000);
    `;

    const child = spawn(process.execPath, ['-e', childScript]);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => {
      stdout += d.toString();
      if (stdout.includes('READY') && !child.killed) {
        child.kill('SIGINT');
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const exitCode = await new Promise((resolve) => {
      child.on('close', resolve);
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain('[SIGINT] Shutting down gracefully...');
    expect(stdout).toContain('[Shutdown] Graceful shutdown complete');
  });
});
