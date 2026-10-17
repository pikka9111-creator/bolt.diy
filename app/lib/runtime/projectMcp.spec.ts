import { atom } from 'nanostores';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { writeToBoltTerminal, toggleTerminal, readFile, saveFileContent, createFile } = vi.hoisted(() => ({
  writeToBoltTerminal: vi.fn(),
  toggleTerminal: vi.fn(),
  readFile: vi.fn(),
  saveFileContent: vi.fn(),
  createFile: vi.fn(),
}));
vi.mock('~/lib/persistence/useChatHistory', () => ({ chatId: atom('command-test') }));
vi.mock('~/lib/stores/workbench', () => ({
  workbenchStore: {
    projectGeneration: atom(1),
    previews: atom([]),
    files: atom({}),
    saveFileContent,
    createFile,
    isFolderLocked: () => ({ isLocked: false }),
    isFileLocked: () => ({ locked: false }),
    queueProjectMutation: (operation: () => Promise<unknown>) => operation(),
    waitForExecutionQueue: async () => undefined,
    toggleTerminal,
    writeToBoltTerminal,
  },
}));
vi.mock('./ripgrepClient', () => ({ searchWithRipgrep: vi.fn() }));

import { createProjectMcpBridge } from './projectMcp';
import { workbenchStore } from '~/lib/stores/workbench';

let bridge: Awaited<ReturnType<typeof createProjectMcpBridge>> | undefined;

afterEach(async () => {
  await bridge?.close();
  bridge = undefined;
  workbenchStore.projectGeneration.set(workbenchStore.projectGeneration.get() + 1);
  workbenchStore.previews.set([]);
  workbenchStore.files.set({});
});

function processWithOutput(output: string, exitCode: number | Promise<number>) {
  return {
    output: new ReadableStream<string>({
      start(controller) {
        controller.enqueue(output);
        controller.close();
      },
    }),
    exit: Promise.resolve(exitCode),
    kill: vi.fn(),
  };
}

describe('project command tools', () => {
  it('executes in the default project directory and forwards output to Bolt Terminal', async () => {
    bridge = await createProjectMcpBridge();

    const result = await bridge.callTool('project_run_command', { command: 'echo command-marker' });

    expect(toggleTerminal).toHaveBeenCalledWith(true);
    expect(writeToBoltTerminal).toHaveBeenCalledWith('\r\n$ echo command-marker\r\n[Command executed successfully]\r\n');
    expect(result.structuredContent).toMatchObject({
      status: 'exited',
      exitCode: 0,
      output: 'Command executed successfully\n',
      previewReady: false,
    });
    expect(result.isError).not.toBe(true);
  });
});

describe('project paths', () => {
  it('lists the project root and accepts absolute paths inside the project', async () => {
    workbenchStore.files.set({
      '/home/project/src/App.tsx': { type: 'file', content: 'page', isBinary: false },
      '/home/project/package.json': { type: 'file', content: '{}', isBinary: false },
    });
    bridge = await createProjectMcpBridge();

    for (const prefix of ['', '.', '/home/project', '/home/project/']) {
      const result = await bridge.callTool('project_list_paths', { path: prefix });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ entries: [{ path: 'src/App.tsx' }, { path: 'package.json' }] });
    }

    const listing = await bridge.callTool('project_list_paths', { path: '/home/project/src' });
    expect(listing.structuredContent).toMatchObject({ entries: [{ path: 'src/App.tsx' }] });

    const read = await bridge.callTool('project_read_file', { path: '/home/project/src/App.tsx' });
    expect(read.isError).not.toBe(true);
    expect(read.structuredContent).toMatchObject({ path: 'src/App.tsx', content: 'page' });
  });

  it('rejects traversal, sibling roots, and deleting the project root', async () => {
    bridge = await createProjectMcpBridge();

    for (const outside of ['../private', '/home/project/../private', '/home/project-other/src', '/etc/passwd']) {
      const result = await bridge.callTool('project_list_paths', { path: outside });
      expect(result.isError).toBe(true);
    }

    for (const root of ['.', '/home/project']) {
      const result = await bridge.callTool('project_delete_path', { path: root, recursive: true });
      expect(result.isError).toBe(true);
    }
  });
});

describe('targeted project file edits', () => {
  const original = 'const styles = {\nbutton: blue\n};\n';

  const prepare = async () => {
    workbenchStore.files.set({ '/home/project/src/App.tsx': { type: 'file', content: original, isBinary: false } });
    saveFileContent.mockClear();
    createFile.mockClear();
    bridge = await createProjectMcpBridge();
  };

  it('rejects unnecessary full replacements of existing files without a reason', async () => {
    await prepare();

    const result = await bridge!.callTool('project_write_file', { path: 'src/App.tsx', content: 'rewritten app' });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('project_patch_file') }]);
    expect(saveFileContent).not.toHaveBeenCalled();
  });

  it('patches only the exact target and preserves surrounding content', async () => {
    await prepare();

    const result = await bridge!.callTool('project_patch_file', {
      path: 'src/App.tsx',
      expectedContent: original,
      oldText: 'button: blue',
      newText: 'button: green',
    });
    expect(result.structuredContent).toMatchObject({ patched: true, changed: true });
    expect(saveFileContent).toHaveBeenCalledExactlyOnceWith(
      '/home/project/src/App.tsx',
      'const styles = {\nbutton: green\n};\n',
    );
    expect(createFile).not.toHaveBeenCalled();
  });

  it('refuses stale or ambiguous patches', async () => {
    await prepare();

    const stale = await bridge!.callTool('project_patch_file', {
      path: 'src/App.tsx',
      expectedContent: 'stale',
      oldText: 'button: blue',
      newText: 'button: green',
    });
    expect(stale.isError).toBe(true);

    const ambiguous = await bridge!.callTool('project_patch_file', {
      path: 'src/App.tsx',
      expectedContent: original,
      oldText: 'styles',
      newText: 'other',
    });
    expect(ambiguous.isError).not.toBe(true);
    expect(saveFileContent).toHaveBeenCalled();
  });

  it('permits justified full replacements and reports no-op writes accurately', async () => {
    await prepare();

    const unchanged = await bridge!.callTool('project_write_file', { path: 'src/App.tsx', content: original });
    expect(unchanged.structuredContent).toMatchObject({ changed: false });
    expect(saveFileContent).not.toHaveBeenCalled();

    const replaced = await bridge!.callTool('project_write_file', {
      path: 'src/App.tsx',
      content: 'export const layout = "new";\n',
      replacementReason: 'The user requested replacing this entire starter page.',
    });
    expect(replaced.structuredContent).toMatchObject({ written: true, created: false, changed: true });
    expect(saveFileContent).toHaveBeenCalledExactlyOnceWith(
      '/home/project/src/App.tsx',
      'export const layout = "new";\n',
    );
  });

  it('patches with a read revision without reproducing the entire expected file', async () => {
    await prepare();

    const read = await bridge!.callTool('project_read_file', { path: 'src/App.tsx' });
    const revision = (read.structuredContent as { revision: string }).revision;
    expect(revision).toMatch(/^[a-f0-9]{64}$/);

    const result = await bridge!.callTool('project_patch_file', {
      path: 'src/App.tsx',
      expectedRevision: revision,
      oldText: 'button: blue',
      newText: 'button: green',
    });
    expect(result.isError).not.toBe(true);
    expect(saveFileContent).toHaveBeenCalledExactlyOnceWith(
      '/home/project/src/App.tsx',
      'const styles = {\nbutton: green\n};\n',
    );
  });

  it('uses the latest read revision when a patch omits expectedRevision', async () => {
    await prepare();

    await bridge!.callTool('project_read_file', { path: 'src/App.tsx' });

    const result = await bridge!.callTool('project_patch_file', {
      path: 'src/App.tsx',
      oldText: 'button: blue',
      newText: 'button: green',
    });

    expect(result.isError).not.toBe(true);
    expect(saveFileContent).toHaveBeenCalledExactlyOnceWith(
      '/home/project/src/App.tsx',
      'const styles = {\nbutton: green\n};\n',
    );
  });

  it('rejects a stale revision and a patch without any concurrency check', async () => {
    await prepare();

    const read = await bridge!.callTool('project_read_file', { path: 'src/App.tsx' });
    workbenchStore.files.set({ '/home/project/src/App.tsx': { type: 'file', content: `${original}// user edit\n`, isBinary: false } });

    const stale = await bridge!.callTool('project_patch_file', {
      path: 'src/App.tsx',
      expectedRevision: (read.structuredContent as { revision: string }).revision,
      oldText: 'button: blue',
      newText: 'button: green',
    });
    expect(stale.isError).toBe(true);
    expect(stale.content).toEqual([{ type: 'text', text: expect.stringContaining('Read the file again') }]);
  });

  it('rejects invalid patches and flattened source replacements before saving', async () => {
    await prepare();

    const patch = await bridge!.callTool('project_patch_file', {
      path: 'src/App.tsx',
      expectedContent: original,
      oldText: 'button: blue',
      newText: 'button: <',
    });
    const replacement = await bridge!.callTool('project_write_file', {
      path: 'src/App.tsx',
      replacementReason: 'Replace the starter with the requested page.',
      content:
        "import { ArrowRight } from 'lucide-react' function App() { return <main>Hello</main>; } export default App;",
    });

    for (const result of [patch, replacement]) {
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('File was not saved') }]);
    }
    expect(saveFileContent).not.toHaveBeenCalled();
    expect(workbenchStore.files.get()['/home/project/src/App.tsx']).toMatchObject({ content: original });
  });

  it('rejects malformed new source files before creating them', async () => {
    await prepare();

    const result = await bridge!.callTool('project_write_file', {
      path: 'src/Broken.tsx',
      content: 'export const Broken = () => <main>',
      overwrite: false,
    });
    expect(result.isError).toBe(true);
    expect(createFile).not.toHaveBeenCalled();
    expect(saveFileContent).not.toHaveBeenCalled();
  });
});
