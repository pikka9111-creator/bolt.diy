import { describe, expect, it, vi } from 'vitest';
import { BoltShell } from './shell';
import type { ITerminal } from '~/types/terminal';

describe('BoltShell.stop', () => {
  it('interrupts the server and waits for its exit before completing a reset', async () => {
    const shell = new BoltShell();
    const input = vi.fn();
    const abort = vi.fn();

    let finishCommand!: () => void;

    const executionPrms = new Promise<void>((resolve) => {
      finishCommand = resolve;
    });

    vi.spyOn(shell, 'terminal', 'get').mockReturnValue({ input } as unknown as ITerminal);
    shell.executionState.set({ sessionId: 'old-chat', active: true, executionPrms, abort });

    let stopped = false;

    const stopping = shell.stop().then(() => {
      stopped = true;
    });

    await Promise.resolve();
    expect(abort).toHaveBeenCalledOnce();
    expect(input).toHaveBeenCalledWith('\x03');
    expect(stopped).toBe(false);

    finishCommand();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('returns immediately when there is no active command', async () => {
    const shell = new BoltShell();
    await expect(shell.stop()).resolves.toBeUndefined();
  });

  it('does not interrupt the incoming chat when the outgoing session has already changed', async () => {
    const shell = new BoltShell();
    const input = vi.fn();
    const abort = vi.fn();

    vi.spyOn(shell, 'terminal', 'get').mockReturnValue({ input } as unknown as ITerminal);
    shell.executionState.set({ sessionId: 'incoming-chat', active: true, abort });

    await shell.stop('outgoing-chat');

    expect(input).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
  });
});
