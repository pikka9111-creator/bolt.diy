import { describe, expect, it, vi } from 'vitest';
import { ActionRunner } from './action-runner';
import type { BoltShell } from '~/utils/shell';

describe('ActionRunner file actions', () => {
  it('runs file action successfully', async () => {
    const runner = new ActionRunner(() => ({}) as BoltShell);

    const action = {
      artifactId: 'artifact-1',
      messageId: 'message-1',
      actionId: 'action-1',
      action: { type: 'file' as const, filePath: 'src/App.tsx', content: 'export default function App() {}' },
    };

    runner.addAction(action);
    await runner.runAction(action);

    expect(runner.actions.get()['action-1']).toMatchObject({ status: 'complete' });
  });
});

describe('ActionRunner cancellation', () => {
  it('does not start an outgoing server after cancellation while its shell was initializing', async () => {
    vi.useFakeTimers();

    try {
      let ready!: () => void;

      const shellReady = new Promise<void>((resolve) => {
        ready = resolve;
      });

      const executeCommand = vi.fn();

      const runner = new ActionRunner(
        () => ({ ready: () => shellReady, executeCommand, terminal: {}, process: {} }) as unknown as BoltShell,
      );
      const action = {
        artifactId: 'old-project',
        messageId: 'old-message',
        actionId: 'old-server',
        action: { type: 'start' as const, content: 'npm run dev' },
      };

      runner.addAction(action);

      const running = runner.runAction(action);
      await Promise.resolve();
      runner.abortAllActions();
      ready();
      await vi.advanceTimersByTimeAsync(2000);
      await running;

      expect(executeCommand).not.toHaveBeenCalled();
      expect(runner.actions.get()['old-server'].status).toBe('aborted');
    } finally {
      vi.useRealTimers();
    }
  });
});
